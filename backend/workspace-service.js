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
  static _activeCache = null; // { windowId: number, tabIds: Set<number> } | null

  static isActivating() {
    return this._activationInProgress;
  }

  // Returns true/false if the tab's membership is known, or null if cache is cold/mismatched window.
  static isTabInActiveWsp(windowId, tabId) {
    const c = WorkspaceService._activeCache;
    if (!c || c.windowId !== windowId) return null;
    return c.tabIds.has(tabId);
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
      activeWsp.lastActiveTabId = pending.tabId;
      activeWsp.lastActiveTabUrl = pending.url;
      await activeWsp._saveState();
    } catch (e) {
      console.debug("[WorkspaceService][updateLastActiveTab] failed:", e.message);
    }
  }

  // Flush any pending debounced save immediately (called on shutdown).
  static async flushLastActiveTab() {
    await WorkspaceService._flushLastActiveTabImpl();
  }

  static _updateActiveCache(windowId, tabIds) {
    WorkspaceService._activeCache = { windowId, tabIds: new Set(tabIds) };
    console.log("[WorkspaceService][_updateActiveCache] windowId:", windowId, "tabIds:", tabIds.length);
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

    // Append to workspace order
    const order = await WSPStorageManager.getWorkspaceOrder(wsp.windowId);
    if (order) {
      order.push(wsp.id);
      await WSPStorageManager.saveWorkspaceOrder(wsp.windowId, order);
      console.log("[WorkspaceService][createWorkspace] appended to order, new order length:", order.length);
    } else {
      console.log("[WorkspaceService][createWorkspace] no existing order — skipping order update");
    }

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

  static async destroyWsp(wspId) {
    console.log("[WorkspaceService][destroyWsp] wspId:", wspId);
    const wsp = await WSPStorageManager.getWorkspace(wspId);
    console.log("[WorkspaceService][destroyWsp] workspace:", wsp.name,
      "tabs:", wsp.tabs.length, "active:", wsp.active);

    // Remove from workspace order
    const order = await WSPStorageManager.getWorkspaceOrder(wsp.windowId);
    if (order) {
      const idx = order.indexOf(wspId);
      if (idx >= 0) {
        order.splice(idx, 1);
        await WSPStorageManager.saveWorkspaceOrder(wsp.windowId, order);
        console.log("[WorkspaceService][destroyWsp] removed from order at idx:", idx,
          "new order length:", order.length);
      } else {
        console.log("[WorkspaceService][destroyWsp] wspId not found in order array");
      }
    }

    await wsp.destroy();
    await MenuService.refreshTabMenu();
    console.log("[WorkspaceService][destroyWsp] done — wspId:", wspId);
  }

  static async deactivateCurrentWsp(windowId) {
    console.log("[WorkspaceService][deactivateCurrentWsp] windowId:", windowId);
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    return WorkspaceService._deactivateCurrentWspFromList(workspaces, windowId);
  }

  static async _deactivateCurrentWspFromList(workspaces, windowId) {
    const activeWsp = workspaces.find(wsp => wsp.active);
    console.log("[WorkspaceService][_deactivateCurrentWspFromList] windowId:", windowId,
      "activeWsp:", activeWsp ? `${activeWsp.id} "${activeWsp.name}"` : "none",
      "totalWorkspaces:", workspaces.length);

    if (activeWsp) {
      const currentTabs = await browser.tabs.query({windowId, pinned: false, hidden: false});
      // Exclude special system tabs (e.g. Firefox View) from workspace tracking
      const trackableTabs = currentTabs.filter(tab => !tab.url?.startsWith("about:firefoxview"));
      const currentTabIds = trackableTabs.map(tab => tab.id);
      const tabsToAdd = currentTabIds.filter(tabId => workspaces.every(wsp => !wsp.tabs.includes(tabId)));
      // Declared at outer scope so the freshWsp merge loop below can access them
      let toActiveWsp = [];
      if (tabsToAdd.length > 0) {
        // Check session values: late session-restored tabs may belong to a different workspace
        const toOtherWsp = new Map(); // wspId -> [tabId, ...]
        for (const tabId of tabsToAdd) {
          let sessionWspId;
          try { sessionWspId = await browser.sessions.getTabValue(tabId, "wspId"); }
          catch (e) { console.debug("[WorkspaceService][_deactivateCurrentWspFromList] session lookup failed for tab", tabId, ":", e.message); }
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

        // Route session-tagged tabs to their correct workspaces
        for (const [wspId, tabIds] of toOtherWsp) {
          const wsp = await WSPStorageManager.getWorkspace(wspId);
          for (const tabId of tabIds) {
            if (!wsp.tabs.includes(tabId)) wsp.tabs.push(tabId);
          }
          await wsp._saveState();
          console.log(`[WorkspaceService][_deactivateCurrentWspFromList] routed ${tabIds.length} late tab(s) to workspace "${wsp.name}"`);
        }

        if (toActiveWsp.length === 0 && toOtherWsp.size === 0) {
          console.log("[WorkspaceService][_deactivateCurrentWspFromList] no untracked tabs to add");
        }
      } else {
        console.log("[WorkspaceService][_deactivateCurrentWspFromList] no untracked tabs to add");
      }

      // Re-read fresh state to avoid overwriting concurrent changes from
      // addTabToWorkspace or removeTabFromWorkspace that may have fired
      // during the awaits above.
      const freshWsp = await WSPStorageManager.getWorkspace(activeWsp.id);
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
      const browserActiveTabId = (await browser.tabs.query({active: true, windowId}))[0]?.id || null;
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
      const workspaces = await WSPStorageManager.getWorkspaces(windowId);
      console.log("[WorkspaceService][activateWsp] deactivating current workspace...");
      await WorkspaceService._deactivateCurrentWspFromList(workspaces, windowId);

      const wsp = await WSPStorageManager.getWorkspace(wspId);
      console.log("[WorkspaceService][activateWsp] activating:", wsp.id, wsp.name,
        "tabs:", wsp.tabs.length);
      await wsp.activate(activeTabId);
      WorkspaceService._updateActiveCache(windowId, wsp.tabs);
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

    // Batch stale-tab cleanup: one fresh-read + save per workspace.
    for (const wsp of toClean) {
      const freshWsp = await WSPStorageManager.getWorkspace(wsp.id);
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

      for (const tab of visibleTabs) {
        if (activeTabIds.has(tab.id) || tab.active) continue;
        if (tab.url?.startsWith("about:firefoxview")) continue; // never hide Firefox View

        if (!allTrackedIds.has(tab.id)) {
          // Orphaned tab - check session value before defaulting to active workspace.
          // Late session-restored tabs retain their workspace tag from the previous session.
          let sessionWspId;
          try { sessionWspId = await browser.sessions.getTabValue(tab.id, "wspId"); }
          catch (e) { console.debug("[WorkspaceService][_hideInactiveFromList] session lookup failed for tab", tab.id, ":", e.message); }
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

      // Route session-tagged orphans to their correct workspaces
      for (const [wspId, tabs] of toRouteBySession) {
        console.log(`[Workspaces] Routing ${tabs.length} late-restored tab(s) to workspace ${wspId}`);
        const freshWsp = await WSPStorageManager.getWorkspace(wspId);
        for (const tab of tabs) {
          if (!freshWsp.tabs.includes(tab.id)) freshWsp.tabs.push(tab.id);
          await TabService.setTabSessionValue(tab.id, wspId);
        }
        await freshWsp._saveState();
      }

      // Assign remaining orphaned tabs to the active workspace
      if (toAssign.length > 0) {
        console.log(`[Workspaces] Assigning ${toAssign.length} orphaned tab(s) to active workspace`,
          toAssign.map(t => t.id));
        const freshActive = await WSPStorageManager.getWorkspace(activeWspId);
        for (const tab of toAssign) {
          if (!freshActive.tabs.includes(tab.id)) {
            freshActive.tabs.push(tab.id);
          }
          await TabService.setTabSessionValue(tab.id, activeWspId);
        }
        await freshActive._saveState();
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
    const state = await WSPStorageManager.getWspState(wspId);
    const oldContainerId = state.containerId;
    state.containerId = containerId;
    await WSPStorageManager.saveWspState(wspId, state);
    console.log("[WorkspaceService][setWorkspaceContainer] changed:", oldContainerId, "->", containerId);

    // Reopen existing tabs in the new container (skip if removing container)
    if (containerId && containerId !== oldContainerId) {
      await WorkspaceService._migrateTabsToContainer(wspId, containerId);
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
    const freshWsp = await WSPStorageManager.getWorkspace(wspId);
    freshWsp.tabs = freshWsp.tabs.filter(id => !migrateIds.has(id));
    for (const group of freshWsp.groups) {
      group.tabs = group.tabs.filter(id => !migrateIds.has(id));
    }
    await freshWsp._saveState();
    console.log("[WorkspaceService][_migrateTabsToContainer] pre-removed", migrateIds.size,
      "tabs from storage, remaining:", freshWsp.tabs.length);

    // Reopen tabs in the new container
    const oldToNew = new Map();
    TabService._reopeningCount++;
    try {
      for (const tab of toMigrate) {
        const newTab = await TabService._reopenInContainer(tab, containerId);
        if (newTab) {
          oldToNew.set(tab.id, newTab.id);
        }
      }
    } finally {
      TabService._reopeningCount--;
    }
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

    // Save rebuilt tab list
    const finalWsp = await WSPStorageManager.getWorkspace(wspId);
    finalWsp.tabs = rebuiltTabs;
    await finalWsp._saveState();
    await finalWsp.updateTabGroups();
    console.log("[WorkspaceService][_migrateTabsToContainer] rebuilt tab list:", rebuiltTabs.length, "tabs");

    // Tag new tabs with session values
    const newTabIds = [...oldToNew.values()];
    await Promise.all(newTabIds.map(id => TabService.setTabSessionValue(id, wspId)));

    // If workspace is active: update cache
    if (wsp.active) {
      WorkspaceService._updateActiveCache(wsp.windowId, rebuiltTabs);
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
