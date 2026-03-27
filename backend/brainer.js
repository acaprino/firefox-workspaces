// Orchestrator: init + listener registration only. All logic delegated to services.
class Brainer {
  // Lifecycle states: 'uninitialized' -> 'restoring' -> 'ready'
  static _state = 'uninitialized';
  static _initStarted = false;
  static _lastFocusedWindowId = null;

  static async initialize() {
    Brainer._initStarted = true;
    console.log("[Brainer][initialize] starting — current state:", Brainer._state);
    await WSPStorageManager.ensureSchemaVersion();
    this._registerWindowListeners();
    this._registerTabListeners();
    this._registerCommandListeners();
    MenuService.registerOmniboxListeners();

    // Detect restart vs first-ever startup BEFORE _ensureDefaultWorkspace
    // to eliminate the race with onStartup event.
    const existingPrimary = await WSPStorageManager.getPrimaryWindowId();
    const lastId = await WSPStorageManager.getPrimaryWindowLastId();
    console.log("[Brainer][initialize] existingPrimary:", existingPrimary, "| lastId:", lastId);

    if (existingPrimary == null && lastId != null) {
      // Restart: restore workspaces directly (don't rely on onStartup event).
      // Set state first to block any onWindowCreated races during window lookup.
      console.log("[Brainer][initialize] restart detected — entering restore path");
      Brainer._state = 'restoring';
      try {
        const currentWindow = await Brainer._findRestoreWindow(lastId);
        console.log("[Brainer][initialize] restore window chosen:", currentWindow.id);
        await Brainer._restoreWorkspaces(currentWindow);
        Brainer._state = 'ready';
        console.log("[Brainer][initialize] restore complete — state: ready");
        // Reconcile tabs that Firefox session-restored during the 'restoring' window.
        // Their onTabCreated was blocked, so they need explicit assignment.
        await new Promise(r => setTimeout(r, 500));
        await Brainer._reconcileLateTabs(currentWindow.id);
      } catch (e) {
        Brainer._state = 'uninitialized';
        console.error("[Brainer][initialize] restore failed — state reset to uninitialized:", e);
        throw e;
      }
    } else {
      console.log("[Brainer][initialize] first-start or already-running path");
      await this._ensureDefaultWorkspace();
      // Remove stale tab IDs from all workspaces. After a non-clean shutdown
      // (crash, kill, power loss) the restart is not detected because
      // onWindowRemoved never fired, so stale IDs from the previous session
      // linger. Firefox reuses tab IDs across sessions, so a newly created
      // tab can match a stale ID and trigger an unwanted workspace switch.
      const pid = await WSPStorageManager.getPrimaryWindowId();
      if (pid) {
        await Brainer._cleanStaleTabIds(pid);
        await Brainer._reconcileLateTabs(pid);
      }
      // Ensure state is 'ready' even if onInstalled fired before its listener
      // was registered (during the ensureSchemaVersion() await above).
      if (Brainer._state !== 'ready') {
        console.log("[Brainer][initialize] state was", Brainer._state, "— forcing to ready");
        Brainer._state = 'ready';
      }
    }

    // Warm tab info cache so closed-tab tracking works from the start
    const primaryWindowId = await WSPStorageManager.getPrimaryWindowId();
    console.log("[Brainer][initialize] primaryWindowId after init:", primaryWindowId);
    if (primaryWindowId) await TabService.warmTabInfoCache(primaryWindowId);

    await MenuService.refreshTabMenu();
    if (primaryWindowId) await UIService.updateToolbarButton(primaryWindowId);
    console.log("[Brainer][initialize] done — final state:", Brainer._state);
  }

  // Shared initialization: ensure primary window and default workspace exist
  static async _ensureDefaultWorkspace() {
    console.log("[Brainer][_ensureDefaultWorkspace] state:", Brainer._state);
    if (Brainer._state === 'restoring') {
      console.log("[Brainer][_ensureDefaultWorkspace] skipped — state is 'restoring'");
      return;
    }
    // If primaryWindowLastId exists, this is a restart — let restore handle it
    const lastId = await WSPStorageManager.getPrimaryWindowLastId();
    if (lastId != null) {
      console.log("[Brainer][_ensureDefaultWorkspace] skipped — lastId present:", lastId, "(restart path)");
      return;
    }
    const existing = await WSPStorageManager.getPrimaryWindowId();
    if (existing == null) {
      const currentWindow = await browser.windows.getCurrent();
      console.log("[Brainer][_ensureDefaultWorkspace] no primary window — setting to:", currentWindow.id);
      await WSPStorageManager.setPrimaryWindowId(currentWindow.id);

      const activeWsp = await WorkspaceService.getActiveWsp(currentWindow.id);
      if (!activeWsp) {
        console.log("[Brainer][_ensureDefaultWorkspace] no active workspace — creating default");
        const allTabs = await browser.tabs.query({windowId: currentWindow.id, pinned: false});
        const currentTabs = allTabs.filter(tab => !tab.url?.startsWith("about:firefoxview"));
        console.log("[Brainer][_ensureDefaultWorkspace] unpinned tabs to absorb:", currentTabs.length,
          currentTabs.map(t => t.id));
        const wsp = WorkspaceService._buildDefaultWspData(
          currentWindow.id,
          currentTabs.map(tab => tab.id)
        );
        await WorkspaceService.createWorkspace(wsp);
        for (const tab of currentTabs) {
          await TabService.setTabSessionValue(tab.id, wsp.id);
        }
        console.log("[Brainer][_ensureDefaultWorkspace] default workspace created:", wsp.id);
      } else {
        console.log("[Brainer][_ensureDefaultWorkspace] active workspace already exists:", activeWsp.id, activeWsp.name);
      }
    } else {
      console.log("[Brainer][_ensureDefaultWorkspace] primary window already set:", existing);
    }
  }

  // ── Window & Lifecycle Listeners ──

  static _registerWindowListeners() {
    browser.runtime.onInstalled.addListener(async () => {
      try {
        console.log("[Brainer][onInstalled] fired — state:", Brainer._state);
        if (Brainer._state === 'restoring') {
          console.log("[Brainer][onInstalled] skipped — state is 'restoring'");
          return;
        }
        await Brainer._ensureDefaultWorkspace();
        Brainer._state = 'ready';
        console.log("[Brainer][onInstalled] done — state: ready");
      } catch (e) { console.error("[Workspaces] onInstalled error:", e); }
    });

    browser.windows.onCreated.addListener(async (window) => {
      try {
        console.log("[Brainer][onWindowCreated] windowId:", window.id, "state:", Brainer._state);
        await Brainer._onWindowCreated(window);
      } catch (e) { console.error("[Workspaces] onCreated error:", e); }
    });

    browser.runtime.onStartup.addListener(async () => {
      try {
        console.log("[Brainer][onStartup] fired — state:", Brainer._state);
        // initialize() already handles restart restore directly;
        // this is kept as a fallback for edge cases only.
        if (Brainer._state === 'ready' || Brainer._state === 'restoring' || Brainer._initStarted) {
          console.log("[Brainer][onStartup] skipped — state:", Brainer._state, "initStarted:", Brainer._initStarted);
          return;
        }
        const windowsOnLoad = await browser.windows.getAll();
        console.log("[Brainer][onStartup] windows on load:", windowsOnLoad.length);
        if (windowsOnLoad.length === 1) {
          await Brainer._onWindowCreated(windowsOnLoad[0]);
        }
      } catch (e) { console.error("[Workspaces] onStartup error:", e); }
    });

    browser.windows.onRemoved.addListener(async (windowId) => {
      try {
        console.log("[Brainer][onWindowRemoved] windowId:", windowId);
        const primaryId = await WSPStorageManager.getPrimaryWindowId();
        if (primaryId === windowId) {
          console.log("[Brainer][onWindowRemoved] primary window closed — clearing primary, saving lastId");
          await WSPStorageManager.removePrimaryWindowId();
          await WSPStorageManager.setPrimaryWindowLastId(windowId);
          Brainer._state = 'uninitialized';
          console.log("[Brainer][onWindowRemoved] state reset to uninitialized");
        } else {
          console.log("[Brainer][onWindowRemoved] non-primary window (primary was:", primaryId, ") — no action");
        }
      } catch (e) { console.error("[Workspaces] onRemoved error:", e); }
    });

    browser.windows.onFocusChanged.addListener(async (windowId) => {
      try {
        if (windowId === browser.windows.WINDOW_ID_NONE) return;
        if (windowId === Brainer._lastFocusedWindowId) return;
        console.log("[Brainer][onFocusChanged] windowId:", windowId, "(prev:", Brainer._lastFocusedWindowId, ")");
        Brainer._lastFocusedWindowId = windowId;
        await MenuService.refreshTabMenu();
        await UIService.updateToolbarButton(windowId);
      } catch (e) { console.error("[Workspaces] onFocusChanged error:", e); }
    });

    browser.theme.onUpdated.addListener(async ({ theme, windowId: themeWindowId } = {}) => {
      try {
        console.log("[Brainer][onThemeUpdated] fired -- themeWindowId:", themeWindowId,
          "| colors:", JSON.stringify(theme?.colors ?? null));
        // Invalidate caches: custom icons must be regenerated with the new theme colors
        UIService._svgCache.clear();
        UIService.clearThemeCache();
        const primaryWindowId = await WSPStorageManager.getPrimaryWindowId();
        console.log("[Brainer][onThemeUpdated] primaryWindowId:", primaryWindowId);
        if (primaryWindowId) await UIService.updateToolbarButton(primaryWindowId, theme?.colors);
        await MenuService.refreshTabMenu();
      } catch (e) { console.error("[Workspaces] onThemeUpdated error:", e); }
    });
  }

  static async _onWindowCreated(window) {
    console.log("[Brainer][_onWindowCreated] windowId:", window.id, "state:", Brainer._state);
    if (Brainer._state === 'restoring') {
      console.log("[Brainer][_onWindowCreated] skipped — state is 'restoring'");
      return;
    }

    const primaryId = await WSPStorageManager.getPrimaryWindowId();
    const lastId = await WSPStorageManager.getPrimaryWindowLastId();
    console.log("[Brainer][_onWindowCreated] primaryId:", primaryId, "lastId:", lastId);

    // First-ever startup (no primary window recorded)
    if (primaryId == null && lastId == null) {
      console.log("[Brainer][_onWindowCreated] first-ever startup — setting primary to:", window.id);
      await WSPStorageManager.setPrimaryWindowId(window.id);

      const wsp = WorkspaceService._buildDefaultWspData(window.id);
      await WorkspaceService.createWorkspace(wsp);
      Brainer._state = 'ready';
      console.log("[Brainer][_onWindowCreated] default workspace created, state: ready");
      return;
    }

    // Browser restart — restore workspaces using Sessions API
    if (primaryId == null) {
      console.log("[Brainer][_onWindowCreated] restart path — lastId:", lastId, "entering restore");
      // Set flag before any awaits to close the race window with
      // _ensureDefaultWorkspace (which runs from initialize()).
      Brainer._state = 'restoring';
      try {
        await Brainer._restoreWorkspaces(window);
        Brainer._state = 'ready';
        console.log("[Brainer][_onWindowCreated] restore complete — state: ready");
      } catch (e) {
        Brainer._state = 'uninitialized';
        console.error("[Brainer][_onWindowCreated] restore failed:", e);
        throw e;
      }
    } else {
      console.log("[Brainer][_onWindowCreated] additional window opened (primary already:", primaryId, ") — no action");
    }
  }

  // Pick the window that corresponds to the old primary window.
  // With multiple windows (e.g. user had 2 windows open), getCurrent() may
  // return a fresh blank window instead of the session-restored one.
  // We score each window by how many of its tab URLs appear in the saved
  // workspace snapshots, with one retry to tolerate session-restore lag.
  static async _findRestoreWindow(oldWindowId) {
    const allWindows = await browser.windows.getAll();
    console.log("[Brainer][_findRestoreWindow] oldWindowId:", oldWindowId, "allWindows:", allWindows.map(w => w.id));
    if (allWindows.length === 1) {
      console.log("[Brainer][_findRestoreWindow] single window — no scoring needed, returning:", allWindows[0].id);
      return allWindows[0];
    }

    const oldWorkspaces = await WSPStorageManager.getWorkspaces(oldWindowId);
    const snapshotUrls = new Set(oldWorkspaces.flatMap(w => w.tabSnapshot || []));
    console.log("[Brainer][_findRestoreWindow] snapshot URLs:", snapshotUrls.size,
      "from", oldWorkspaces.length, "workspaces");

    const score = async (win) => {
      const tabs = await browser.tabs.query({ windowId: win.id });
      return snapshotUrls.size > 0
        ? tabs.filter(t => snapshotUrls.has(t.url)).length
        : tabs.filter(t => !t.pinned).length;
    };

    // Try twice: session restore may not have populated tabs on the first read
    for (let attempt = 0; attempt < 2; attempt++) {
      let best = allWindows[0];
      let bestScore = -1;
      for (const win of allWindows) {
        const s = await score(win);
        console.log("[Brainer][_findRestoreWindow] attempt", attempt, "window:", win.id, "score:", s);
        if (s > bestScore) { bestScore = s; best = win; }
      }
      console.log("[Brainer][_findRestoreWindow] attempt", attempt, "best:", best.id, "score:", bestScore);
      if (bestScore > 0) return best;
      if (attempt === 0) {
        console.log("[Brainer][_findRestoreWindow] score=0, waiting 600ms before retry...");
        await new Promise(r => setTimeout(r, 600));
      }
    }

    // Last resort: window with the most tabs
    let best = allWindows[0];
    let bestCount = -1;
    for (const win of allWindows) {
      const tabs = await browser.tabs.query({ windowId: win.id });
      console.log("[Brainer][_findRestoreWindow] last-resort: window", win.id, "has", tabs.length, "tabs");
      if (tabs.length > bestCount) { bestCount = tabs.length; best = win; }
    }
    console.log("[Brainer][_findRestoreWindow] last-resort winner:", best.id, "with", bestCount, "tabs");
    return best;
  }

  static async _restoreWorkspaces(window) {
    console.log("[Brainer][_restoreWorkspaces] windowId:", window.id);
    // All tab IDs are invalidated across restart; clear stale force-reopen entries
    TabService._forceReopenIds.clear();
    await WSPStorageManager.setPrimaryWindowId(window.id);
    const newTabs = await browser.tabs.query({windowId: window.id});
    console.log("[Brainer][_restoreWorkspaces] tabs in window:", newTabs.length);

    // Build tab mapping using sessions API
    const sessionMap = new Map();
    await Promise.all(newTabs.map(async (tab) => {
      try {
        const wspId = await browser.sessions.getTabValue(tab.id, "wspId");
        if (wspId) sessionMap.set(tab.id, wspId);
      } catch (e) {
        // Tab may not have session value
      }
    }));

    const unpinnedCount = newTabs.filter(t => !t.pinned).length;
    console.log(`[Workspaces] Restore: ${sessionMap.size}/${unpinnedCount} tabs have session values`);

    const oldWindowId = await WSPStorageManager.getPrimaryWindowLastId();
    const oldWorkspaces = await WSPStorageManager.getWorkspaces(oldWindowId);
    const oldOrder = await WSPStorageManager.getWorkspaceOrder(oldWindowId);

    console.log(`[Workspaces] Restore: found ${oldWorkspaces.length} workspaces for window ${oldWindowId}`);
    console.log("[Brainer][_restoreWorkspaces] old workspace names:", oldWorkspaces.map(w => w.name));

    // Capture workspace data before destroy
    let wspData = oldWorkspaces.map(wsp => ({
      id: wsp.id,
      name: wsp.name,
      icon: wsp.icon || "",
      active: wsp.active,
      groups: wsp.groups,
      containerId: wsp.containerId || null,
      lastActiveTabId: wsp.lastActiveTabId || null,
      color: wsp.color || null,
      tabSnapshot: wsp.tabSnapshot || []
    }));

    // If storage was wiped (e.g. extension reinstall cleared data) but session values
    // still reference workspace IDs, reconstruct minimal stub workspaces so tabs
    // don't all collapse into a single default workspace.
    if (wspData.length === 0 && sessionMap.size > 0) {
      console.warn("[Workspaces] Restore: no workspaces in storage but session values exist — reconstructing from session");
      const seenIds = new Set();
      let isFirst = true;
      let counter = 1;
      for (const wspId of sessionMap.values()) {
        if (seenIds.has(wspId) || !UUID_RE.test(wspId)) continue;
        seenIds.add(wspId);
        wspData.push({
          id: wspId,
          name: `Restored Workspace ${counter++}`,
          icon: "",
          active: isFirst,
          groups: [],
          containerId: null,
          lastActiveTabId: null,
          color: null,
          tabSnapshot: []
        });
        isFirst = false;
      }
      console.log("[Brainer][_restoreWorkspaces] reconstructed", wspData.length, "stub workspaces");
    }

    // Destroy old window data FIRST — destroyWindow deletes ld-wsp-{wspId}
    // entries for the old window's workspace IDs. Since IDs are reused, doing
    // this after Workspace.create would wipe the freshly saved states.
    console.log("[Brainer][_restoreWorkspaces] destroying old window data for windowId:", oldWindowId);
    await WSPStorageManager.destroyWindow(oldWindowId);

    // Now create new workspace objects (states won't be clobbered)
    console.log("[Brainer][_restoreWorkspaces] recreating", wspData.length, "workspaces for new windowId:", window.id);
    for (const wsp of wspData) {
      await Workspace.create(wsp.id, {
        ...wsp,
        tabs: [],
        windowId: window.id
      });
    }

    // Migrate order to new window
    if (oldOrder) {
      console.log("[Brainer][_restoreWorkspaces] migrating workspace order:", oldOrder);
      await WSPStorageManager.saveWorkspaceOrder(window.id, oldOrder);
    }

    // Assign tabs using session values — batch by workspace to reduce storage reads
    const tabsByWsp = new Map();
    const untaggedTabs = [];

    for (const tab of newTabs) {
      if (tab.pinned) continue;

      const wspId = sessionMap.get(tab.id);
      if (wspId && wspData.find(w => w.id === wspId)) {
        if (!tabsByWsp.has(wspId)) tabsByWsp.set(wspId, []);
        tabsByWsp.get(wspId).push(tab);
      } else {
        if (wspId) console.warn(`[Workspaces] Restore: session value ${wspId} not found in wspData (${wspData.length} workspaces)`);
        untaggedTabs.push(tab);
      }
    }

    console.log("[Brainer][_restoreWorkspaces] session-tagged tabs by workspace:",
      [...tabsByWsp.entries()].map(([id, tabs]) => `${id.slice(0,8)}: ${tabs.length} tabs`));
    console.log("[Brainer][_restoreWorkspaces] untagged tabs:", untaggedTabs.length);

    // One storage read per workspace instead of per tab
    for (const [wspId, tabs] of tabsByWsp) {
      const wspObj = await WSPStorageManager.getWorkspace(wspId);
      for (const tab of tabs) {
        if (!wspObj.tabs.includes(tab.id)) {
          wspObj.tabs.push(tab.id);
        }
      }
      await wspObj._saveState();
    }

    // URL-based fallback for untagged tabs (session values may be lost across restart)
    if (untaggedTabs.length > 0) {
      console.warn(`[Workspaces] Restore: ${untaggedTabs.length} untagged tab(s) — trying URL snapshot fallback`);

      // Build mutable snapshot maps; consume entries to handle duplicate URLs correctly
      const snapshotByWsp = new Map();
      for (const wsp of wspData) {
        if (wsp.tabSnapshot.length > 0) {
          snapshotByWsp.set(wsp.id, [...wsp.tabSnapshot]);
        }
      }

      // Phase 1: URL matching (pure in-memory, no I/O) — group matched tabs by workspace
      const urlMatchMap = new Map(); // wspId -> tab[]
      const unmatchedTabs = [];
      for (const tab of untaggedTabs) {
        let matchedWspId = null;
        for (const [wspId, urls] of snapshotByWsp) {
          const idx = urls.indexOf(tab.url);
          if (idx !== -1) {
            matchedWspId = wspId;
            urls.splice(idx, 1);
            break;
          }
        }
        if (matchedWspId) {
          if (!urlMatchMap.has(matchedWspId)) urlMatchMap.set(matchedWspId, []);
          urlMatchMap.get(matchedWspId).push(tab);
        } else {
          unmatchedTabs.push(tab);
        }
      }

      // Phase 2: One storage read-modify-write per matched workspace (was one per tab)
      for (const [wspId, tabs] of urlMatchMap) {
        console.log(`[Workspaces] Restore: URL-matched ${tabs.length} tab(s) to workspace`);
        const wspObj = await WSPStorageManager.getWorkspace(wspId);
        for (const tab of tabs) {
          if (!wspObj.tabs.includes(tab.id)) wspObj.tabs.push(tab.id);
        }
        await wspObj._saveState();
      }

      // Phase 3: Truly unmatched tabs go to the active workspace
      for (const tab of unmatchedTabs) {
        console.log(`[Workspaces] Restore: no URL match, adding to active workspace`, tab.url);
        if (await TabService.addTabToWorkspace(tab, { skipForceContainer: true })) {
          await browser.tabs.show(tab.id);
        }
      }
    }

    // Re-tag all tabs with fresh session values (parallelized per workspace)
    console.log("[Brainer][_restoreWorkspaces] re-tagging tabs with fresh session values");
    for (const wsp of wspData) {
      const wspObj = await WSPStorageManager.getWorkspace(wsp.id);
      console.log("[Brainer][_restoreWorkspaces] workspace:", wsp.name, "tabs:", wspObj.tabs.length, "active:", wsp.active);
      await Promise.all(
        wspObj.tabs.map(tabId => TabService.setTabSessionValue(tabId, wsp.id))
      );
      if (wsp.active && wspObj.tabs.length > 0) {
        // Preserve lastActiveTabId from before restart; only fall back to
        // first tab if the saved tab is no longer in this workspace.
        if (!wspObj.lastActiveTabId || !wspObj.tabs.includes(wspObj.lastActiveTabId)) {
          console.log("[Brainer][_restoreWorkspaces] lastActiveTabId stale for", wsp.name,
            "— falling back to first tab:", wspObj.tabs[0]);
          wspObj.lastActiveTabId = wspObj.tabs[0];
        }
        await wspObj._saveState();
      }
    }

    // Activate the correct workspace — this shows its tabs, focuses the
    // last-active tab, and ensures Firefox's active tab belongs to the right
    // workspace before we hide inactive ones.
    const activeWspData = wspData.find(w => w.active);
    console.log("[Brainer][_restoreWorkspaces] active workspace:", activeWspData?.id, activeWspData?.name);
    if (activeWspData) {
      const activeWspObj = await WSPStorageManager.getWorkspace(activeWspData.id);
      await activeWspObj.activate();
      // Populate active cache so onTabActivated fast-path works immediately after restore
      WorkspaceService._updateActiveCache(window.id, activeWspObj.tabs);
    }

    // Re-hide tabs in inactive workspaces immediately after restore
    await WorkspaceService.hideInactiveWspTabs(window.id, activeWspData ? activeWspData.id : null);

    // Clean up: remove stale lastId so subsequent restarts don't re-read it
    await WSPStorageManager.removePrimaryWindowLastId();
    console.log("[Brainer][_restoreWorkspaces] done");
  }

  // Remove tab IDs from workspaces that no longer correspond to open tabs.
  // Called during the "already-running" init path to handle non-clean restarts
  // where onWindowRemoved never fired (crash, kill, power loss).
  static async _cleanStaleTabIds(windowId) {
    const allTabs = await browser.tabs.query({ windowId });
    const openTabIds = new Set(allTabs.map(t => t.id));
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    let totalCleaned = 0;

    for (const wsp of workspaces) {
      const validTabs = wsp.tabs.filter(id => openTabIds.has(id));
      if (validTabs.length < wsp.tabs.length) {
        const staleCount = wsp.tabs.length - validTabs.length;
        console.log("[Brainer][_cleanStaleTabIds] workspace:", wsp.name,
          "removing", staleCount, "stale tab IDs:",
          wsp.tabs.filter(id => !openTabIds.has(id)));
        const fresh = await WSPStorageManager.getWorkspace(wsp.id);
        fresh.tabs = fresh.tabs.filter(id => openTabIds.has(id));
        for (const group of fresh.groups) {
          group.tabs = group.tabs.filter(id => openTabIds.has(id));
        }
        await fresh._saveState();
        totalCleaned += staleCount;
      }
    }

    if (totalCleaned > 0) {
      console.log("[Brainer][_cleanStaleTabIds] total stale IDs removed:", totalCleaned);
    } else {
      console.log("[Brainer][_cleanStaleTabIds] no stale tab IDs found");
    }
  }

  // Catch tabs that Firefox session-restored during the 'restoring' phase.
  // Their onTabCreated events were blocked, so they need explicit assignment.
  static async _reconcileLateTabs(windowId) {
    const allTabs = await browser.tabs.query({ windowId, pinned: false });
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    const allTrackedIds = new Set(workspaces.flatMap(w => w.tabs));
    const untracked = allTabs.filter(t => !allTrackedIds.has(t.id)
      && !t.url?.startsWith("about:firefoxview"));

    if (untracked.length === 0) {
      console.log("[Brainer][_reconcileLateTabs] all tabs accounted for");
      return;
    }

    console.log("[Brainer][_reconcileLateTabs]", untracked.length, "untracked tabs found");

    const activeWsp = workspaces.find(w => w.active);
    const byWsp = new Map();
    const noSession = [];

    for (const tab of untracked) {
      let wspId;
      try { wspId = await browser.sessions.getTabValue(tab.id, "wspId"); } catch {}
      const target = wspId ? workspaces.find(w => w.id === wspId) : null;
      if (target) {
        if (!byWsp.has(wspId)) byWsp.set(wspId, []);
        byWsp.get(wspId).push(tab);
      } else {
        noSession.push(tab);
      }
    }

    // Assign session-tagged tabs to their correct workspaces
    const toHide = [];
    for (const [wspId, tabs] of byWsp) {
      const wsp = await WSPStorageManager.getWorkspace(wspId);
      for (const tab of tabs) {
        if (!wsp.tabs.includes(tab.id)) wsp.tabs.push(tab.id);
        await TabService.setTabSessionValue(tab.id, wspId);
      }
      await wsp._saveState();
      if (!wsp.active) {
        toHide.push(...tabs.map(t => t.id));
      } else {
        for (const tab of tabs) WorkspaceService._activeCache?.tabIds.add(tab.id);
      }
      console.log("[Brainer][_reconcileLateTabs] assigned", tabs.length, "tabs to workspace", wsp.name);
    }

    // Assign untagged tabs to active workspace (last resort)
    if (noSession.length > 0 && activeWsp) {
      const fresh = await WSPStorageManager.getWorkspace(activeWsp.id);
      for (const tab of noSession) {
        if (!fresh.tabs.includes(tab.id)) fresh.tabs.push(tab.id);
        await TabService.setTabSessionValue(tab.id, activeWsp.id);
        WorkspaceService._activeCache?.tabIds.add(tab.id);
      }
      await fresh._saveState();
      console.log("[Brainer][_reconcileLateTabs] assigned", noSession.length, "untagged tabs to active workspace");
    }

    if (toHide.length > 0) {
      try { await browser.tabs.hide(toHide); } catch {}
      try { await browser.tabs.ungroup(toHide); } catch {}
      console.log("[Brainer][_reconcileLateTabs] hidden", toHide.length, "inactive-workspace tabs");
    }
  }

  // ── Tab Listeners ──

  static _registerTabListeners() {
    browser.tabs.onCreated.addListener(async (tab) => {
      try {
        TabService.cacheTabInfo(tab);
        console.log("[Brainer][onTabCreated] tabId:", tab.id, "windowId:", tab.windowId,
          "pinned:", tab.pinned, "url:", tab.url, "state:", Brainer._state);
        if (Brainer._state !== 'ready') {
          console.log("[Brainer][onTabCreated] skipped — state not ready");
          return;
        }
        if (WorkspaceService.isActivating()) {
          console.log("[Brainer][onTabCreated] skipped — workspace activating");
          return;
        }
        const primaryId = await WSPStorageManager.getPrimaryWindowId();
        if (primaryId !== tab.windowId) {
          console.log("[Brainer][onTabCreated] skipped — not primary window (primary:", primaryId, ")");
          return;
        }
        if (tab.pinned) {
          console.log("[Brainer][onTabCreated] skipped — pinned tab");
          return;
        }
        await TabService.addTabToWorkspace(tab);
      } catch (e) { console.error("[Workspaces] onTabCreated error:", e); }
    });

    browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
      try {
        console.log("[Brainer][onTabRemoved] tabId:", tabId, "windowId:", removeInfo.windowId,
          "isWindowClosing:", removeInfo.isWindowClosing, "state:", Brainer._state);
        if (Brainer._state !== 'ready') {
          console.log("[Brainer][onTabRemoved] skipped — state not ready");
          return;
        }
        const primaryId = await WSPStorageManager.getPrimaryWindowId();
        if (primaryId !== removeInfo.windowId) {
          console.log("[Brainer][onTabRemoved] skipped — not primary window (primary:", primaryId, ")");
          return;
        }
        if (removeInfo.isWindowClosing) {
          console.log("[Brainer][onTabRemoved] skipped — window closing");
          return;
        }
        await TabService.saveClosedTabInfo(removeInfo.windowId, tabId);
        await TabService.removeTabFromWorkspace(removeInfo.windowId, tabId);
        await UIService.updateToolbarButton(removeInfo.windowId);
      } catch (e) { console.error("[Workspaces] onTabRemoved error:", e); }
    });

    browser.tabs.onActivated.addListener(async (activeInfo) => {
      try {
        console.log("[Brainer][onTabActivated] tabId:", activeInfo.tabId,
          "windowId:", activeInfo.windowId, "state:", Brainer._state);
        if (Brainer._state !== 'ready') {
          console.log("[Brainer][onTabActivated] skipped — state not ready");
          return;
        }
        if (WorkspaceService.isActivating()) {
          console.log("[Brainer][onTabActivated] skipped — workspace activating");
          return;
        }

        // Fast path: check in-memory cache before reading storage.
        // Returns true if tab is known to be in the active workspace (most tab clicks).
        const cacheResult = WorkspaceService.isTabInActiveWsp(activeInfo.windowId, activeInfo.tabId);
        console.log("[Brainer][onTabActivated] cache result:", cacheResult);
        if (cacheResult === true) {
          console.log("[Brainer][onTabActivated] fast-path hit — tab in active workspace, no action");
          return;
        }

        const workspaces = await WSPStorageManager.getWorkspaces(activeInfo.windowId);
        const activeWsp = workspaces.find(wsp => wsp.active);
        console.log("[Brainer][onTabActivated] activeWsp:", activeWsp?.id, activeWsp?.name,
          "tabs:", activeWsp?.tabs.length);

        if (!activeWsp || activeWsp.tabs.includes(activeInfo.tabId)) {
          console.log("[Brainer][onTabActivated] tab already in active workspace or no active wsp — no action");
          return;
        }

        for (const workspace of workspaces) {
          if (workspace.tabs.includes(activeInfo.tabId)) {
            console.log("[Brainer][onTabActivated] tab", activeInfo.tabId,
              "belongs to workspace", workspace.id, workspace.name, "— activating");
            await WorkspaceService.activateWsp(workspace.id, activeInfo.windowId, activeInfo.tabId);
            return;
          }
        }
        console.log("[Brainer][onTabActivated] tab", activeInfo.tabId, "not found in any workspace");
      } catch (e) { console.error("[Workspaces] onTabActivated error:", e); }
    });

    // Cache tab info (url/title) for closed-tab tracking — must run unconditionally
    // (no state/window guards) so the cache is always warm when onRemoved fires.
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      TabService.cacheTabInfo(tab);
    }, {properties: ["url", "title"]});

    // Two separate onUpdated listeners exist because they use different filter
    // properties ("pinned" vs "groupId"). Firefox requires separate registrations
    // for distinct property filters.

    browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      try {
        console.log("[Brainer][onTabUpdated/pinned] tabId:", tabId,
          "pinned:", tab.pinned, "windowId:", tab.windowId, "state:", Brainer._state);
        if (Brainer._state !== 'ready') {
          console.log("[Brainer][onTabUpdated/pinned] skipped — state not ready");
          return;
        }
        const primaryId = await WSPStorageManager.getPrimaryWindowId();
        if (primaryId !== tab.windowId) {
          console.log("[Brainer][onTabUpdated/pinned] skipped — not primary window");
          return;
        }
        if (tab.pinned) {
          console.log("[Brainer][onTabUpdated/pinned] tab pinned — removing from workspace");
          await TabService.removeTabFromWorkspace(tab.windowId, tabId);
        } else {
          console.log("[Brainer][onTabUpdated/pinned] tab unpinned — adding to workspace");
          await TabService.addTabToWorkspace(tab);
        }
      } catch (e) { console.error("[Workspaces] onUpdated(pinned) error:", e); }
    }, {properties: ["pinned"]});

    browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      try {
        if (Brainer._state !== 'ready') return;
        const primaryId = await WSPStorageManager.getPrimaryWindowId();
        if (primaryId !== tab.windowId) return;
        if (!tab.hidden) {
          console.log("[Brainer][onTabUpdated/groupId] tabId:", tabId, "groupId changed — updating tab groups");
          const activeWsp = await WorkspaceService.getActiveWsp(tab.windowId);
          if (activeWsp) await activeWsp.updateTabGroups();
        }
      } catch (e) { console.error("[Workspaces] onUpdated(groupId) error:", e); }
    }, {properties: ["groupId"]});

    browser.tabGroups.onUpdated.addListener(async (group) => {
      try {
        const primaryId = await WSPStorageManager.getPrimaryWindowId();
        if (primaryId !== group.windowId) return;
        console.log("[Brainer][onTabGroupsUpdated] groupId:", group.id,
          "windowId:", group.windowId, "title:", group.title);
        const activeWsp = await WorkspaceService.getActiveWsp(group.windowId);
        if (activeWsp) await activeWsp.updateTabGroups();
      } catch (e) { console.error("[Workspaces] onTabGroupsUpdated error:", e); }
    });
  }

  // ── Keyboard Shortcut Listeners (Tier 1) ──

  static _registerCommandListeners() {
    browser.commands.onCommand.addListener(async (command) => {
      try {
        console.log("[Brainer][onCommand] command:", command);
        const windowId = (await browser.windows.getCurrent()).id;
        const workspaces = await WorkspaceService.getOrderedWorkspaces(windowId);
        console.log("[Brainer][onCommand] windowId:", windowId, "workspaces:", workspaces.length);
        if (workspaces.length < 2) {
          console.log("[Brainer][onCommand] skipped — fewer than 2 workspaces");
          return;
        }

        const activeIdx = workspaces.findIndex(w => w.active);
        console.log("[Brainer][onCommand] activeIdx:", activeIdx,
          "active:", workspaces[activeIdx]?.name);
        if (activeIdx === -1) {
          console.log("[Brainer][onCommand] skipped — no active workspace");
          return;
        }

        if (command === "workspace-next") {
          const next = workspaces[(activeIdx + 1) % workspaces.length];
          console.log("[Brainer][onCommand] workspace-next ->", next.id, next.name);
          await WorkspaceService.activateWsp(next.id, windowId);
        } else if (command === "workspace-prev") {
          const prev = workspaces[(activeIdx - 1 + workspaces.length) % workspaces.length];
          console.log("[Brainer][onCommand] workspace-prev ->", prev.id, prev.name);
          await WorkspaceService.activateWsp(prev.id, windowId);
        } else {
          console.warn("[Brainer][onCommand] unknown command:", command);
        }
      } catch (e) { console.error("[Workspaces] onCommand error:", e); }
    });
  }
}

(async () => {
  await Brainer.initialize();
})();
