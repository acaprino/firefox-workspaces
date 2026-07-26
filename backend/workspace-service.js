// Workspace CRUD, activate, deactivate, containers
// NOTE: WorkspaceService and TabService have a bidirectional dependency.
// WorkspaceService calls TabService for session tagging (setTabSessionValue,
// addTabToWorkspace). TabService calls WorkspaceService for workspace CRUD
// (destroyWsp, activateWsp, hideInactiveWspTabs, getActiveWsp, _buildDefaultWspData,
// createWorkspace, getOrderedWorkspaces). Both are singletons in the same MV2 scope.
class WorkspaceService {
  static _activationChain = Promise.resolve();
  static _activationInProgress = false;
  // In-memory cache of the active workspace's tab IDs for fast onTabActivated lookups.
  // Avoids a storage read on every tab click in the common case (tab already in active workspace).
  // Invalidated by activateWsp (replaced) and tab add/remove ops (updated or cleared).
  static _activeCache = null; // { windowId: number, activeWspId: string|null, tabIds: Set<number>, containerId: string|null } | null

  static isActivating() {
    return this._activationInProgress;
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
      const activeWsp = await WorkspaceService.getActiveWsp(pending.windowId);
      if (!activeWsp || !activeWsp.tabs.includes(pending.tabId)) return;
      // Re-read under the workspace lock and write only the lastActiveTab
      // fields: this debounced save used to rewrite the whole record from a
      // pre-await snapshot, silently dropping tabs[] changes a concurrent
      // locked add/remove had landed in between.
      await WSPStorageManager.withWorkspaceLock(activeWsp.id, async () => {
        const fresh = await WSPStorageManager.getWorkspace(activeWsp.id);
        if (fresh.windowId == null || !fresh.tabs.includes(pending.tabId)) return;
        fresh.lastActiveTabId = pending.tabId;
        fresh.lastActiveTabUrl = pending.url;
        await fresh._saveState();
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

  static async createWorkspace(wsp) {
    console.log("[WorkspaceService][createWorkspace] name:", wsp.name,
      "windowId:", wsp.windowId, "tabs:", wsp.tabs?.length ?? 0,
      "containerId:", wsp.containerId || null, "color:", wsp.color || null);
    await WorkspaceService.deactivateCurrentWsp(wsp.windowId);

    const w = await Workspace.create(wsp.id, wsp);
    // Propagate generated UUID back so callers (createWorkspaceWithTab, order,
    // hideInactiveWspTabs) use the real ID instead of undefined.
    wsp.id = w.id;
    await w.updateTabGroups();

    // Re-point the active cache: deactivateCurrentWsp above stood the previous
    // workspace down, so leaving its entry in place makes the cache lie about
    // which workspace (and container) is active. That stale containerId made
    // TabService.forceTabIntoActiveContainer reopen the new workspace's tabs in
    // the PREVIOUS workspace's container on first navigation, and file them
    // under the previous workspace. activateWsp is the only other writer, and
    // it is not on the create path.
    if (w.active) {
      WorkspaceService._updateActiveCache(wsp.windowId, w.tabs, w.id, w.containerId);
    } else {
      // Nothing is active in this window any more -- an entry for the workspace
      // we just deactivated would be just as wrong.
      WorkspaceService._activeCache = null;
      console.log("[WorkspaceService][createWorkspace] created inactive workspace -- active cache cleared");
    }

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

  // Create workspace and its initial tab in one operation (called from popup)
  static async createWorkspaceWithTab(wsp) {
    console.log("[WorkspaceService][createWorkspaceWithTab] name:", wsp.name,
      "windowId:", wsp.windowId, "containerId:", wsp.containerId || null);
    await WorkspaceService.createWorkspace(wsp);

    // Delegate tab creation to the workspace entity so the container-fallback
    // logic ("No permission" -> clear containerId -> _saveState -> retry) lives
    // in one place (Workspace._createTabFallback) instead of being duplicated here.
    const wspObj = await WSPStorageManager.getWorkspace(wsp.id);
    const tab = await wspObj._createTabFallback();
    // Reflect any containerId cleared by the fallback back to the caller's object.
    wsp.containerId = wspObj.containerId;
    console.log("[WorkspaceService][createWorkspaceWithTab] initial tab created:", tab.id,
      "effectiveContainerId:", wsp.containerId || null);

    await TabService.addTabToWorkspace(tab);
    await WorkspaceService.hideInactiveWspTabs(wsp.windowId, wsp.id);

    console.log("[WorkspaceService][createWorkspaceWithTab] done — wspId:", wsp.id, "tabId:", tab.id);
    return { tabId: tab.id, wspId: wsp.id };
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
  static async destroyWsp(wspId, windowId = null) {
    console.log("[WorkspaceService][destroyWsp] wspId:", wspId, "windowId:", windowId);

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
      const windowWorkspaces = await WSPStorageManager.getWorkspaces(windowId);
      const target = windowWorkspaces.find(w => w.id === wspId);
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
      if (target.active) {
        const other = windowWorkspaces.find(w => w.id !== wspId);
        if (other) {
          await WSPStorageManager.withWorkspaceLock(wspId, async () => {
            const fresh = await WSPStorageManager.getWorkspace(wspId);
            if (fresh.windowId == null) return; // vanished meanwhile
            // Mark inactive before activateWsp so the activation flow doesn't
            // waste work deactivating a workspace about to be deleted.
            fresh.active = false;
            await fresh._saveState();
          });
          console.log("[WorkspaceService][destroyWsp] pre-deactivated, activating:", other.id, other.name);
          await WorkspaceService.activateWsp(other.id, windowId);
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
    const activeWsp = workspaces.find(wsp => wsp.active);
    console.log("[WorkspaceService][_deactivateCurrentWspFromList] windowId:", windowId,
      "activeWsp:", activeWsp ? `${activeWsp.id} "${activeWsp.name}"` : "none",
      "totalWorkspaces:", workspaces.length);

    if (activeWsp) {
      const allWindowTabs = allTabsHint ?? await browser.tabs.query({ windowId });
      const currentTabs = allWindowTabs.filter(t => !t.pinned && !t.hidden);
      // Exclude special system tabs (e.g. Firefox View) from workspace tracking
      const trackableTabs = currentTabs.filter(tab => !tab.url?.startsWith("about:firefoxview"));
      const currentTabIds = trackableTabs.map(tab => tab.id);
      const tabsToAdd = currentTabIds.filter(tabId => workspaces.every(wsp => !wsp.tabs.includes(tabId)));
      // Declared at outer scope so the freshWsp merge loop below can access them
      let toActiveWsp = [];
      if (tabsToAdd.length > 0) {
        // Check session values: late session-restored tabs may belong to a
        // different workspace. Parallel lookups -- this sits on the
        // activation critical path.
        const toOtherWsp = new Map(); // wspId -> [tabId, ...]
        const sessionResults = await Promise.all(tabsToAdd.map(async (tabId) => {
          try { return [tabId, await browser.sessions.getTabValue(tabId, "wspId")]; }
          catch (e) {
            console.debug("[WorkspaceService][_deactivateCurrentWspFromList] session lookup failed for tab", tabId, ":", e.message);
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
          console.log(`[WorkspaceService][_deactivateCurrentWspFromList] adding ${toActiveWsp.length} untracked tabs to active workspace "${activeWsp.name}":`, toActiveWsp);
          activeWsp.tabs.unshift(...toActiveWsp);
          await activeWsp.updateTabGroups();
          await Promise.all(toActiveWsp.map(tabId => TabService.setTabSessionValue(tabId, activeWsp.id)));
        }

        // Route session-tagged tabs to their correct workspaces. Locked
        // read-modify-write per target so a concurrent add/remove is not lost.
        for (const [wspId, tabIds] of toOtherWsp) {
          await WSPStorageManager.withWorkspaceLock(wspId, async () => {
            const wsp = await WSPStorageManager.getWorkspace(wspId);
            if (wsp.windowId == null) return; // destroyed meanwhile
            for (const tabId of tabIds) {
              if (!wsp.tabs.includes(tabId)) wsp.tabs.push(tabId);
            }
            await wsp._saveState();
            console.log(`[WorkspaceService][_deactivateCurrentWspFromList] routed ${tabIds.length} late tab(s) to workspace "${wsp.name}"`);
          });
        }

        if (toActiveWsp.length === 0 && toOtherWsp.size === 0) {
          console.log("[WorkspaceService][_deactivateCurrentWspFromList] no untracked tabs to add");
        }
      } else {
        console.log("[WorkspaceService][_deactivateCurrentWspFromList] no untracked tabs to add");
      }

      const browserActiveTabId = currentTabs.find(t => t.active)?.id
        ?? (await browser.tabs.query({ active: true, windowId }))[0]?.id ?? null;

      // Final deactivation save under the workspace lock: this is a full-
      // record write after many awaits, and used to race the locked
      // add/remove writers (lost-update on tabs[]).
      await WSPStorageManager.withWorkspaceLock(activeWsp.id, async () => {
        const freshWsp = await WSPStorageManager.getWorkspace(activeWsp.id);
        if (freshWsp.windowId == null) return; // destroyed meanwhile
        // Merge only tabs assigned to this workspace (not those routed elsewhere by session value)
        for (const tabId of toActiveWsp) {
          if (!freshWsp.tabs.includes(tabId)) {
            freshWsp.tabs.unshift(tabId);
          }
        }
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
        console.log("[WorkspaceService][_deactivateCurrentWspFromList] deactivating",
          freshWsp.id, "| tabs:", freshWsp.tabs.length,
          "| lastActiveTabId:", freshWsp.lastActiveTabId,
          "| lastActiveTabUrl:", freshWsp.lastActiveTabUrl,
          "| snapshot URLs:", freshWsp.tabSnapshot.length);
        await freshWsp._saveState();
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
    WorkspaceService._activationChain = WorkspaceService._activationChain
      .catch(() => {})
      .then(() => WorkspaceService._doActivateWsp(wspId, windowId, activeTabId));
    return WorkspaceService._activationChain;
  }

  static async _doActivateWsp(wspId, windowId, activeTabId) {
    // Cancel any pending debounced lastActiveTab save to prevent it from
    // running during activation and clobbering _deactivateCurrentWspFromList's
    // state (read-modify-write race on the same workspace).
    clearTimeout(WorkspaceService._lastActiveTimer);
    WorkspaceService._lastActiveTimer = null;
    WorkspaceService._lastActivePending = null;
    WorkspaceService._activationInProgress = true;
    try {
      // Bail before touching anything if the target no longer exists (e.g. a
      // queued activation racing a destroy). getWorkspace returns a stub for
      // missing keys, so windowId is the existence marker -- activating the
      // stub would create a fallback tab session-tagged with a dead wspId and
      // resurrect a zombie storage record.
      const targetCheck = await WSPStorageManager.getWorkspace(wspId);
      if (targetCheck.windowId == null) {
        console.warn("[WorkspaceService][activateWsp] workspace", wspId,
          "no longer exists -- skipping activation");
        return;
      }

      // Single full-window tab query threaded through the cascade; the
      // deactivate and activate phases used to each re-query the same list.
      const allTabsAtStart = await browser.tabs.query({ windowId });

      const workspaces = await WSPStorageManager.getWorkspaces(windowId);
      console.log("[WorkspaceService][activateWsp] deactivating current workspace...");
      await WorkspaceService._deactivateCurrentWspFromList(workspaces, windowId, allTabsAtStart);

      const wsp = await WSPStorageManager.getWorkspace(wspId);
      if (wsp.windowId == null) {
        console.warn("[WorkspaceService][activateWsp] workspace", wspId,
          "vanished mid-activation -- aborting");
        return;
      }
      console.log("[WorkspaceService][activateWsp] activating:", wsp.id, wsp.name,
        "tabs:", wsp.tabs.length);
      await wsp.activate(activeTabId, allTabsAtStart);
      WorkspaceService._updateActiveCache(windowId, wsp.tabs, wsp.id, wsp.containerId);
      await WorkspaceService._hideInactiveFromList(workspaces, windowId, wspId);
      await MenuService.refreshTabMenu();
      await UIService.updateToolbarButton(windowId);
      console.log("[WorkspaceService][activateWsp] done -- wspId:", wspId);
    } finally {
      WorkspaceService._activationInProgress = false;
    }
  }

  static async hideInactiveWspTabs(windowId, activeWspId = null) {
    console.log("[WorkspaceService][hideInactiveWspTabs] windowId:", windowId, "activeWspId:", activeWspId);
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    return WorkspaceService._hideInactiveFromList(workspaces, windowId, activeWspId);
  }

  static async _hideInactiveFromList(workspaces, windowId, activeWspId = null) {
    console.log("[WorkspaceService][_hideInactiveFromList] windowId:", windowId,
      "activeWspId:", activeWspId, "totalWorkspaces:", workspaces.length);
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
      await WSPStorageManager.withWorkspaceLock(wsp.id, async () => {
        const freshWsp = await WSPStorageManager.getWorkspace(wsp.id);
        if (freshWsp.windowId == null) return; // destroyed meanwhile
        const freshValid = freshWsp.tabs.filter(id => openTabIds.has(id));
        if (freshValid.length !== freshWsp.tabs.length) {
          console.log("[WorkspaceService][_hideInactiveFromList] cleaning",
            freshWsp.tabs.length - freshValid.length,
            "stale tab IDs from workspace:", wsp.name);
          freshWsp.tabs = freshValid;
          for (const group of freshWsp.groups) {
            group.tabs = group.tabs.filter(id => openTabIds.has(id));
          }
          await freshWsp._saveState();
          // Sync in-memory object so catch-all orphan detection below uses clean data
          wsp.tabs = freshValid;
        }
      });
    }

    console.log("[WorkspaceService][_hideInactiveFromList] total tabs to hide:", allTabsToHide.length);
    if (allTabsToHide.length > 0) {
      try { await browser.tabs.hide(allTabsToHide); }
      catch (e) { console.debug("[WorkspaceService][_hideInactiveFromList] tabs.hide failed:", e.message); }
      try { await browser.tabs.ungroup(allTabsToHide); }
      catch (e) { console.debug("[WorkspaceService][_hideInactiveFromList] tabs.ungroup failed:", e.message); }
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
        await WSPStorageManager.withWorkspaceLock(wspId, async () => {
          const freshWsp = await WSPStorageManager.getWorkspace(wspId);
          if (freshWsp.windowId == null) return; // destroyed meanwhile
          for (const tab of tabs) {
            if (!freshWsp.tabs.includes(tab.id)) freshWsp.tabs.push(tab.id);
          }
          await freshWsp._saveState();
        });
        await Promise.all(tabs.map(tab => TabService.setTabSessionValue(tab.id, wspId)));
        // Keep tabSnapshot fresh for restart resilience (IC3).
        TabService._scheduleSnapshotRefresh(windowId, wspId);
      }

      // Assign remaining orphaned tabs to the active workspace
      if (toAssign.length > 0) {
        console.log(`[Workspaces] Assigning ${toAssign.length} orphaned tab(s) to active workspace`,
          toAssign.map(t => t.id));
        await WSPStorageManager.withWorkspaceLock(activeWspId, async () => {
          const freshActive = await WSPStorageManager.getWorkspace(activeWspId);
          if (freshActive.windowId == null) return; // destroyed meanwhile
          for (const tab of toAssign) {
            if (!freshActive.tabs.includes(tab.id)) {
              freshActive.tabs.push(tab.id);
            }
          }
          await freshActive._saveState();
        });
        await Promise.all(toAssign.map(tab => TabService.setTabSessionValue(tab.id, activeWspId)));
        // Keep tabSnapshot fresh for restart resilience (IC3).
        TabService._scheduleSnapshotRefresh(windowId, activeWspId);
      }

      if (toHide.length > 0) {
        console.log(`[Workspaces] Hiding ${toHide.length} orphaned visible tab(s):`, toHide);
        try { await browser.tabs.hide(toHide); }
        catch (e) { console.debug("[WorkspaceService][_hideInactiveFromList] orphan tabs.hide failed:", e.message); }
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
    // tab add/remove writers.
    let oldContainerId;
    await WSPStorageManager.withWorkspaceLock(wspId, async () => {
      const state = await WSPStorageManager.getWspState(wspId);
      oldContainerId = state.containerId;
      state.containerId = containerId;
      await WSPStorageManager.saveWspState(wspId, state);
    });
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
    await WSPStorageManager.withWorkspaceLock(wspId, async () => {
      const freshWsp = await WSPStorageManager.getWorkspace(wspId);
      if (freshWsp.windowId == null) return;
      freshWsp.tabs = freshWsp.tabs.filter(id => !migrateIds.has(id));
      for (const group of freshWsp.groups) {
        group.tabs = group.tabs.filter(id => !migrateIds.has(id));
      }
      await freshWsp._saveState();
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
    await WSPStorageManager.withWorkspaceLock(wspId, async () => {
      const fresh = await WSPStorageManager.getWorkspace(wspId);
      if (fresh.windowId == null) return;
      fresh.tabs = rebuiltTabs;
      await fresh._saveState();
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
        try { await browser.tabs.hide(newTabIds); }
        catch (e) { console.debug("[WorkspaceService][_migrateTabsToContainer] tabs.hide failed:", e.message); }
        console.log("[WorkspaceService][_migrateTabsToContainer] hid", newTabIds.length,
          "tabs (inactive workspace)");
      }
    }

    console.log("[WorkspaceService][_migrateTabsToContainer] done");
  }

  // Workspace order operations
  static async saveWorkspaceOrder(windowId, orderedIds) {
    console.log("[WorkspaceService][saveWorkspaceOrder] windowId:", windowId,
      "order:", orderedIds);
    await WSPStorageManager.saveWorkspaceOrder(windowId, orderedIds);
  }
}
