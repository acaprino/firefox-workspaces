// Orchestrator: init + listener registration only. All logic delegated to services.
class Brainer {
  // Lifecycle states: 'uninitialized' -> 'initializing' -> 'restoring' -> 'ready'
  // ('restoring' is skipped on the first-start / already-running path; the
  // state goes 'initializing' -> 'ready' directly there.)
  static _state = 'uninitialized';
  static _initStarted = false;
  static _lastFocusedWindowId = null;
  static _primaryWindowId = null;
  // Set when refuse-to-wipe trips; blocks _onWindowCreated and initialize from
  // re-entering the restore path on every new window the user opens during the
  // recovery banner. Cleared on successful restore or via acknowledge/giveUp.
  // In-memory only -- a fresh Firefox start naturally clears it.
  static _refuseToWipeActive = false;

  // Tabs that look like Firefox session-restore placeholders rather than real
  // user content. When refuse-to-wipe evaluates, these don't count as "live
  // tabs" -- otherwise a profile-corrupted restart that comes up with a single
  // about:newtab placeholder would bypass the guard (FMA2).
  static _PLACEHOLDER_URL_RE = /^about:(blank|newtab|home|sessionrestore)/i;

  // Set true the moment browser.runtime.onStartup fires. onStartup fires ONLY on
  // a real browser start (never on an extension reload), so it is the one
  // reliable "the browser just restarted" signal. The already-running init path
  // uses it to enable the URL-snapshot fallback, and onStartup itself uses it to
  // run a post-init repair if it fires after initialize() already settled.
  static _browserStarted = false;
  // Guards the onStartup-fired-after-ready repair so it runs at most once.
  static _postStartupRepairDone = false;

  static async getCachedPrimaryWindowId() {
    if (Brainer._primaryWindowId != null) return Brainer._primaryWindowId;
    Brainer._primaryWindowId = await WSPStorageManager.getPrimaryWindowId();
    return Brainer._primaryWindowId;
  }

  static async initialize() {
    Brainer._initStarted = true;
    // Fresh Firefox start: a previous session's refuse-to-wipe flag is in
    // memory only, but be explicit. Cleared again on successful restore.
    Brainer._refuseToWipeActive = false;
    // 'initializing' is a sub-state of 'uninitialized' that signals to event
    // handlers (notably onInstalled) that initialize() is in flight but has
    // not yet reached the restart-detect logic. Without this, an onInstalled
    // event that arrives during the ensureSchemaVersion await could race
    // _ensureDefaultWorkspace and create duplicate default workspaces.
    Brainer._state = 'initializing';
    try {
      console.log("[Brainer][initialize] starting — current state:", Brainer._state);
      // Register listeners BEFORE the schema-version await so any buffered
      // events fire against handlers that guard on _state. The handlers
      // themselves no-op while _state is 'initializing' or 'restoring'.
      this._registerWindowListeners();
      this._registerTabListeners();
      this._registerCommandListeners();
      MenuService.registerOmniboxListeners();
      await WSPStorageManager.ensureSchemaVersion();

      // Detect restart vs first-ever startup BEFORE _ensureDefaultWorkspace
      // to eliminate the race with onStartup event.
      let existingPrimary = await WSPStorageManager.getPrimaryWindowId();
      const lastId = await WSPStorageManager.getPrimaryWindowLastId();
      console.log("[Brainer][initialize] existingPrimary:", existingPrimary, "| lastId:", lastId);

      // Validate stored primaryWindowId still exists. After a non-clean shutdown,
      // storage may reference a window from a previous session that is now gone.
      // NOTE: TOCTOU limitation -- the window could close between this check and
      // subsequent use. This is a sub-millisecond race; onWindowRemoved provides
      // eventual consistency if it occurs.
      if (existingPrimary != null) {
        try {
          await browser.windows.get(existingPrimary);
        } catch {
          console.log("[Brainer][initialize] stored primaryWindowId", existingPrimary, "is stale -- clearing");
          await WSPStorageManager.removePrimaryWindowId();
          Brainer._primaryWindowId = null;
          existingPrimary = null;
        }
      }

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
          await new Promise(r => setTimeout(r, LIMITS.RESTORE_DELAY_MS));
          await Brainer._reconcileLateTabs(currentWindow.id);
        } catch (e) {
          Brainer._state = 'uninitialized';
          console.error("[Brainer][initialize] restore failed — state reset to uninitialized:", e);
          throw e;
        }
      } else {
        console.log("[Brainer][initialize] first-start or already-running path");
        await this._ensureDefaultWorkspace();
        // Repair tab->workspace assignments. After a non-clean shutdown (crash,
        // kill, power loss) the restart is not detected because onWindowRemoved
        // never fired, so we are on this path even though the browser actually
        // restarted. Firefox reuses tab IDs from low numbers across sessions, so
        // stored arrays now point to DIFFERENT restored tabs. _repairTabAssignments
        // re-files every open tab by its session value (and, when a restart is
        // confirmed, by URL snapshot). No-op on a genuine already-running reload.
        const pid = await WSPStorageManager.getPrimaryWindowId();
        if (pid) {
          await Brainer._repairTabAssignments(pid, Brainer._browserStarted);
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
      Brainer._primaryWindowId = primaryWindowId;
      console.log("[Brainer][initialize] primaryWindowId after init:", primaryWindowId);
      if (primaryWindowId) await TabService.warmTabInfoCache(primaryWindowId);

      await MenuService.refreshTabMenu();
      if (primaryWindowId) await UIService.updateToolbarButton(primaryWindowId);
      console.log("[Brainer][initialize] done — final state:", Brainer._state);
    } finally {
      // Always clear _initStarted, even on throw. Without this, any failure in
      // initialize() permanently blocks _onWindowCreated (which guards on
      // _initStarted && _state !== 'ready'), silently dropping all future
      // windows from workspace tracking until extension restart.
      Brainer._initStarted = false;
    }
  }

  // Shared initialization: ensure primary window and default workspace exist.
  // Callable from initialize() (legit, runs while _state === 'initializing')
  // and from event handlers (onInstalled, onStartup); the event-handler entry
  // points guard themselves on _initStarted / _state before calling.
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
      Brainer._primaryWindowId = currentWindow.id;

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
        // Skip while initialize() is still in flight (either the schema-check
        // await or the restart-detect window). initialize() will run
        // _ensureDefaultWorkspace itself once it reaches the right path.
        if (Brainer._state === 'restoring' || Brainer._state === 'initializing' || Brainer._initStarted) {
          console.log("[Brainer][onInstalled] skipped -- state:", Brainer._state, "initStarted:", Brainer._initStarted);
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
        // Record the restart signal FIRST so initialize()'s already-running path
        // can read it (it gates the URL-snapshot fallback). onStartup fires only
        // on a real browser start, never on an extension reload.
        Brainer._browserStarted = true;
        console.log("[Brainer][onStartup] fired -- state:", Brainer._state);

        // initialize() is still in flight (or restoring): it will see
        // _browserStarted and handle the repair itself. Nothing to do here.
        if (Brainer._initStarted || Brainer._state === 'initializing' || Brainer._state === 'restoring') {
          console.log("[Brainer][onStartup] deferring to in-flight initialize()");
          return;
        }

        // initialize() already settled into 'ready'. If it took the
        // already-running path it may have trusted reused tab IDs before this
        // restart signal was available. Run the repair once, now that onStartup
        // confirms a genuine browser restart. Wrap in 'restoring' so live tab
        // events no-op during the show/hide. The repair is idempotent and a
        // no-op when assignments already match session values.
        if (Brainer._state === 'ready') {
          if (Brainer._postStartupRepairDone) {
            console.log("[Brainer][onStartup] post-startup repair already done -- skipping");
            return;
          }
          Brainer._postStartupRepairDone = true;
          const pid = await WSPStorageManager.getPrimaryWindowId();
          if (pid) {
            console.log("[Brainer][onStartup] running post-init repair for windowId:", pid);
            Brainer._state = 'restoring';
            try {
              await Brainer._repairTabAssignments(pid, true);
            } finally {
              Brainer._state = 'ready';
            }
          }
          return;
        }

        // state is 'uninitialized': original fallback for the restore path.
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
          console.log("[Brainer][onWindowRemoved] primary window closed — flushing last active tab, clearing primary, saving lastId");
          await WorkspaceService.flushLastActiveTab();
          await WSPStorageManager.removePrimaryWindowId();
          Brainer._primaryWindowId = null;
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
    // Fast-exit guards BEFORE the expensive stringified log (minor perf win
    // on non-primary window creation, more importantly avoids misleading
    // "looks like we processed it" log entries for skipped paths).
    if (Brainer._state === 'restoring' || Brainer._state === 'initializing') {
      console.log("[Brainer][_onWindowCreated] windowId:", window.id, "skipped -- state is", Brainer._state);
      return;
    }
    // If initialize() is running but hasn't reached the restart detection yet,
    // defer to it. Without this guard, both _onWindowCreated and initialize()
    // can race to restore workspaces, potentially creating duplicate entries.
    if (Brainer._initStarted && Brainer._state !== 'ready') {
      console.log("[Brainer][_onWindowCreated] windowId:", window.id, "skipped — initialize() still running");
      return;
    }
    // Refuse-to-wipe is active: don't retry the restore against a brand-new
    // (likely empty) window. The user must dismiss the banner or restart
    // Firefox. Without this guard, every new window would re-trigger the
    // failed restore against a target with no real content.
    if (Brainer._refuseToWipeActive) {
      console.log("[Brainer][_onWindowCreated] windowId:", window.id, "skipped -- refuse-to-wipe active");
      return;
    }
    console.log("[Brainer][_onWindowCreated] windowId:", window.id, "state:", Brainer._state,
      "initStarted:", Brainer._initStarted);

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
        await new Promise(r => setTimeout(r, LIMITS.RESTORE_WINDOW_DELAY_MS));
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

    // ── Phase 1: read everything we need into memory. NO writes yet. ──
    const newTabs = await browser.tabs.query({windowId: window.id});
    console.log("[Brainer][_restoreWorkspaces] tabs in window:", newTabs.length);

    const sessionMap = new Map();
    await Promise.all(newTabs.map(async (tab) => {
      try {
        const wspId = await browser.sessions.getTabValue(tab.id, "wspId");
        if (wspId) sessionMap.set(tab.id, wspId);
      } catch (e) {
        console.debug("[Brainer] session lookup failed for tab", tab.id, ":", e.message);
      }
    }));

    const unpinnedCount = newTabs.filter(t => !t.pinned).length;
    console.log(`[Workspaces] Restore: ${sessionMap.size}/${unpinnedCount} tabs have session values`);

    const oldWindowId = await WSPStorageManager.getPrimaryWindowLastId();
    const oldWorkspaces = await WSPStorageManager.getWorkspaces(oldWindowId);
    const oldOrder = await WSPStorageManager.getWorkspaceOrder(oldWindowId);

    console.log(`[Workspaces] Restore: found ${oldWorkspaces.length} workspaces for window ${oldWindowId}`);
    console.log("[Brainer][_restoreWorkspaces] old workspace names:", oldWorkspaces.map(w => w.name));

    let wspData = oldWorkspaces.map(wsp => ({
      id: wsp.id,
      name: wsp.name,
      icon: wsp.icon || "",
      active: wsp.active,
      groups: wsp.groups,
      containerId: wsp.containerId ?? null,
      lastActiveTabId: wsp.lastActiveTabId ?? null,
      lastActiveTabUrl: wsp.lastActiveTabUrl ?? null,
      color: wsp.color ?? null,
      tabSnapshot: wsp.tabSnapshot ?? []
    }));

    // If storage was wiped (extension reinstall) but session values still reference
    // workspace IDs, reconstruct stubs so tabs don't collapse into a single default.
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

    // ── Phase 2: compute tab → workspace assignments in-memory. NO writes yet. ──
    const wspIdSet = new Set(wspData.map(w => w.id));
    const assigned = new Map();          // wspId -> tabId[]
    const untaggedTabs = [];

    for (const tab of newTabs) {
      if (tab.pinned) continue;
      const wspId = sessionMap.get(tab.id);
      if (wspId && wspIdSet.has(wspId)) {
        if (!assigned.has(wspId)) assigned.set(wspId, []);
        assigned.get(wspId).push(tab.id);
      } else {
        if (wspId) console.warn(`[Workspaces] Restore: session value ${wspId} not in wspData (${wspData.length} workspaces)`);
        untaggedTabs.push(tab);
      }
    }

    // URL-based fallback for untagged tabs (session API can drop values across restart).
    const unmatchedTabs = [];
    if (untaggedTabs.length > 0) {
      console.warn(`[Workspaces] Restore: ${untaggedTabs.length} untagged tab(s) — trying URL snapshot fallback`);
      const snapshotByWsp = new Map();
      for (const wsp of wspData) {
        if (wsp.tabSnapshot.length > 0) snapshotByWsp.set(wsp.id, [...wsp.tabSnapshot]);
      }
      for (const tab of untaggedTabs) {
        let matchedWspId = null;
        for (const [wspId, urls] of snapshotByWsp) {
          const idx = urls.indexOf(tab.url);
          if (idx !== -1) { matchedWspId = wspId; urls.splice(idx, 1); break; }
        }
        if (matchedWspId) {
          if (!assigned.has(matchedWspId)) assigned.set(matchedWspId, []);
          assigned.get(matchedWspId).push(tab.id);
        } else {
          unmatchedTabs.push(tab);
        }
      }
    }

    const totalAssigned = [...assigned.values()].reduce((n, a) => n + a.length, 0);
    const hadRecoverableData = wspData.some(w => w.tabSnapshot.length > 0);
    console.log("[Brainer][_restoreWorkspaces] in-memory assignment:",
      [...assigned.entries()].map(([id, tabs]) => `${id.slice(0,8)}:${tabs.length}`).join(" "),
      `unmatched=${unmatchedTabs.length} totalAssigned=${totalAssigned} hadRecoverable=${hadRecoverableData}`);

    // ── Phase 3: refuse-to-wipe guard. ──
    // The failure mode that lost the user's data was: tabs.query ran before
    // Firefox finished session-restoring tabs, so Phase 1 saw 0 (or a single
    // about:newtab) and Phase 4 recreated every workspace empty. We refuse
    // when (a) we have workspaces with snapshot URLs to potentially restore,
    // (b) zero session-tagged tabs got assigned, AND (c) no real content tabs
    // are live in the window. Placeholder tabs (about:newtab etc.) do NOT
    // count as live content -- otherwise FMA2 (placeholder-only restart)
    // bypasses the guard.
    const liveContentTabs = newTabs.filter(t => !t.pinned && t.url && !Brainer._PLACEHOLDER_URL_RE.test(t.url));
    if (wspData.length > 0 && totalAssigned === 0 && liveContentTabs.length === 0 && hadRecoverableData) {
      const errorPayload = {
        when: Date.now(),
        reason: "refuse-to-wipe",
        oldWindowId,
        newWindowId: window.id,
        wspCount: wspData.length,
        snapshotUrlCount: wspData.reduce((n, w) => n + w.tabSnapshot.length, 0),
        liveTabCount: newTabs.length,
        liveContentTabCount: liveContentTabs.length,
        unmatchedTabCount: unmatchedTabs.length,
        sessionTaggedCount: sessionMap.size,
      };
      // Log first so the diagnostic survives even if storage is full.
      console.error("[Brainer][_restoreWorkspaces] REFUSE-TO-WIPE -- aborting restore. payload:", JSON.stringify(errorPayload));
      // Surface as banner. Storage failure here is not fatal; we still throw.
      try { await WSPStorageManager.setLastRestoreError(errorPayload); }
      catch (writeErr) { console.error("[Brainer][_restoreWorkspaces] failed to surface refuse-to-wipe banner:", writeErr); }
      Brainer._refuseToWipeActive = true;
      throw new Error(
        `Refuse-to-wipe: would recreate ${wspData.length} workspaces with 0 tabs ` +
        `while ${errorPayload.snapshotUrlCount} snapshot URLs exist; user data left untouched.`
      );
    }

    // ── Phase 4: writes. From here on we mutate storage. Wrapped in a single
    // try/catch so a partial commit surfaces as a banner instead of silently
    // leaving primaryWindowId / primaryWindowLastId in a desynced state.
    // primaryWindowId is set as the LAST write of Phase 4 (paired with
    // removePrimaryWindowLastId) so a mid-Phase-4 throw leaves the
    // pre-restart `existingPrimary == null && lastId != null` retry signal
    // intact for the next start.
    try {
      console.log("[Brainer][_restoreWorkspaces] writing", wspData.length, "workspaces for new windowId:", window.id);
      for (const wsp of wspData) {
        await Workspace.create(wsp.id, {
          ...wsp,
          tabs: assigned.get(wsp.id) || [],
          windowId: window.id
        });
      }

      if (oldOrder) {
        console.log("[Brainer][_restoreWorkspaces] migrating workspace order:", oldOrder);
        await WSPStorageManager.saveWorkspaceOrder(window.id, oldOrder);
      }

      // Detach old window's metadata only. Per-workspace state was already
      // rewritten above, so we keep the shared `ld-wsp-{wspId}` and
      // `ld-wsp-closed-{wspId}` keys intact -- detachWindow only touches the
      // window-keyed indexes.
      if (oldWindowId != null && oldWindowId !== window.id) {
        console.log("[Brainer][_restoreWorkspaces] detaching old window metadata:", oldWindowId);
        await WSPStorageManager.detachWindow(oldWindowId);
      }

      // Truly unmatched tabs go to the active workspace via the normal entry point.
      for (const tab of unmatchedTabs) {
        console.log("[Brainer][_restoreWorkspaces] no URL match, adding to active workspace:", tab.url);
        if (await TabService.addTabToWorkspace(tab, { skipForceContainer: true })) {
          await browser.tabs.show(tab.id);
        }
      }

      // Re-tag all tabs with fresh session values + remap lastActiveTabId via URL.
      console.log("[Brainer][_restoreWorkspaces] re-tagging tabs with fresh session values");
      for (const wsp of wspData) {
        const wspObj = await WSPStorageManager.getWorkspace(wsp.id);
        console.log("[Brainer][_restoreWorkspaces] workspace:", wsp.name, "tabs:", wspObj.tabs.length, "active:", wsp.active);
        await Promise.all(
          wspObj.tabs.map(tabId => TabService.setTabSessionValue(tabId, wsp.id))
        );
        if (wspObj.tabs.length > 0) {
          if (!wspObj.lastActiveTabId || !wspObj.tabs.includes(wspObj.lastActiveTabId)) {
            let remapped = null;
            if (wsp.lastActiveTabUrl) {
              const wspTabSet = new Set(wspObj.tabs);
              const match = newTabs.find(t => wspTabSet.has(t.id) && t.url === wsp.lastActiveTabUrl);
              if (match) {
                remapped = match.id;
                console.log("[Brainer][_restoreWorkspaces] remapped lastActiveTabId via URL for", wsp.name,
                  "url:", wsp.lastActiveTabUrl, "-> tabId:", remapped);
              }
            }
            if (!remapped) {
              console.log("[Brainer][_restoreWorkspaces] lastActiveTabId stale for", wsp.name,
                "- falling back to first tab:", wspObj.tabs[0]);
            }
            wspObj.lastActiveTabId = remapped || wspObj.tabs[0];
            await wspObj._saveState();
          }
        }
      }

      const activeWspData = wspData.find(w => w.active);
      console.log("[Brainer][_restoreWorkspaces] active workspace:", activeWspData?.id, activeWspData?.name);
      if (activeWspData) {
        const activeWspObj = await WSPStorageManager.getWorkspace(activeWspData.id);
        await activeWspObj.activate();
        WorkspaceService._updateActiveCache(window.id, activeWspObj.tabs, activeWspObj.id);
      }

      await WorkspaceService.hideInactiveWspTabs(window.id, activeWspData ? activeWspData.id : null);

      // Final commit: claim primary, drop the retry signal, clear any banner.
      // If anything above threw, we never get here; the next restart will see
      // primaryWindowId still null and primaryWindowLastId still set, and the
      // restart-detect path retries from scratch.
      await WSPStorageManager.setPrimaryWindowId(window.id);
      Brainer._primaryWindowId = window.id;
      await WSPStorageManager.removePrimaryWindowLastId();
      await WSPStorageManager.clearLastRestoreError();
      Brainer._refuseToWipeActive = false;
      console.log("[Brainer][_restoreWorkspaces] done");
    } catch (e) {
      // Phase 4 failed mid-way. Surface as a banner so the user knows what
      // happened, and leave primaryWindowLastId set so the next restart can
      // retry from a clean slate.
      const errorPayload = {
        when: Date.now(),
        reason: "phase4-failure",
        oldWindowId,
        newWindowId: window.id,
        error: String(e?.message ?? e),
      };
      console.error("[Brainer][_restoreWorkspaces] Phase 4 threw -- payload:", JSON.stringify(errorPayload), "error:", e);
      try { await WSPStorageManager.setLastRestoreError(errorPayload); }
      catch (writeErr) { console.error("[Brainer][_restoreWorkspaces] failed to surface phase4 banner:", writeErr); }
      Brainer._refuseToWipeActive = true;
      throw e;
    }
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

  // Source-of-truth repair for the "already-running" init path.
  //
  // onWindowRemoved is unreliable at shutdown: non-clean exits (crash, kill,
  // power loss) never fire it, and even a clean quit may not flush the async
  // handler before the process dies. When it doesn't fire, primaryWindowId is
  // never cleared, so the next *browser restart* is misread as "already
  // running" and we trust the stored per-workspace tab-ID arrays. But a restart
  // reassigns tab IDs starting from low numbers, so those stored IDs now point
  // to DIFFERENT restored tabs -- every workspace keeps its size while its
  // contents are scrambled (the "all tabs in the wrong workspace" bug). The
  // per-tab session value ("wspId") is the one mapping Firefox preserves
  // correctly across restart, so we re-file every open tab by it.
  //
  // On a genuine already-running reload (browser never restarted) the session
  // values already agree with the stored arrays, so this detects no change and
  // returns false without writing -- zero disruption to the common case.
  // Returns true iff it rewrote any workspace's tab list.
  // `restartLikely` enables the URL-snapshot fallback for tabs whose session
  // value Firefox dropped across the restart. It is also implied whenever a
  // session-tagged tab is found filed under the wrong workspace (positive proof
  // of an undetected restart). The fallback is gated this way so a normal reload
  // -- where a legacy untagged tab's URL might coincidentally appear in another
  // workspace's snapshot -- never moves a correctly-placed tab.
  static async _reconcileFromSessionValues(windowId, restartLikely = false) {
    const tabs = await browser.tabs.query({ windowId, pinned: false });
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    if (workspaces.length === 0) return false;
    const wspIds = new Set(workspaces.map(w => w.id));

    // Where each open tab is currently filed per the stored arrays (first
    // occurrence wins; an ID in two arrays is itself corruption we collapse).
    const filedUnder = new Map();
    for (const w of workspaces) {
      for (const id of w.tabs) {
        if (!filedUnder.has(id)) filedUnder.set(id, w.id);
      }
    }

    // Read the session value (authoritative across restart) for every open tab.
    const sessionOf = new Map();
    await Promise.all(tabs.map(async (t) => {
      try {
        const sv = await browser.sessions.getTabValue(t.id, "wspId");
        if (sv && wspIds.has(sv)) sessionOf.set(t.id, sv);
      } catch (e) {
        console.debug("[Brainer][_reconcileFromSessionValues] session lookup failed for tab", t.id, ":", e.message);
      }
    }));

    // Positive proof of an undetected restart: a session-tagged tab whose ID is
    // filed under a different workspace than its session value names.
    let corruptionDetected = false;
    for (const [id, sv] of sessionOf) {
      if (filedUnder.get(id) !== sv) { corruptionDetected = true; break; }
    }
    const useUrlFallback = restartLikely || corruptionDetected;

    // Desired workspace per open tab.
    //  - session-tagged  -> its session value (authoritative)
    //  - untagged + restart -> first matching workspace URL snapshot, else its
    //    current home
    //  - untagged + normal  -> its current home (never moved)
    // Tabs with neither a session value nor a stored home are left for
    // _reconcileLateTabs to assign to the active workspace.
    const desiredOf = new Map();
    const needsTag = []; // [tabId, wspId] for tabs we assign that had no session value
    for (const [id, sv] of sessionOf) desiredOf.set(id, sv);

    const snapshotByWsp = new Map();
    if (useUrlFallback) {
      for (const w of workspaces) {
        if (w.tabSnapshot && w.tabSnapshot.length > 0) snapshotByWsp.set(w.id, [...w.tabSnapshot]);
      }
    }
    for (const t of tabs) {
      if (sessionOf.has(t.id)) continue;
      let target = null;
      if (useUrlFallback && t.url) {
        for (const [wspId, urls] of snapshotByWsp) {
          const idx = urls.indexOf(t.url);
          if (idx !== -1) { target = wspId; urls.splice(idx, 1); break; }
        }
      }
      if (!target && filedUnder.has(t.id)) target = filedUnder.get(t.id);
      if (target) {
        desiredOf.set(t.id, target);
        needsTag.push([t.id, target]);
      }
    }

    // Change detection: any tab whose desired home differs from its current one,
    // or any tab filed under more than one workspace.
    let changed = false;
    for (const [tabId, want] of desiredOf) {
      if (filedUnder.get(tabId) !== want) { changed = true; break; }
    }
    if (!changed) {
      const seen = new Set();
      for (const w of workspaces) {
        for (const id of w.tabs) {
          if (!desiredOf.has(id)) continue;
          if (seen.has(id)) { changed = true; break; }
          seen.add(id);
        }
        if (changed) break;
      }
    }
    if (!changed) {
      console.log("[Brainer][_reconcileFromSessionValues] arrays agree with session values -- no change");
      return false;
    }

    // Rebuild each workspace's tab list from desiredOf, preserving order: first
    // keep tabs in their existing per-workspace order, then append any tab that
    // moved in, ordered by its position in the live tab list.
    const nextByWsp = new Map(workspaces.map(w => [w.id, []]));
    const placed = new Set();
    for (const w of workspaces) {
      for (const id of w.tabs) {
        const want = desiredOf.get(id);
        if (want === undefined || placed.has(id)) continue;
        nextByWsp.get(want).push(id);
        placed.add(id);
      }
    }
    for (const t of tabs) {
      const want = desiredOf.get(t.id);
      if (want === undefined || placed.has(t.id)) continue;
      nextByWsp.get(want).push(t.id);
      placed.add(t.id);
    }

    const summary = [];
    for (const w of workspaces) {
      const next = nextByWsp.get(w.id) || [];
      const same = next.length === w.tabs.length && next.every((id, i) => id === w.tabs[i]);
      if (same) { summary.push(`${w.name}:${next.length}`); continue; }
      const movedIn = next.filter(id => filedUnder.get(id) !== w.id).length;
      const fresh = await WSPStorageManager.getWorkspace(w.id);
      fresh.tabs = next;
      // Group membership is rebuilt on activate; just drop IDs that left.
      const nextSet = new Set(next);
      for (const g of fresh.groups) g.tabs = g.tabs.filter(id => nextSet.has(id));
      await fresh._saveState();
      summary.push(`${w.name}:${next.length}(+${movedIn})`);
    }

    // Re-tag tabs that had no (valid) session value so the NEXT restart is clean
    // even if it is also undetected. Only the assigned ones; truly untracked
    // tabs are left for _reconcileLateTabs.
    if (needsTag.length > 0) {
      await Promise.all(needsTag.map(([id, w]) => TabService.setTabSessionValue(id, w)));
      console.log("[Brainer][_reconcileFromSessionValues] re-tagged", needsTag.length, "untagged tabs with session values");
    }

    console.warn("[Brainer][_reconcileFromSessionValues] repaired tab assignments after undetected restart (urlFallback=" + useUrlFallback + ") --",
      summary.join(" "));
    return true;
  }

  // Full repair sequence for the already-running init path (and the
  // onStartup-fired-after-ready safety net): drop stale IDs, re-file open tabs
  // by session value (and URL snapshot when a restart is likely), assign any
  // leftovers, then re-apply visibility if anything moved. Idempotent: a no-op
  // when assignments already match session values.
  static async _repairTabAssignments(windowId, restartLikely = false) {
    await Brainer._cleanStaleTabIds(windowId);
    const corrected = await Brainer._reconcileFromSessionValues(windowId, restartLikely);
    await Brainer._reconcileLateTabs(windowId);
    if (corrected) {
      const active = await WorkspaceService.getActiveWsp(windowId);
      if (active) {
        const activeObj = await WSPStorageManager.getWorkspace(active.id);
        await activeObj.activate();
        WorkspaceService._updateActiveCache(windowId, activeObj.tabs, activeObj.id);
      }
      await WorkspaceService.hideInactiveWspTabs(windowId, active ? active.id : null);
    }
    return corrected;
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
      try { wspId = await browser.sessions.getTabValue(tab.id, "wspId"); }
      catch (e) { console.debug("[Brainer][_reconcileLateTabs] session lookup failed for tab", tab.id, ":", e.message); }
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
      // Keep tabSnapshot fresh for restart resilience (IC3) -- this site
      // mutates tabs[] without going through TabService.addTabToWorkspace.
      TabService._scheduleSnapshotRefresh(windowId, wspId);
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
      // Keep tabSnapshot fresh for restart resilience (IC3).
      TabService._scheduleSnapshotRefresh(windowId, activeWsp.id);
      console.log("[Brainer][_reconcileLateTabs] assigned", noSession.length, "untagged tabs to active workspace");
    }

    if (toHide.length > 0) {
      try { await browser.tabs.hide(toHide); }
      catch (e) { console.debug("[Brainer][_reconcileLateTabs] tabs.hide failed:", e.message); }
      try { await browser.tabs.ungroup(toHide); }
      catch (e) { console.debug("[Brainer][_reconcileLateTabs] tabs.ungroup failed:", e.message); }
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
        const primaryId = await Brainer.getCachedPrimaryWindowId();
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
        const primaryId = await Brainer.getCachedPrimaryWindowId();
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
          // Persist lastActiveTabId/Url so shutdown captures the correct tab.
          // Fire-and-forget to avoid slowing down tab switches.
          WorkspaceService.updateLastActiveTab(activeInfo.windowId, activeInfo.tabId);
          console.log("[Brainer][onTabActivated] fast-path hit - tab in active workspace, no action");
          return;
        }

        const workspaces = await WSPStorageManager.getWorkspaces(activeInfo.windowId);
        const activeWsp = workspaces.find(wsp => wsp.active);
        console.log("[Brainer][onTabActivated] activeWsp:", activeWsp?.id, activeWsp?.name,
          "tabs:", activeWsp?.tabs.length);

        if (!activeWsp || activeWsp.tabs.includes(activeInfo.tabId)) {
          if (activeWsp) {
            WorkspaceService.updateLastActiveTab(activeInfo.windowId, activeInfo.tabId);
          }
          console.log("[Brainer][onTabActivated] tab already in active workspace or no active wsp - no action");
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
    // Also schedule a debounced tabSnapshot refresh when a URL changes inside the
    // active workspace, so restart resilience doesn't depend on the user
    // activate/deactivate-cycling each workspace.
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      TabService.cacheTabInfo(tab);
      if (Brainer._state !== 'ready' || changeInfo.url == null) return;
      const cache = WorkspaceService._activeCache;
      if (!cache || cache.windowId !== tab.windowId || !cache.tabIds.has(tabId)) return;
      const activeWspId = cache.activeWspId;
      if (activeWspId) TabService._scheduleSnapshotRefresh(tab.windowId, activeWspId);
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
        const primaryId = await Brainer.getCachedPrimaryWindowId();
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
        const primaryId = await Brainer.getCachedPrimaryWindowId();
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
        const primaryId = await Brainer.getCachedPrimaryWindowId();
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
