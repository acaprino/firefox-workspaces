// Workspace CRUD, activate, deactivate, containers
// NOTE: WorkspaceService and TabService have a bidirectional dependency.
// WorkspaceService calls TabService for session tagging (setTabSessionValue,
// addTabToWorkspace). TabService calls WorkspaceService for workspace CRUD
// (destroyWsp, activateWsp, hideInactiveWspTabs, getActiveWsp, _buildDefaultWspData,
// createWorkspace, getOrderedWorkspaces). Both are singletons in the same MV2 scope.
class WorkspaceService {
  static _activationChain = Promise.resolve();
  static _activationInProgress = false;
  // Bumped when a chain step starts (see _onActivationChain). A cache fill
  // from a storage read taken outside the chain is only safe when no step
  // started since the read (primeActiveCache).
  static _activationSeq = 0;
  // Latest activation requested and not finished yet: { windowId, wspId }.
  // Keyboard cycling steps from it: storage still names the workspace being
  // left while an activation runs, so a second quick press repeated the
  // first one (X-37).
  static _pendingActivation = null;
  // In-memory cache of the active workspace's tab IDs for fast onTabActivated lookups.
  // Avoids a storage read on every tab click in the common case (tab already in active workspace).
  // Invalidated by activateWsp (replaced) and tab add/remove ops (updated or cleared).
  static _activeCache = null; // { windowId: number, activeWspId: string|null, tabIds: Set<number>, containerId: string|null } | null

  static isActivating() {
    return this._activationInProgress;
  }

  static activationSeq() {
    return WorkspaceService._activationSeq;
  }

  // Target of the latest activation requested for this window that has not
  // finished yet, or null.
  static pendingActivation(windowId) {
    const p = WorkspaceService._pendingActivation;
    return p && p.windowId === windowId ? p.wspId : null;
  }

  // Run `fn` as one step of the activation chain: after every activation,
  // create or bookmark restore queued before it, with isActivating() true
  // while it runs (tab events wait for it). Everything that changes which
  // workspace is active goes through here: createWorkspace used to switch
  // outside it, and an activation in flight then left two workspaces
  // active (X-36). `fn` must never await activateWsp, createWorkspace,
  // whenActivationsSettled or destroyWsp: the chain would wait on itself.
  static _onActivationChain(fn) {
    const step = WorkspaceService._activationChain
      .catch(() => {})
      .then(async () => {
        WorkspaceService._activationSeq++;
        WorkspaceService._activationInProgress = true;
        try {
          return await fn();
        } finally {
          WorkspaceService._activationInProgress = false;
        }
      });
    WorkspaceService._activationChain = step;
    return step;
  }

  // Resolves once no activation is running or queued. Tab events that
  // arrive mid-activation wait here and then run, instead of being dropped
  // (a tab opened right after a switch used to stay unfiled, untagged and
  // outside the workspace's container). Loops until the chain tail it
  // awaited is still the tail, so activations queued meanwhile are covered.
  // NEVER await this from inside an activation: the chain would wait on
  // itself.
  static async whenActivationsSettled() {
    let tail;
    do {
      tail = WorkspaceService._activationChain;
      await tail.catch(() => {});
    } while (tail !== WorkspaceService._activationChain);
  }

  // Active-workspace handoffs: createWorkspace stands the current workspace
  // down before the new record exists, and destroying the active workspace
  // pre-deactivates it before the replacement activation. For those awaits
  // the window has no active workspace, and addTabToWorkspace's no-active
  // fallback used to file a tab opened meanwhile into (and activate)
  // workspaces[0] -- possibly the workspace being destroyed, which then
  // closed the tab. The fallback waits for the handoff instead.
  static _handoffs = new Map(); // windowId -> Set<Promise>
  // Workspaces whose destroy is in progress: never a fallback target.
  static _pendingDestroys = new Set();

  static async _withHandoff(windowId, fn) {
    let pending = WorkspaceService._handoffs.get(windowId);
    if (!pending) WorkspaceService._handoffs.set(windowId, pending = new Set());
    const run = (async () => fn())();
    const tracked = run.catch(() => {});
    pending.add(tracked);
    try {
      return await run;
    } finally {
      pending.delete(tracked);
      if (pending.size === 0 && WorkspaceService._handoffs.get(windowId) === pending) {
        WorkspaceService._handoffs.delete(windowId);
      }
    }
  }

  static async whenHandoffsSettled(windowId) {
    let pending;
    while ((pending = WorkspaceService._handoffs.get(windowId)) && pending.size > 0) {
      await Promise.all([...pending]);
    }
  }

  // Returns true/false if the tab's membership is known, or null if cache is cold/mismatched window.
  static isTabInActiveWsp(windowId, tabId) {
    const c = WorkspaceService._activeCache;
    if (!c || c.windowId !== windowId) return null;
    return c.tabIds.has(tabId);
  }

  // Accessors for cross-service cache maintenance (TabService, Brainer).
  // Keep the _activeCache shape private to this class -- callers used to
  // reach into `_activeCache?.tabIds` directly, which made the cache
  // invariants unenforceable.
  // `wspId` is the workspace the tab was actually filed under. A tab is only
  // cached when that workspace is the one the cache describes: adding it blind
  // used to let a stale cache (one that still named the previously active
  // workspace) claim tabs belonging to another workspace, after which
  // TabService.forceTabIntoActiveContainer reopened them in the stale entry's
  // container. A mismatch means the cache is out of date, so drop it rather
  // than corrupt it -- the next read repopulates from storage.
  static addTabToActiveCache(tabId, wspId) {
    const c = WorkspaceService._activeCache;
    if (!c) return;
    if (!wspId || c.activeWspId !== wspId) {
      console.warn("[WorkspaceService][addTabToActiveCache] cache describes",
        c.activeWspId, "but tab", tabId, "belongs to", wspId ?? "(unknown)",
        "-- invalidating stale cache");
      WorkspaceService._activeCache = null;
      return;
    }
    c.tabIds.add(tabId);
  }

  static removeTabFromActiveCache(tabId) {
    WorkspaceService._activeCache?.tabIds.delete(tabId);
  }

  // Fill the cache from a storage read taken outside the activation chain
  // (onTabActivated's slow path). Nothing else filled a cold cache, and
  // until the first switch navigation-time container enforcement and the
  // URL snapshot refresh stayed off (X-10). `seq` is activationSeq() from
  // before that read: if a chain step started since, the read may name the
  // workspace it replaced (gotcha 9), so the fill is skipped.
  static primeActiveCache(windowId, wsp, seq) {
    if (seq !== WorkspaceService._activationSeq || WorkspaceService._activationInProgress) return;
    if (!wsp?.active || WorkspaceService._pendingDestroys.has(wsp.id)) return;
    const c = WorkspaceService._activeCache;
    if (c && c.windowId === windowId && c.activeWspId === wsp.id
        && c.tabIds.size === wsp.tabs.length && wsp.tabs.every(id => c.tabIds.has(id))) return;
    WorkspaceService._updateActiveCache(windowId, wsp.tabs, wsp.id, wsp.containerId);
  }

  // Debounced persist of last active tab so shutdown/restart restores it.
  // Stores pending args so flushLastActiveTab() can execute on shutdown.
  static _lastActiveTimer = null;
  static _lastActivePending = null; // { windowId, tabId, url }

  static updateLastActiveTab(windowId, tabId) {
    clearTimeout(WorkspaceService._lastActiveTimer);
    WorkspaceService._lastActivePending = { windowId, tabId, url: null };
    // Eagerly read tab URL so flush doesn't need a live tab (tabs are
    // already destroyed when onWindowRemoved fires).
    browser.tabs.get(tabId).then(tab => {
      const p = WorkspaceService._lastActivePending;
      if (p && p.windowId === windowId && p.tabId === tabId) {
        p.url = tab.url || null;
      }
    }).catch(() => {});
    WorkspaceService._lastActiveTimer = setTimeout(() => {
      WorkspaceService._flushLastActiveTabImpl();
    }, 500);
  }

  static async _flushLastActiveTabImpl() {
    const pending = WorkspaceService._lastActivePending;
    WorkspaceService._lastActivePending = null;
    clearTimeout(WorkspaceService._lastActiveTimer);
    WorkspaceService._lastActiveTimer = null;
    if (!pending) return;
    try {
      // Hot path (every settled tab click): the single-key read when the
      // active cache is warm, instead of reading every record in the window.
      const activeWsp = await WorkspaceService.getActiveWspFast(pending.windowId);
      if (!activeWsp || !activeWsp.tabs.includes(pending.tabId)) return;
      // Re-read under the workspace lock and write only the lastActiveTab
      // fields: this debounced save used to rewrite the whole record from a
      // pre-await snapshot, silently dropping tabs[] changes a concurrent
      // locked add/remove had landed in between.
      await WSPStorageManager.mutateWorkspace(activeWsp.id, (fresh) => {
        if (!fresh.tabs.includes(pending.tabId)) return false;
        // A URL not read yet keeps the one already recorded for this tab
        const url = pending.url
          ?? (fresh.lastActiveTabId === pending.tabId ? fresh.lastActiveTabUrl : null);
        // Unchanged: skip rewriting the whole record (tabs[], snapshot, ...)
        if (fresh.lastActiveTabId === pending.tabId && fresh.lastActiveTabUrl === url) return false;
        fresh.lastActiveTabId = pending.tabId;
        fresh.lastActiveTabUrl = url;
      });
    } catch (e) {
      console.debug("[WorkspaceService][updateLastActiveTab] failed:", e.message);
    }
  }

  // Flush any pending debounced save immediately (called on shutdown).
  static async flushLastActiveTab() {
    await WorkspaceService._flushLastActiveTabImpl();
  }

  static _updateActiveCache(windowId, tabIds, activeWspId = null, containerId = null) {
    WorkspaceService._activeCache = { windowId, activeWspId, tabIds: new Set(tabIds), containerId: containerId ?? null };
    console.log("[WorkspaceService][_updateActiveCache] windowId:", windowId,
      "activeWspId:", activeWspId, "containerId:", containerId ?? null, "tabIds:", tabIds.length);
  }

  static _buildDefaultWspData(windowId, tabs = []) {
    const data = {
      id: crypto.randomUUID(),
      name: WorkspaceService.generateWspName(),
      icon: "",
      active: true,
      tabs: tabs,
      windowId: windowId,
      color: null
    };
    console.log("[WorkspaceService][_buildDefaultWspData] windowId:", windowId,
      "tabs:", tabs.length, "id:", data.id);
    return data;
  }

  static async getActiveWsp(windowId) {
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    const active = workspaces.find(wsp => wsp.active);
    console.debug("[WorkspaceService][getActiveWsp] windowId:", windowId,
      "->", active ? `${active.id} "${active.name}"` : "none");
    return active;
  }

  // Hot-path variant for per-tab-event callers (toolbar updates): when the
  // in-memory active cache knows the active workspace id, a single-key read
  // replaces the window-list + batch-read scan getActiveWsp performs. Falls
  // back to the full scan when the cache is cold, for another window, or the
  // cached id turns out stale (destroyed/rebound meanwhile).
  static async getActiveWspFast(windowId) {
    const c = WorkspaceService._activeCache;
    if (c && c.windowId === windowId && c.activeWspId) {
      const wsp = await WSPStorageManager.getWorkspace(c.activeWspId);
      if (wsp.windowId === windowId && wsp.active) return wsp;
    }
    return WorkspaceService.getActiveWsp(windowId);
  }

  // Get workspaces in user-defined order (Tier 3), falling back to name sort
  static async getOrderedWorkspaces(windowId) {
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    const order = await WSPStorageManager.getWorkspaceOrder(windowId);
    console.debug("[WorkspaceService][getOrderedWorkspaces] windowId:", windowId,
      "count:", workspaces.length, "hasOrder:", !!(order && order.length > 0));

    if (order && order.length > 0) {
      const orderMap = new Map(order.map((id, idx) => [id, idx]));
      workspaces.sort((a, b) => {
        const aIdx = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity;
        const bIdx = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity;
        if (aIdx !== bIdx) return aIdx - bIdx;
        return a.name.localeCompare(b.name);
      });
    } else {
      workspaces.sort((a, b) => a.name.localeCompare(b.name));
    }

    return workspaces;
  }

  // Runs as a step of the activation chain (X-36).
  static async createWorkspace(wsp) {
    return WorkspaceService._onActivationChain(() => WorkspaceService._createWorkspaceOnChain(wsp));
  }

  // createWorkspace's body, for callers already running on the chain.
  static async _createWorkspaceOnChain(wsp) {
    console.log("[WorkspaceService][createWorkspace] name:", wsp.name,
      "windowId:", wsp.windowId, "tabs:", wsp.tabs?.length ?? 0,
      "containerId:", wsp.containerId || null, "color:", wsp.color || null);
    // Handoff: between the deactivation and the new record no workspace is
    // active in this window (see _withHandoff).
    const w = await WorkspaceService._withHandoff(wsp.windowId, async () => {
      // Only a workspace created active takes the window over. Standing the
      // current one down for an inactive one left no workspace active.
      if (wsp.active) await WorkspaceService.deactivateCurrentWsp(wsp.windowId);

      const created = await Workspace.create(wsp.id, wsp);
      // Propagate generated UUID back so callers (createWorkspaceWithTab, order,
      // hideInactiveWspTabs) use the real ID instead of undefined.
      wsp.id = created.id;

      // Re-point the active cache: deactivateCurrentWsp above stood the previous
      // workspace down, so leaving its entry in place makes the cache lie about
      // which workspace (and container) is active. That stale containerId made
      // TabService.forceTabIntoActiveContainer reopen the new workspace's tabs in
      // the PREVIOUS workspace's container on first navigation, and file them
      // under the previous workspace. An inactive workspace changes nothing
      // on screen, so the cache stays.
      if (created.active) {
        WorkspaceService._updateActiveCache(wsp.windowId, created.tabs, created.id, created.containerId);
      }
      return created;
    });
    await w.updateTabGroups();

    // Append to workspace order (own mutex: a concurrent destroy splices the
    // same array; an interleaved read-modify-write can drop an id)
    await WSPStorageManager.withOrderLock(wsp.windowId, async () => {
      const order = await WSPStorageManager.getWorkspaceOrder(wsp.windowId);
      if (order) {
        order.push(wsp.id);
        await WSPStorageManager.saveWorkspaceOrder(wsp.windowId, order);
        console.log("[WorkspaceService][createWorkspace] appended to order, new order length:", order.length);
      } else {
        console.log("[WorkspaceService][createWorkspace] no existing order — skipping order update");
      }
    });

    await MenuService.refreshTabMenu();
    await UIService.updateToolbarButton(wsp.windowId);
    console.log("[WorkspaceService][createWorkspace] done — id:", wsp.id, "name:", wsp.name);
  }

  // Create workspace and its initial tab in one operation (called from popup).
  // One step of the activation chain (X-36): an activation queued meanwhile
  // used to switch away between the create and the filing, and the new
  // workspace's first tab was filed into (and hidden with) that workspace.
  static async createWorkspaceWithTab(wsp) {
    console.log("[WorkspaceService][createWorkspaceWithTab] name:", wsp.name,
      "windowId:", wsp.windowId, "containerId:", wsp.containerId || null);
    return WorkspaceService._onActivationChain(async () => {
      await WorkspaceService._createWorkspaceOnChain(wsp);

      // Delegate tab creation to the workspace entity so the container-fallback
      // logic ("No permission" -> clear containerId -> _saveState -> retry) lives
      // in one place (Workspace._createTabFallback) instead of being duplicated here.
      const wspObj = await WSPStorageManager.getWorkspace(wsp.id);
      const tab = await wspObj._createTabFallback();
      // Reflect any containerId cleared by the fallback back to the caller's object.
      wsp.containerId = wspObj.containerId;
      console.log("[WorkspaceService][createWorkspaceWithTab] initial tab created:", tab.id,
        "effectiveContainerId:", wsp.containerId || null);

      // Filed here, into this workspace by id: addTabToWorkspace files into
      // whichever workspace is active, and its fallbacks wait for the chain
      // this step runs on. The tab's own onCreated waits for this step and
      // then finds it filed.
      const filed = await WSPStorageManager.mutateWorkspace(wsp.id, (fresh) => {
        if (TabService.wasRemoved(tab.id) || fresh.tabs.includes(tab.id)) return false;
        fresh.tabs.push(tab.id);
      });
      if (filed?.tabs.includes(tab.id)) {
        WorkspaceService.addTabToActiveCache(tab.id, wsp.id);
        await TabService.setTabSessionValue(tab.id, wsp.id);
        TabService._scheduleSnapshotRefresh(wsp.windowId, wsp.id);
        UIService.scheduleToolbarUpdate(wsp.windowId);
      }
      await WorkspaceService.hideInactiveWspTabs(wsp.windowId, wsp.id);

      console.log("[WorkspaceService][createWorkspaceWithTab] done — wspId:", wsp.id, "tabId:", tab.id);
      return { tabId: tab.id, wspId: wsp.id };
    });
  }

  static async renameWorkspace(wspId, { name, icon, color } = {}) {
    console.log("[WorkspaceService][renameWorkspace] wspId:", wspId,
      "name:", name, "icon:", icon, "color:", color);
    await Workspace.rename(wspId, { name, icon, color });

    await MenuService.refreshTabMenu();
    const state = await WSPStorageManager.getWspState(wspId);
    if (state && state.active) {
      console.log("[WorkspaceService][renameWorkspace] workspace is active — updating toolbar button");
      await UIService.updateToolbarButton(state.windowId);
    }
    console.log("[WorkspaceService][renameWorkspace] done — wspId:", wspId);
  }

  // `windowId` is optional: if the caller (popup) already knows it, passing
  // it lets us skip the getWorkspace(wspId) lookup and read only the batch
  // getWorkspaces(windowId), saving one storage round-trip per destroy.
  // `successorId`: the workspace to bring up when the destroyed one is
  // active (default: the first other one in the window list).
  static async destroyWsp(wspId, windowId = null, { successorId = null } = {}) {
    console.log("[WorkspaceService][destroyWsp] wspId:", wspId, "windowId:", windowId,
      "successorId:", successorId);

    // Resolve windowId if the caller didn't provide it. This falls back to a
    // per-wsp state read — same as the old two-read path.
    if (windowId == null) {
      const stub = await WSPStorageManager.getWorkspace(wspId);
      if (!stub || stub.windowId == null) {
        console.log("[WorkspaceService][destroyWsp] wspId not found or has no windowId");
        throw new Error("Workspace not found");
      }
      windowId = stub.windowId;
    }

    // Serialize whole destroys per window: the "last workspace" invariant is
    // cross-entity, so two concurrent destroys of DIFFERENT workspaces never
    // meet on a per-workspace lock -- both could pass the count check and
    // empty the window. The count is re-read inside this lock.
    return await WSPStorageManager.withDestroyLock(windowId, async () => {
      // Never a fallback filing target, and never activated, while it is
      // being destroyed (_doActivateWsp skips it). An activation already
      // queued or running may still land on it: wait for it before reading
      // whether it is the active one. Reading first let such an activation
      // complete on the workspace this destroy then deleted -- no workspace
      // active, and a cache naming a deleted one (X-29).
      WorkspaceService._pendingDestroys.add(wspId);
      let windowWorkspaces;
      let target;
      try {
        await WorkspaceService.whenActivationsSettled();
        windowWorkspaces = await WSPStorageManager.getWorkspaces(windowId);
        target = windowWorkspaces.find(w => w.id === wspId);
        if (!target || target.windowId == null) {
          console.log("[WorkspaceService][destroyWsp] wspId not in window", windowId);
          throw new Error("Workspace not found in window");
        }
        console.log("[WorkspaceService][destroyWsp] workspace:", target.name,
          "tabs:", target.tabs.length, "active:", target.active,
          "totalWorkspacesInWindow:", windowWorkspaces.length);

        // Prevent destroying the last workspace in the window
        if (windowWorkspaces.length <= 1) {
          throw new Error("Cannot destroy the last workspace");
        }
      } catch (e) {
        WorkspaceService._pendingDestroys.delete(wspId);
        throw e;
      }

      // If destroying the active workspace, activate another one first.
      // Without this, browser.tabs.remove inside destroy() can trigger Firefox
      // to auto-create a tab, and addTabToWorkspace finds no active workspace,
      // creating a phantom "Unnamed Workspace".
      //
      // NOTE: the per-workspace lock is taken in two NARROW blocks (pre-
      // deactivation, final destroy) instead of across the whole sequence.
      // activateWsp internally locks arbitrary workspace ids (deactivation
      // save, stale-tab cleanup) including this one -- holding wspId's lock
      // across it would deadlock on the non-re-entrant mutex. Tabs added to
      // the doomed workspace between the blocks are picked up by the fresh
      // re-read in the final block and closed with the rest.
      let activatedWspId = null;
      try {
        if (target.active) {
          const other = windowWorkspaces.find(w => w.id === successorId && w.id !== wspId)
            ?? windowWorkspaces.find(w => w.id !== wspId);
          if (other) {
            // Handoff: after the pre-deactivation and until `other` is active
            // the window has no active workspace (see _withHandoff).
            await WorkspaceService._withHandoff(windowId, async () => {
              await WSPStorageManager.mutateWorkspace(wspId, (fresh) => {
                // Mark inactive before activateWsp so the activation flow doesn't
                // waste work deactivating a workspace about to be deleted.
                fresh.active = false;
              });
              console.log("[WorkspaceService][destroyWsp] pre-deactivated, activating:", other.id, other.name);
              await WorkspaceService.activateWsp(other.id, windowId);
            });
            activatedWspId = other.id;
          }
        }

        await WSPStorageManager.withWorkspaceLock(wspId, async () => {
          // Re-read under the lock: freshest tab list wins (any addTab that
          // landed since the batch read above is included in the close).
          const wsp = await WSPStorageManager.getWorkspace(wspId);
          if (wsp.windowId == null) {
            console.log("[WorkspaceService][destroyWsp] wspId vanished before destroy");
            return;
          }

          // Remove from workspace order (own mutex: createWorkspace appends
          // concurrently and the interleaved read-modify-write can drop an id)
          await WSPStorageManager.withOrderLock(windowId, async () => {
            const order = await WSPStorageManager.getWorkspaceOrder(windowId);
            if (order) {
              const idx = order.indexOf(wspId);
              if (idx >= 0) {
                order.splice(idx, 1);
                await WSPStorageManager.saveWorkspaceOrder(windowId, order);
                console.log("[WorkspaceService][destroyWsp] removed from order at idx:", idx,
                  "new order length:", order.length);
              } else {
                console.log("[WorkspaceService][destroyWsp] wspId not found in order array");
              }
            }
          });

          await wsp.destroy();
        });
      } finally {
        WorkspaceService._pendingDestroys.delete(wspId);
      }
      await MenuService.refreshTabMenu();
      console.log("[WorkspaceService][destroyWsp] done — wspId:", wspId,
        "activatedWspId:", activatedWspId);
      return { activatedWspId };
    });
  }

  static async deactivateCurrentWsp(windowId) {
    console.log("[WorkspaceService][deactivateCurrentWsp] windowId:", windowId);
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    return WorkspaceService._deactivateCurrentWspFromList(workspaces, windowId);
  }

  // `allTabsHint`: optional pre-fetched tabs.query({windowId}) result from
  // the activation cascade (PLT-003) -- avoids re-querying the same window.
  static async _deactivateCurrentWspFromList(workspaces, windowId, allTabsHint = null) {
    const leaving = await WorkspaceService._prepareDeactivation(workspaces, windowId, allTabsHint);
    await WorkspaceService._commitDeactivation(leaving, null);
  }

  // First half of standing the active workspace down: files the untracked
  // visible tabs (into it, or by session tag into their own workspace) and
  // records what its snapshot needs. Writes no `active` flag: an activation
  // commits the stand-down only once its target is up (X-29). Returns the
  // plan _commitDeactivation takes.
  static async _prepareDeactivation(workspaces, windowId, allTabsHint = null) {
    const activeWsp = workspaces.find(wsp => wsp.active);
    // Any other workspace flagged active too (an old race or an interrupted
    // handoff, X-36): stood down with it.
    const alsoActive = workspaces.filter(wsp => wsp.active && wsp !== activeWsp).map(wsp => wsp.id);
    console.log("[WorkspaceService][_prepareDeactivation] windowId:", windowId,
      "activeWsp:", activeWsp ? `${activeWsp.id} "${activeWsp.name}"` : "none",
      "alsoActive:", alsoActive, "totalWorkspaces:", workspaces.length);
    const leaving = { id: activeWsp?.id ?? null, alsoActive, currentTabs: [], browserActiveTabId: null };
    if (!activeWsp) return leaving;

    const allWindowTabs = allTabsHint ?? await browser.tabs.query({ windowId });
    const currentTabs = allWindowTabs.filter(t => !t.pinned && !t.hidden);
    // Exclude special system tabs (e.g. Firefox View) from workspace tracking
    const trackableTabs = currentTabs.filter(tab => !tab.url?.startsWith("about:firefoxview"));
    const currentTabIds = trackableTabs.map(tab => tab.id);
    const tabsToAdd = currentTabIds.filter(tabId => workspaces.every(wsp => !wsp.tabs.includes(tabId)));
    if (tabsToAdd.length > 0) {
      // Check session values: late session-restored tabs may belong to a
      // different workspace. Parallel lookups -- this sits on the
      // activation critical path.
      const toOtherWsp = new Map(); // wspId -> [tabId, ...]
      const toActiveWsp = [];
      const sessionResults = await Promise.all(tabsToAdd.map(async (tabId) => {
        try { return [tabId, await browser.sessions.getTabValue(tabId, "wspId")]; }
        catch (e) {
          console.debug("[WorkspaceService][_prepareDeactivation] session lookup failed for tab", tabId, ":", e.message);
          return [tabId, undefined];
        }
      }));
      for (const [tabId, sessionWspId] of sessionResults) {
        const target = sessionWspId ? workspaces.find(w => w.id === sessionWspId) : null;
        if (target && target.id !== activeWsp.id) {
          if (!toOtherWsp.has(target.id)) toOtherWsp.set(target.id, []);
          toOtherWsp.get(target.id).push(tabId);
        } else {
          toActiveWsp.push(tabId);
        }
      }

      if (toActiveWsp.length > 0) {
        console.log(`[WorkspaceService][_prepareDeactivation] adding ${toActiveWsp.length} untracked tabs to active workspace "${activeWsp.name}":`, toActiveWsp);
        // Locked merge onto the fresh record, ahead of the tabs it had
        await WSPStorageManager.mutateWorkspace(activeWsp.id, (freshWsp) => {
          const added = toActiveWsp.filter(tabId => !freshWsp.tabs.includes(tabId));
          if (added.length === 0) return false;
          freshWsp.tabs.unshift(...added);
        });
        activeWsp.tabs.unshift(...toActiveWsp.filter(tabId => !activeWsp.tabs.includes(tabId)));
        await activeWsp.updateTabGroups();
        await Promise.all(toActiveWsp.map(tabId => TabService.setTabSessionValue(tabId, activeWsp.id)));
      }

      // Route session-tagged tabs to their correct workspaces. Locked
      // read-modify-write per target so a concurrent add/remove is not lost.
      for (const [wspId, tabIds] of toOtherWsp) {
        await WSPStorageManager.mutateWorkspace(wspId, (wsp) => {
          for (const tabId of tabIds) {
            if (!wsp.tabs.includes(tabId)) wsp.tabs.push(tabId);
          }
          console.log(`[WorkspaceService][_prepareDeactivation] routed ${tabIds.length} late tab(s) to workspace "${wsp.name}"`);
        });
      }

      if (toActiveWsp.length === 0 && toOtherWsp.size === 0) {
        console.log("[WorkspaceService][_prepareDeactivation] no untracked tabs to add");
      }
    } else {
      console.log("[WorkspaceService][_prepareDeactivation] no untracked tabs to add");
    }

    leaving.currentTabs = currentTabs;
    leaving.browserActiveTabId = currentTabs.find(t => t.active)?.id
      ?? (await browser.tabs.query({ active: true, windowId }))[0]?.id ?? null;
    return leaving;
  }

  // Second half: stand down the workspace the plan describes (snapshot,
  // last active tab, active=false) and every other one still flagged
  // active, except `keepId` -- the workspace just activated, which may be
  // the same one (re-activation).
  static async _commitDeactivation(leaving, keepId = null) {
    if (leaving.id && leaving.id !== keepId) {
      const { currentTabs, browserActiveTabId } = leaving;
      // Final deactivation save under the workspace lock: this is a full-
      // record write after many awaits, and used to race the locked
      // add/remove writers (lost-update on tabs[]).
      await WSPStorageManager.mutateWorkspace(leaving.id, (freshWsp) => {
        // Save tab URL snapshot for restart resilience
        const freshTabIds = new Set(freshWsp.tabs);
        freshWsp.tabSnapshot = currentTabs
          .filter(tab => freshTabIds.has(tab.id))
          .map(tab => tab.url);
        freshWsp.active = false;
        // Only save lastActiveTabId if the currently active tab belongs to this
        // workspace. If the user clicked a tab from another workspace (triggering
        // the switch), the browser's active tab already belongs to the destination
        // workspace, not the one being deactivated.
        const fallback = freshWsp.tabs.includes(freshWsp.lastActiveTabId) ? freshWsp.lastActiveTabId : null;
        freshWsp.lastActiveTabId = freshWsp.tabs.includes(browserActiveTabId) ? browserActiveTabId : fallback;
        // Save the URL of the last active tab so we can remap after restart
        // (Firefox assigns new tab IDs on restart, making the numeric ID stale).
        if (freshWsp.lastActiveTabId) {
          const lastActiveTab = currentTabs.find(t => t.id === freshWsp.lastActiveTabId);
          freshWsp.lastActiveTabUrl = lastActiveTab ? lastActiveTab.url : null;
        } else {
          freshWsp.lastActiveTabUrl = null;
        }
        console.log("[WorkspaceService][_commitDeactivation] deactivating",
          freshWsp.id, "| tabs:", freshWsp.tabs.length,
          "| lastActiveTabId:", freshWsp.lastActiveTabId,
          "| lastActiveTabUrl:", freshWsp.lastActiveTabUrl,
          "| snapshot URLs:", freshWsp.tabSnapshot.length);
      });
    }
    for (const wspId of leaving.alsoActive) {
      if (wspId === keepId) continue;
      console.warn("[WorkspaceService][_commitDeactivation] workspace", wspId, "was also flagged active -- standing it down");
      await WSPStorageManager.mutateWorkspace(wspId, (fresh) => {
        if (!fresh.active) return false;
        fresh.active = false;
      });
    }
  }

  // Serialized workspace activation via promise chain.
  // If a second activation arrives while one is in flight, it queues after it
  // instead of being silently dropped (old boolean guard behavior).
  static async activateWsp(wspId, windowId, activeTabId = null) {
    console.log("[WorkspaceService][activateWsp] wspId:", wspId,
      "windowId:", windowId, "activeTabId:", activeTabId,
      "_activationInProgress:", WorkspaceService._activationInProgress);
    const request = { windowId, wspId };
    WorkspaceService._pendingActivation = request;
    try {
      return await WorkspaceService._onActivationChain(
        () => WorkspaceService._doActivateWsp(wspId, windowId, activeTabId));
    } finally {
      if (WorkspaceService._pendingActivation === request) WorkspaceService._pendingActivation = null;
    }
  }

  static async _doActivateWsp(wspId, windowId, activeTabId) {
    // Cancel any pending debounced lastActiveTab save to prevent it from
    // running during activation and clobbering the deactivation's state
    // (read-modify-write race on the same workspace).
    clearTimeout(WorkspaceService._lastActiveTimer);
    WorkspaceService._lastActiveTimer = null;
    WorkspaceService._lastActivePending = null;

    // Bail before touching anything if the target no longer exists (e.g. a
    // queued activation racing a destroy). getWorkspace returns a stub for
    // missing keys, so windowId is the existence marker -- activating the
    // stub would create a fallback tab session-tagged with a dead wspId and
    // resurrect a zombie storage record. A workspace being destroyed is
    // skipped too: the destroy is about to close its tabs.
    const targetCheck = await WSPStorageManager.getWorkspace(wspId);
    if (targetCheck.windowId == null || WorkspaceService._pendingDestroys.has(wspId)) {
      console.warn("[WorkspaceService][activateWsp] workspace", wspId,
        "no longer exists or is being destroyed -- skipping activation");
      return;
    }

    // Single full-window tab query threaded through the cascade; the
    // deactivate and activate phases used to each re-query the same list.
    const allTabsAtStart = await browser.tabs.query({ windowId });

    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    // The workspace on screen is stood down only once the target is up:
    // standing it down first left no workspace active whenever the target
    // vanished or its activation threw, and the same after a crash in
    // between (X-29, X-95).
    const leaving = await WorkspaceService._prepareDeactivation(workspaces, windowId, allTabsAtStart);

    const wsp = await WSPStorageManager.getWorkspace(wspId);
    let activated = false;
    let failure = null;
    if (wsp.windowId != null) {
      console.log("[WorkspaceService][activateWsp] activating:", wsp.id, wsp.name,
        "tabs:", wsp.tabs.length);
      try {
        activated = await wsp.activate(activeTabId, allTabsAtStart);
      } catch (e) {
        failure = e;
      }
    }
    if (!activated) {
      console.warn("[WorkspaceService][activateWsp] workspace", wspId, "could not be activated",
        failure ? `(${failure.message})` : "(vanished mid-activation)", "-- keeping", leaving.id);
      await WorkspaceService._rollBackActivation(leaving, windowId, wspId);
      if (failure) throw failure;
      return;
    }
    await WorkspaceService._commitDeactivation(leaving, wspId);
    // wsp now carries the merged record (tabs filed during the activation)
    WorkspaceService._updateActiveCache(windowId, wsp.tabs, wsp.id, wsp.containerId);
    // Fresh list: locked writers may have moved tabs between workspaces
    // since the read above, and hiding from that copy would hide a tab
    // that now belongs to the workspace just shown.
    await WorkspaceService._hideInactiveFromList(
      await WSPStorageManager.getWorkspaces(windowId), windowId, wspId);
    await MenuService.refreshTabMenu();
    await UIService.updateToolbarButton(windowId);
    console.log("[WorkspaceService][activateWsp] done -- wspId:", wspId);
  }

  // The target could not be activated. The workspace that was on screen was
  // never stood down, so it stays the active one, and the cache (naming it)
  // stays right. If the target still exists its activation threw part-way:
  // its tabs may be on screen and one of them selected, so give the
  // selection back and hide them again. A destroyed target's tabs are being
  // closed by its destroy and are left to it.
  static async _rollBackActivation(leaving, windowId, targetId) {
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    const prev = leaving.id ? workspaces.find(w => w.id === leaving.id) : null;
    if (!prev || !prev.active) {
      WorkspaceService._activeCache = null;
      return;
    }
    if (!workspaces.some(w => w.id === targetId)) return;
    if (leaving.browserActiveTabId != null && prev.tabs.includes(leaving.browserActiveTabId)) {
      try { await browser.tabs.update(leaving.browserActiveTabId, { active: true }); }
      catch (e) { console.debug("[WorkspaceService][_rollBackActivation] could not reselect tab:", e.message); }
    }
    await WorkspaceService._hideInactiveFromList(workspaces, windowId, prev.id);
  }

  static async hideInactiveWspTabs(windowId, activeWspId = null) {
    console.log("[WorkspaceService][hideInactiveWspTabs] windowId:", windowId, "activeWspId:", activeWspId);
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    return WorkspaceService._hideInactiveFromList(workspaces, windowId, activeWspId);
  }

  static async _hideInactiveFromList(workspaces, windowId, activeWspId = null) {
    console.log("[WorkspaceService][_hideInactiveFromList] windowId:", windowId,
      "activeWspId:", activeWspId, "totalWorkspaces:", workspaces.length);
    // No workspace named and none flagged active (an interrupted activation,
    // create or destroy): "every workspace is inactive" used to hide every
    // tab but the selected one. Hide nothing; the init passes repair the
    // one-active invariant (Brainer._enforceActiveWorkspace, X-95).
    if (activeWspId == null && !workspaces.some(wsp => wsp.active)) {
      console.warn("[WorkspaceService][_hideInactiveFromList] no active workspace in window", windowId,
        "-- nothing hidden");
      return;
    }
    // Query open tabs once for stale-tab detection across all workspaces.
    // NOTE: This method now writes to storage (stale-tab cleanup).
    // Safe within activateWsp (guarded by _activating), but tab add/remove
    // events from concurrent TabService calls may still race.
    const allOpenTabs = await browser.tabs.query({ windowId });
    const openTabIds = new Set(allOpenTabs.map(tab => tab.id));

    const allTabsToHide = [];
    const toClean = [];

    for (const wsp of workspaces) {
      const isActive = activeWspId != null ? (wsp.id === activeWspId) : wsp.active;
      if (!isActive) {
        const validTabs = await Workspace._filterValidTabs(wsp.tabs, wsp.windowId, openTabIds);
        if (validTabs.length > 0) {
          console.log("[WorkspaceService][_hideInactiveFromList] workspace:", wsp.name,
            "scheduling", validTabs.length, "tabs for hide");
          allTabsToHide.push(...validTabs);
        }
        // Mark workspaces with stale tab IDs for cleanup after the loop.
        // Firefox reuses tab IDs, so stale IDs can cause a newly created tab
        // to be misidentified as belonging to the wrong workspace.
        if (validTabs.length !== wsp.tabs.length) {
          toClean.push(wsp);
        }
      }
    }

    // Batch stale-tab cleanup: one locked fresh-read + save per workspace,
    // so a concurrent add/remove (also locked) cannot be lost to this write.
    for (const wsp of toClean) {
      await WSPStorageManager.mutateWorkspace(wsp.id, (freshWsp) => {
        const freshValid = freshWsp.tabs.filter(id => openTabIds.has(id));
        if (freshValid.length === freshWsp.tabs.length) return false;
        console.log("[WorkspaceService][_hideInactiveFromList] cleaning",
          freshWsp.tabs.length - freshValid.length,
          "stale tab IDs from workspace:", wsp.name);
        freshWsp.tabs = freshValid;
        for (const group of freshWsp.groups) {
          group.tabs = group.tabs.filter(id => openTabIds.has(id));
        }
        // Sync in-memory object so catch-all orphan detection below uses clean data
        wsp.tabs = freshValid;
      });
    }

    console.log("[WorkspaceService][_hideInactiveFromList] total tabs to hide:", allTabsToHide.length);
    if (allTabsToHide.length > 0) {
      await TabService.hideTabs(allTabsToHide);
      // Only tabs in a group: an ungroup call also marks "our own ungroup"
      // for the closed-group bookkeeping (TabService.onTabGroupRemoved), and
      // this pass now runs at every init.
      const grouped = new Set(allOpenTabs.filter(tab => tab.groupId !== -1).map(tab => tab.id));
      const toUngroup = allTabsToHide.filter(id => grouped.has(id));
      if (toUngroup.length > 0) await TabService.ungroup(toUngroup);
    }

    // Catch-all: handle visible tabs not belonging to the active workspace
    if (activeWspId != null) {
      const activeWsp = workspaces.find(wsp => wsp.id === activeWspId);
      const activeTabIds = new Set(activeWsp ? activeWsp.tabs : []);
      const allTrackedIds = new Set(workspaces.flatMap(wsp => wsp.tabs));
      const visibleTabs = await browser.tabs.query({windowId, pinned: false, hidden: false});
      console.log("[WorkspaceService][_hideInactiveFromList] catch-all: visible tabs:", visibleTabs.length,
        "activeWsp tabs:", activeTabIds.size, "allTracked:", allTrackedIds.size);

      const toHide = [];
      const toAssign = [];
      const toRouteBySession = new Map(); // wspId -> [tab, ...]

      // Parallel session lookups for the orphan candidates only.
      const orphanTabs = visibleTabs.filter(tab =>
        !activeTabIds.has(tab.id) && !tab.active
        && !tab.url?.startsWith("about:firefoxview")
        && !allTrackedIds.has(tab.id));
      const orphanSessions = new Map(await Promise.all(orphanTabs.map(async (tab) => {
        try { return [tab.id, await browser.sessions.getTabValue(tab.id, "wspId")]; }
        catch (e) {
          console.debug("[WorkspaceService][_hideInactiveFromList] session lookup failed for tab", tab.id, ":", e.message);
          return [tab.id, undefined];
        }
      })));

      for (const tab of visibleTabs) {
        if (activeTabIds.has(tab.id) || tab.active) continue;
        if (tab.url?.startsWith("about:firefoxview")) continue; // never hide Firefox View

        if (!allTrackedIds.has(tab.id)) {
          // Orphaned tab - check session value before defaulting to active workspace.
          // Late session-restored tabs retain their workspace tag from the previous session.
          const sessionWspId = orphanSessions.get(tab.id);
          const sessionTarget = sessionWspId ? workspaces.find(w => w.id === sessionWspId) : null;

          if (sessionTarget && sessionTarget.id !== activeWspId) {
            // Tab belongs to a different workspace per session data - route there and hide
            if (!toRouteBySession.has(sessionTarget.id)) toRouteBySession.set(sessionTarget.id, []);
            toRouteBySession.get(sessionTarget.id).push(tab);
            toHide.push(tab.id);
          } else {
            // No session value or belongs to active workspace - assign to active
            toAssign.push(tab);
          }
        } else {
          // Belongs to an inactive workspace - hide it
          toHide.push(tab.id);
        }
      }

      // Route session-tagged orphans to their correct workspaces (locked
      // read-modify-write so concurrent add/remove writers are not clobbered)
      for (const [wspId, tabs] of toRouteBySession) {
        console.log(`[Workspaces] Routing ${tabs.length} late-restored tab(s) to workspace ${wspId}`);
        await WSPStorageManager.mutateWorkspace(wspId, (freshWsp) => {
          for (const tab of tabs) {
            if (!freshWsp.tabs.includes(tab.id)) freshWsp.tabs.push(tab.id);
          }
        });
        await Promise.all(tabs.map(tab => TabService.setTabSessionValue(tab.id, wspId)));
        // Keep tabSnapshot fresh for restart resilience (IC3).
        TabService._scheduleSnapshotRefresh(windowId, wspId);
      }

      // Assign remaining orphaned tabs to the active workspace
      if (toAssign.length > 0) {
        console.log(`[Workspaces] Assigning ${toAssign.length} orphaned tab(s) to active workspace`,
          toAssign.map(t => t.id));
        await WSPStorageManager.mutateWorkspace(activeWspId, (freshActive) => {
          for (const tab of toAssign) {
            if (!freshActive.tabs.includes(tab.id)) {
              freshActive.tabs.push(tab.id);
            }
          }
        });
        await Promise.all(toAssign.map(tab => TabService.setTabSessionValue(tab.id, activeWspId)));
        // The activation built the active cache before this sweep: without
        // these ids forceTabIntoActiveContainer ignores the tabs, so a tab
        // opened mid-switch escaped the workspace's container.
        for (const tab of toAssign) WorkspaceService.addTabToActiveCache(tab.id, activeWspId);
        // Keep tabSnapshot fresh for restart resilience (IC3).
        TabService._scheduleSnapshotRefresh(windowId, activeWspId);
      }

      if (toHide.length > 0) {
        console.log(`[Workspaces] Hiding ${toHide.length} orphaned visible tab(s):`, toHide);
        await TabService.hideTabs(toHide);
      }
    }
    console.log("[WorkspaceService][_hideInactiveFromList] done");
  }

  static generateWspName() {
    return 'Unnamed Workspace';
  }

  // ── Container helpers (Tier 2) ──

  static async getContainerList() {
    try {
      const containers = await browser.contextualIdentities.query({});
      console.log("[WorkspaceService][getContainerList] found", containers.length, "containers");
      return containers;
    } catch (e) {
      console.debug("[Workspaces] contextualIdentities unavailable:", e.message);
      return [];
    }
  }

  static async setWorkspaceContainer(wspId, containerId) {
    console.log("[WorkspaceService][setWorkspaceContainer] wspId:", wspId, "containerId:", containerId);
    // Locked read-modify-write: the full-record save used to race the locked
    // tab add/remove writers. A workspace destroyed while the edit dialog was
    // open is reported instead of resurrected as a zombie record.
    let oldContainerId;
    const saved = await WSPStorageManager.mutateWorkspace(wspId, (fresh) => {
      oldContainerId = fresh.containerId;
      fresh.containerId = containerId;
    });
    if (!saved) throw new Error(Workspace.NOT_FOUND_MESSAGE);
    console.log("[WorkspaceService][setWorkspaceContainer] changed:", oldContainerId, "->", containerId);

    // Reopen existing tabs in the new container (skip if removing container)
    if (containerId && containerId !== oldContainerId) {
      await WorkspaceService._migrateTabsToContainer(wspId, containerId);
    }

    // Keep the active-workspace cache's containerId in sync so navigation-time
    // enforcement (TabService.forceTabIntoActiveContainer) uses the current
    // binding. Covers clearing the container too -- _migrateTabsToContainer is
    // not called in that case, so it would otherwise leave a stale containerId.
    if (WorkspaceService._activeCache?.activeWspId === wspId) {
      WorkspaceService._activeCache.containerId = containerId || null;
    }
  }

  // Reopen all tabs of a workspace in a new container, preserving order.
  // Uses the remove-before-reopen pattern (same as moveTabToWsp) to prevent
  // onRemoved from saving closed-tab entries or double-removing tabs.
  static async _migrateTabsToContainer(wspId, containerId) {
    console.log("[WorkspaceService][_migrateTabsToContainer] wspId:", wspId, "containerId:", containerId);
    const wsp = await WSPStorageManager.getWorkspace(wspId);

    // Fetch live tab info for all workspace tabs
    const liveTabs = await Promise.all(
      wsp.tabs.map(id => browser.tabs.get(id).catch(() => null))
    );

    // Filter to tabs that need migration (wrong container)
    const toMigrate = liveTabs.filter(tab => tab && tab.cookieStoreId !== containerId
      && TabService._canReopenInContainer(tab.url));
    if (toMigrate.length === 0) {
      console.log("[WorkspaceService][_migrateTabsToContainer] no tabs need migration");
      return;
    }
    console.log("[WorkspaceService][_migrateTabsToContainer] migrating", toMigrate.length,
      "of", wsp.tabs.length, "tabs");

    // Save original tab order as template before modifying storage
    const originalOrder = [...wsp.tabs];

    // Remove old tab IDs from workspace storage BEFORE reopening.
    // This prevents onRemoved from saving them as closed tabs or removing them from workspace.
    const migrateIds = new Set(toMigrate.map(t => t.id));
    await WSPStorageManager.mutateWorkspace(wspId, (freshWsp) => {
      freshWsp.tabs = freshWsp.tabs.filter(id => !migrateIds.has(id));
      for (const group of freshWsp.groups) {
        group.tabs = group.tabs.filter(id => !migrateIds.has(id));
      }
      console.log("[WorkspaceService][_migrateTabsToContainer] pre-removed", migrateIds.size,
        "tabs from storage, remaining:", freshWsp.tabs.length);
    });

    // Reopen tabs in the new container
    const oldToNew = new Map();
    await TabService.withReopenGuard(async () => {
      for (const tab of toMigrate) {
        const newTab = await TabService._reopenInContainer(tab, containerId);
        if (newTab) {
          oldToNew.set(tab.id, newTab.id);
        }
      }
    });
    console.log("[WorkspaceService][_migrateTabsToContainer] reopened", oldToNew.size,
      "tabs, failed:", toMigrate.length - oldToNew.size);

    // Rebuild tab list preserving original order (swap old IDs for new IDs)
    const rebuiltTabs = [];
    for (const id of originalOrder) {
      if (oldToNew.has(id)) {
        rebuiltTabs.push(oldToNew.get(id));
      } else if (!migrateIds.has(id)) {
        // Tab wasn't migrated (already correct container) — keep it
        rebuiltTabs.push(id);
      }
      else {
        // Migration failed — keep original tab in workspace if it still exists
        rebuiltTabs.push(id);
      }
    }

    // Save rebuilt tab list (locked read-modify-write)
    const finalWsp = await WSPStorageManager.getWorkspace(wspId);
    await WSPStorageManager.mutateWorkspace(wspId, (fresh) => {
      fresh.tabs = rebuiltTabs;
    });
    finalWsp.tabs = rebuiltTabs;
    await finalWsp.updateTabGroups();
    console.log("[WorkspaceService][_migrateTabsToContainer] rebuilt tab list:", rebuiltTabs.length, "tabs");

    // Tag new tabs with session values
    const newTabIds = [...oldToNew.values()];
    await Promise.all(newTabIds.map(id => TabService.setTabSessionValue(id, wspId)));
    // Keep tabSnapshot fresh for restart resilience (IC3) -- tabs[] was
    // rebuilt with brand-new IDs.
    TabService._scheduleSnapshotRefresh(wsp.windowId, wspId);

    // If workspace is active: update cache
    if (wsp.active) {
      WorkspaceService._updateActiveCache(wsp.windowId, rebuiltTabs, wsp.id, containerId);
      console.log("[WorkspaceService][_migrateTabsToContainer] updated active cache");
    } else {
      // Inactive workspace: new tabs are created visible by default — hide them
      if (newTabIds.length > 0) {
        await TabService.hideTabs(newTabIds);
        console.log("[WorkspaceService][_migrateTabsToContainer] hid", newTabIds.length,
          "tabs (inactive workspace)");
      }
    }

    console.log("[WorkspaceService][_migrateTabsToContainer] done");
  }

  // Workspace order operations. `orderedIds` is the popup's full list as
  // rendered, which can be stale: merged under the order lock (the same one
  // createWorkspace/destroyWsp hold) instead of replacing the array, so a
  // workspace created meanwhile keeps its place, and ids that do not belong
  // to this window's workspaces are dropped.
  static async saveWorkspaceOrder(windowId, orderedIds) {
    console.log("[WorkspaceService][saveWorkspaceOrder] windowId:", windowId,
      "order:", orderedIds);
    await WSPStorageManager.withOrderLock(windowId, async () => {
      const members = new Set(await WSPStorageManager.getWorkspaceIds(windowId));
      const merged = [...new Set(orderedIds)].filter(id => members.has(id));
      const stored = await WSPStorageManager.getWorkspaceOrder(windowId) ?? [];
      for (const id of stored) {
        if (members.has(id) && !merged.includes(id)) merged.push(id);
      }
      await WSPStorageManager.saveWorkspaceOrder(windowId, merged);
      console.log("[WorkspaceService][saveWorkspaceOrder] saved:", merged);
    });
  }
}
