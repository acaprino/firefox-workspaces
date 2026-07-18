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
};

class WSPStorageManager {
  static SCHEMA_VERSION = 2;

  static async ensureSchemaVersion() {
    const key = STORAGE_KEYS.schemaVersion;
    const result = await browser.storage.local.get(key);
    const current = result[key] || 1;
    if (current < WSPStorageManager.SCHEMA_VERSION) {
      // Future migrations go here (e.g., if current === 1 then migrate v1 -> v2)
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
    const key = STORAGE_KEYS.windowWsps(windowId);
    const results = await browser.storage.local.get(key);
    return (results[key] || []).length;
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

  // ── Session-loss export fingerprint (idempotency for the automatic export) ──

  static async getSessionLossExportFingerprint() {
    const key = STORAGE_KEYS.sessionLossExport;
    const result = await browser.storage.local.get(key);
    return result[key] || null;
  }

  static async setSessionLossExportFingerprint(fingerprint) {
    await browser.storage.local.set({ [STORAGE_KEYS.sessionLossExport]: fingerprint });
  }

  // ── Closed Tabs (Tier 2) ──

  static async saveClosedTab(wspId, tabInfo) {
    return _storageMutex.run(`closed-${wspId}`, async () => {
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

  static async clearClosedTabs(wspId) {
    const key = STORAGE_KEYS.closedTabs(wspId);
    await browser.storage.local.remove(key);
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
  // each other's changes when they interleave at await points.
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
    const out = { _generatedAt: new Date().toISOString(), _schemaVersion: WSPStorageManager.SCHEMA_VERSION };
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

  static async saveWorkspaceOrder(windowId, orderedIds) {
    const key = STORAGE_KEYS.wspOrder(windowId);
    await browser.storage.local.set({[key]: orderedIds});
  }
}
