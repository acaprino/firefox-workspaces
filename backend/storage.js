// Simple async mutex to serialize read-modify-write operations per key
class AsyncMutex {
  constructor() {
    this._locks = new Map();
  }

  async acquire(key) {
    while (this._locks.has(key)) {
      await this._locks.get(key);
    }
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    this._locks.set(key, promise);
    return release;
  }

  release(key, releaseFn) {
    this._locks.delete(key);
    releaseFn();
  }

  async run(key, fn) {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      this.release(key, release);
    }
  }
}

const _storageMutex = new AsyncMutex();

// Shared UUID regex - used by restore, tab assignment, and session-value validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STORAGE_KEYS = {
  wspState: (id) => `ld-wsp-${id}`,
  windowWsps: (id) => `ld-wsp-window-${id}`,
  wspOrder: (id) => `ld-wsp-order-${id}`,
  closedTabs: (id) => `ld-wsp-closed-${id}`,
  primaryWindow: 'primary-window-id',
  primaryWindowLast: 'primary-window-last-id',
  schemaVersion: 'ld-wsp-schema-version',
  // Surface-only error state. Set by _restoreWorkspaces when the refuse-to-wipe
  // guard trips so the popup can show an explanatory banner. Cleared on
  // successful activate/restore.
  lastRestoreError: 'ld-wsp-last-restore-error',
  // Fingerprint of the last successful session-loss snapshot export. Makes the
  // automatic bookmark export idempotent across restarts: for a user whose
  // session store is wiped on every start ("clear history on close"), the same
  // loss would otherwise be re-detected and re-exported into new bookmark
  // folders on every launch.
  sessionLossExport: 'ld-wsp-session-loss-export',
  // Workspaces whose destroy started (records dropped) but whose tabs were
  // not closed yet. A background that dies in between leaves hidden tabs
  // tagged with a workspace that no longer exists; init closes those instead
  // of adopting them into the active workspace (Brainer._isDestroyLeftover).
  pendingDestroys: 'ld-wsp-pending-destroys',
};

const LIMITS = {
  MAX_CLOSED_TABS: 25,
  MENU_DEBOUNCE_MS: 50,
  RESTORE_DELAY_MS: 500,
  RESTORE_WINDOW_DELAY_MS: 600,
  FORCE_REOPEN_SAFETY_VALVE: 50,
  // Session-loss detection thresholds (Brainer._isSessionLost). Below
  // MIN_SNAPSHOT_URLS there is too little evidence to distinguish a lost
  // session from a fresh profile; a session counts as lost only when fewer
  // than SURVIVAL_RATIO of the recorded snapshot URLs are found among the
  // live tabs.
  SESSION_LOSS_MIN_SNAPSHOT_URLS: 2,
  SESSION_LOSS_SURVIVAL_RATIO: 0.5,
  // How many distinct export-set fingerprints to remember for dedup.
  MAX_EXPORT_FINGERPRINTS: 8,
  // Destroy tombstones kept (see STORAGE_KEYS.pendingDestroys).
  MAX_PENDING_DESTROYS: 20,
  // Automatic retries of a failed Brainer.initialize() pass, one delay per
  // retry. Past the last one, Dismiss on the banner retries.
  INIT_RETRY_DELAYS_MS: [1000, 10000],
};

class WSPStorageManager {
  // Schema versioning contract:
  //  - Bump SCHEMA_VERSION only for a change that old readers cannot absorb
  //    through the Workspace constructor defaults (a renamed, repurposed or
  //    re-typed field). Adding a field with a safe default needs no bump.
  //  - A bump to N adds `_MIGRATIONS[N]`: an idempotent async function that
  //    rewrites v(N-1) data to vN (a crash mid-way re-runs it on next start).
  //  - Downgrades (AMO rollback, an older unlisted build) cannot be migrated
  //    back: the older build keeps running on the newer data, never stamps
  //    the stored version down, warns in the console and flags the mismatch
  //    in the diagnostics dump (`_storedSchemaVersion`, `_schemaDowngrade`).
  static SCHEMA_VERSION = 2;
  static _MIGRATIONS = {
    // 2: none -- v1 -> v2 shipped without a data rewrite.
  };
  // Version found in storage at startup, before any migration (diagnostics).
  static _storedSchemaVersion = null;

  static async ensureSchemaVersion() {
    const key = STORAGE_KEYS.schemaVersion;
    const result = await browser.storage.local.get(key);
    const current = result[key] || 1;
    WSPStorageManager._storedSchemaVersion = current;
    if (current > WSPStorageManager.SCHEMA_VERSION) {
      console.warn("[WSPStorageManager][ensureSchemaVersion] stored schema", current,
        "is newer than this build's", WSPStorageManager.SCHEMA_VERSION,
        "-- downgraded extension; running on newer data without migrating");
      return;
    }
    if (current < WSPStorageManager.SCHEMA_VERSION) {
      for (let v = current + 1; v <= WSPStorageManager.SCHEMA_VERSION; v++) {
        const migrate = WSPStorageManager._MIGRATIONS[v];
        if (migrate) await migrate();
      }
      await browser.storage.local.set({ [key]: WSPStorageManager.SCHEMA_VERSION });
    }
  }

  static async getWspState(wspId) {
    const key = STORAGE_KEYS.wspState(wspId);
    const results = await browser.storage.local.get(key);
    return results[key] || {};
  }

  static async saveWspState(wspId, state) {
    const key = STORAGE_KEYS.wspState(wspId);
    await browser.storage.local.set({ [key]: state });
  }

  static async deleteWspState(wspId) {
    const key = STORAGE_KEYS.wspState(wspId);
    await browser.storage.local.remove(key);
  }

  static async getWorkspaces(windowId) {
    const key = STORAGE_KEYS.windowWsps(windowId);
    const results = await browser.storage.local.get(key);
    const wspIds = results[key] || [];

    // Batch-read all workspace states in one call
    const keys = wspIds.map(id => STORAGE_KEYS.wspState(id));
    const allStates = keys.length > 0 ? await browser.storage.local.get(keys) : {};

    return wspIds.map(wspId => {
      const state = allStates[STORAGE_KEYS.wspState(wspId)] || {};
      return new Workspace(wspId, state);
    });
  }

  static async getWorkspace(wspId) {
    const state = await WSPStorageManager.getWspState(wspId);
    return new Workspace(wspId, state);
  }

  static async getNumWorkspaces(windowId) {
    return (await WSPStorageManager.getWorkspaceIds(windowId)).length;
  }

  // The window's workspace id list alone (no per-workspace record reads).
  static async getWorkspaceIds(windowId) {
    const key = STORAGE_KEYS.windowWsps(windowId);
    const results = await browser.storage.local.get(key);
    return results[key] || [];
  }

  // Locked read-modify-write of ONE existing workspace record: the single
  // sanctioned way to change a record after creation. Takes the workspace
  // lock, re-reads the record, bails when it no longer exists, runs
  // `fn(fresh)` and saves the whole fresh record. Writers that saved a copy
  // read before an await (or skipped the existence check) used to revert
  // concurrent updates and resurrect destroyed workspaces as zombie
  // `ld-wsp-{id}` records.
  //  - Existence: getWorkspace returns a stub for a missing key, so windowId
  //    is the only existence marker.
  //  - `fn` may be async; returning `false` skips the save (no-op change).
  //  - Resolves to the fresh Workspace (saved or not), or null if missing.
  //  - NOT re-entrant (see AsyncMutex): `fn` must never mutate, lock or
  //    destroy the same wspId again, directly or through a service call.
  static async mutateWorkspace(wspId, fn) {
    return WSPStorageManager.withWorkspaceLock(wspId, async () => {
      const fresh = await WSPStorageManager.getWorkspace(wspId);
      if (fresh.windowId == null) {
        console.log("[WSPStorageManager][mutateWorkspace] wspId:", wspId, "no longer exists -- skipped");
        return null;
      }
      if (await fn(fresh) === false) return fresh;
      await fresh._saveState();
      return fresh;
    });
  }

  static async addWsp(wspId, windowId) {
    return _storageMutex.run(`window-${windowId}`, async () => {
      const key = STORAGE_KEYS.windowWsps(windowId);
      const results = await browser.storage.local.get(key);
      const wspIds = results[key] || [];
      if (!wspIds.includes(wspId)) {
        wspIds.push(wspId);
        await browser.storage.local.set({ [key]: wspIds });
      }
    });
  }

  static async removeWsp(wspId, windowId) {
    return _storageMutex.run(`window-${windowId}`, async () => {
      const key = STORAGE_KEYS.windowWsps(windowId);
      const results = await browser.storage.local.get(key);
      const wspIds = results[key] || [];

      const idx = wspIds.indexOf(wspId);
      if (idx >= 0) {
        wspIds.splice(idx, 1);
      }

      await browser.storage.local.set({ [key]: wspIds });
    });
  }

  // Detach metadata for a window WITHOUT deleting the per-workspace state or
  // closed-tab entries. Used by the restart-restore path: workspace IDs are
  // reused under a new windowId, so the shared `ld-wsp-{wspId}` and
  // `ld-wsp-closed-{wspId}` keys must survive. Only the window-keyed indexes
  // (window list + order) are window-specific and can be safely removed.
  // (A `destroyWindow` variant that DID wipe `ld-wsp-{wspId}` used to live
  // here. It was the root cause of the original tab-loss incident and was
  // removed once the restore path no longer needed it.)
  static async detachWindow(windowId) {
    await browser.storage.local.remove([
      STORAGE_KEYS.windowWsps(windowId),
      STORAGE_KEYS.wspOrder(windowId),
    ]);
  }

  static async getPrimaryWindowId() {
    const key = STORAGE_KEYS.primaryWindow;
    const result = await browser.storage.local.get(key);
    return result[key];
  }

  static async setPrimaryWindowId(windowId) {
    const key = STORAGE_KEYS.primaryWindow;
    await browser.storage.local.set({[key]: windowId});
  }

  static async removePrimaryWindowId() {
    await browser.storage.local.remove(STORAGE_KEYS.primaryWindow);
  }

  static async getPrimaryWindowLastId() {
    const key = STORAGE_KEYS.primaryWindowLast;
    const result = await browser.storage.local.get(key);
    return result[key];
  }

  static async setPrimaryWindowLastId(windowId) {
    const key = STORAGE_KEYS.primaryWindowLast;
    await browser.storage.local.set({[key]: windowId});
  }

  static async removePrimaryWindowLastId() {
    await browser.storage.local.remove(STORAGE_KEYS.primaryWindowLast);
  }

  // ── Last restore error (surfaced to the popup as a banner) ──

  static async getLastRestoreError() {
    const key = STORAGE_KEYS.lastRestoreError;
    const result = await browser.storage.local.get(key);
    return result[key] || null;
  }

  static async setLastRestoreError(payload) {
    const key = STORAGE_KEYS.lastRestoreError;
    await browser.storage.local.set({ [key]: payload });
    // Layering exception: UIService caches this key's presence for the "!"
    // toolbar badge (hot path). Invalidating here, at the single write point,
    // beats sprinkling resets across every call site. UIService is defined by
    // the time any of this runs (all background scripts load before init).
    // Every writer of this key MUST go through set/clearLastRestoreError or
    // the badge cache silently desyncs.
    if (typeof UIService !== "undefined") UIService.invalidateWarnBadgeCache();
  }

  static async clearLastRestoreError() {
    await browser.storage.local.remove(STORAGE_KEYS.lastRestoreError);
    if (typeof UIService !== "undefined") UIService.invalidateWarnBadgeCache();
  }

  // ── Session-loss export fingerprints (idempotency for automatic exports) ──
  // Bounded list, not a single slot: the session-loss export and the orphan
  // sweep (C-19) export different workspace sets; one slot would let each
  // caller evict the other's record and re-export forever.

  static async getSessionLossExportFingerprints() {
    const key = STORAGE_KEYS.sessionLossExport;
    const result = await browser.storage.local.get(key);
    const value = result[key];
    if (typeof value === "string") return [value]; // pre-list dev format
    return Array.isArray(value) ? value : [];
  }

  // Locked read-modify-write: two exporters finishing together used to drop
  // one fingerprint, so the next start exported that content again.
  static async addSessionLossExportFingerprint(fingerprint) {
    return _storageMutex.run("export-fingerprints", async () => {
      const list = await WSPStorageManager.getSessionLossExportFingerprints();
      if (!list.includes(fingerprint)) list.push(fingerprint);
      while (list.length > LIMITS.MAX_EXPORT_FINGERPRINTS) list.shift();
      await browser.storage.local.set({ [STORAGE_KEYS.sessionLossExport]: list });
    });
  }

  // Serializes whole automatic exports (fingerprint check -> bookmark export
  // -> fingerprint record) so two exporters of the same content cannot both
  // pass the check and create duplicate folders. Distinct key from the
  // list's own lock above, which runs nested inside this one.
  static async withSessionLossExportLock(fn) {
    return _storageMutex.run("session-loss-export", fn);
  }

  // ── Destroy tombstones (resumable destroy, X-96) ──
  // Bounded FIFO of workspace ids. An id stays only while its destroy is
  // between dropping the records and closing the tabs, or forever (bounded)
  // when the background died there: workspace ids are never reused.

  static async getPendingDestroys() {
    const key = STORAGE_KEYS.pendingDestroys;
    const result = await browser.storage.local.get(key);
    return Array.isArray(result[key]) ? result[key] : [];
  }

  static async addPendingDestroy(wspId) {
    return _storageMutex.run("pending-destroys", async () => {
      const list = await WSPStorageManager.getPendingDestroys();
      if (!list.includes(wspId)) list.push(wspId);
      while (list.length > LIMITS.MAX_PENDING_DESTROYS) list.shift();
      await browser.storage.local.set({ [STORAGE_KEYS.pendingDestroys]: list });
    });
  }

  static async removePendingDestroy(wspId) {
    return _storageMutex.run("pending-destroys", async () => {
      const list = await WSPStorageManager.getPendingDestroys();
      if (!list.includes(wspId)) return;
      const rest = list.filter(id => id !== wspId);
      if (rest.length > 0) await browser.storage.local.set({ [STORAGE_KEYS.pendingDestroys]: rest });
      else await browser.storage.local.remove(STORAGE_KEYS.pendingDestroys);
    });
  }

  // ── Closed Tabs (Tier 2) ──

  static async saveClosedTab(wspId, tabInfo) {
    return _storageMutex.run(`closed-${wspId}`, async () => {
      // The owner was resolved before this lock; a destroy since then already
      // cleared this list, and writing now would leave an orphan key behind.
      if ((await WSPStorageManager.getWspState(wspId)).windowId == null) {
        console.log("[WSPStorageManager][saveClosedTab] workspace", wspId, "no longer exists -- skipped");
        return;
      }
      const key = STORAGE_KEYS.closedTabs(wspId);
      const results = await browser.storage.local.get(key);
      const closedTabs = results[key] || [];
      closedTabs.unshift(tabInfo);
      if (closedTabs.length > LIMITS.MAX_CLOSED_TABS) closedTabs.length = LIMITS.MAX_CLOSED_TABS;
      await browser.storage.local.set({[key]: closedTabs});
    });
  }

  static async getClosedTabs(wspId) {
    const key = STORAGE_KEYS.closedTabs(wspId);
    const results = await browser.storage.local.get(key);
    return results[key] || [];
  }

  // Same mutex as saveClosedTab: a save that had already read the list would
  // otherwise write the cleared entries back.
  static async clearClosedTabs(wspId) {
    return _storageMutex.run(`closed-${wspId}`, async () => {
      await browser.storage.local.remove(STORAGE_KEYS.closedTabs(wspId));
    });
  }

  // Remove a closed-tab entry by identity (url + closedAt) instead of by
  // index: the array mutates while the popup is open (new closures unshift),
  // so a render-time index can point at the wrong entry. Runs under the same
  // per-workspace mutex as saveClosedTab so a concurrent save cannot be lost
  // to this read-modify-write.
  static async removeClosedTab(wspId, { url, closedAt } = {}) {
    return _storageMutex.run(`closed-${wspId}`, async () => {
      const key = STORAGE_KEYS.closedTabs(wspId);
      const results = await browser.storage.local.get(key);
      const closedTabs = results[key] || [];
      const index = closedTabs.findIndex(t => t.url === url && t.closedAt === closedAt);
      if (index >= 0) {
        closedTabs.splice(index, 1);
        await browser.storage.local.set({[key]: closedTabs});
      }
    });
  }

  // Per-workspace mutex for read-modify-write cycles.
  // Prevents addTabToWorkspace and removeTabFromWorkspace from overwriting
  // each other's changes when they interleave at await points. Record
  // changes go through mutateWorkspace; take this lock directly only for
  // whole-record lifecycle steps (create, destroy).
  static async withWorkspaceLock(wspId, fn) {
    return _storageMutex.run(`wsp-${wspId}`, fn);
  }

  // Per-window mutex serializing whole destroy operations. The
  // "cannot destroy the last workspace" invariant is cross-entity: two
  // concurrent destroys of DIFFERENT workspaces do not meet on any
  // per-workspace lock, so without this both can pass the count check and
  // leave the window with zero workspaces. Distinct key from the
  // `window-${id}` mutex used by addWsp/removeWsp, which destroy acquires
  // nested inside this one (the AsyncMutex is not re-entrant).
  static async withDestroyLock(windowId, fn) {
    return _storageMutex.run(`destroy-window-${windowId}`, fn);
  }

  // Per-window mutex for read-modify-write of the workspace order array
  // (createWorkspace appends, destroyWsp splices; interleaving can drop an id).
  static async withOrderLock(windowId, fn) {
    return _storageMutex.run(`order-${windowId}`, fn);
  }

  // ── Diagnostic dump (Tier 4 -- incident response) ──

  // Return every ld-wsp-* key plus primary window IDs and schema version.
  // Used by the popup's "Copy diagnostic dump" action when investigating loss.
  static async getDiagnostics() {
    const all = await browser.storage.local.get(null);
    const out = {
      _generatedAt: new Date().toISOString(),
      _schemaVersion: WSPStorageManager.SCHEMA_VERSION,
      // What storage held at startup; above _schemaVersion means this build
      // was downgraded and runs on data written by a newer schema.
      _storedSchemaVersion: WSPStorageManager._storedSchemaVersion,
    };
    if (WSPStorageManager._storedSchemaVersion > WSPStorageManager.SCHEMA_VERSION) {
      out._schemaDowngrade = true;
    }
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith("ld-wsp-") || k === STORAGE_KEYS.primaryWindow ||
          k === STORAGE_KEYS.primaryWindowLast || k === STORAGE_KEYS.schemaVersion) {
        out[k] = v;
      }
    }
    return out;
  }

  // ── Workspace Order (Tier 3) ──

  static async getWorkspaceOrder(windowId) {
    const key = STORAGE_KEYS.wspOrder(windowId);
    const results = await browser.storage.local.get(key);
    return results[key] ?? null;
  }

  // Raw setter: callers hold withOrderLock(windowId) around their
  // read-modify-write (WorkspaceService.saveWorkspaceOrder for user reorders).
  static async saveWorkspaceOrder(windowId, orderedIds) {
    const key = STORAGE_KEYS.wspOrder(windowId);
    await browser.storage.local.set({[key]: orderedIds});
  }
}
