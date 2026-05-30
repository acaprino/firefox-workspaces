// Tab add/remove/move/search/previews, closed tabs, sessions
// NOTE: TabService and WorkspaceService have a bidirectional dependency.
// TabService calls WorkspaceService for workspace CRUD (destroyWsp, activateWsp,
// hideInactiveWspTabs, _buildDefaultWspData, createWorkspace, getOrderedWorkspaces).
// WorkspaceService calls TabService for tab operations (setTabSessionValue,
// addTabToWorkspace). Both are singletons loaded in the same MV2 scope.
class TabService {
  // Lightweight in-memory cache of tab info (url, title, favIconUrl) for closed-tab tracking.
  // Populated by onCreated/onUpdated, consumed by saveClosedTabInfo (which fires AFTER the
  // tab is removed, so browser.tabs.get() no longer works).
  static _tabInfoCache = new Map();

  // Per-tab guard: IDs of tabs created by _reopenInContainer that should NOT be
  // auto-assigned by onCreated. Used by moveTabToWsp (trackId=true path), which
  // handles the new tab manually. NOT populated by addTabToWorkspace (trackId=false),
  // which relies on onCreated to assign the correctly-containerized tab.
  static _forceReopenIds = new Set();
  // Coarse phase guard: set by moveTabToWsp for the entire reopen window so that
  // even if onCreated fires before tabs.create() resolves (before the new tab ID
  // is in _forceReopenIds), it is still blocked from auto-assigning the tab.
  static _reopeningCount = 0;

  // Close a tab and reopen it in the specified container.
  // Returns the new tab, or null if the reopen failed (original tab kept).
  //
  // suppressOnCreated (default true): add the new tab ID to _forceReopenIds so that
  //   its onCreated event is suppressed. Use true when the caller manages workspace
  //   assignment manually (moveTabToWsp). Use false when onCreated SHOULD fire to
  //   assign the new tab to the workspace (addTabToWorkspace's force-container path).
  //
  // CONTRACT: callers passing suppressOnCreated=true MUST increment _reopeningCount
  //   before calling. Firefox can fire onCreated before tabs.create() resolves (before
  //   the new tab ID is in _forceReopenIds), so _reopeningCount > 0 is the only guard
  //   during that window. Not incrementing it re-introduces the race.
  // Verify a container ID is usable. Returns the container object if valid, null if stale/deleted.
  static async _verifyContainer(containerId) {
    try {
      const container = await browser.contextualIdentities.get(containerId);
      console.log("[TabService][_verifyContainer] containerId:", containerId, "-> valid:", container.name);
      return container;
    } catch (e) {
      console.debug("[TabService][_verifyContainer] containerId:", containerId, "-> not found (stale/deleted):", e.message);
      return null;
    }
  }

  static async _reopenInContainer(tab, containerId, { suppressOnCreated = true } = {}) {
    console.log("[TabService][_reopenInContainer] tabId:", tab.id,
      "containerId:", containerId, "suppressOnCreated:", suppressOnCreated,
      "url:", tab.url);
    // Pre-check: verify the container still exists before attempting tabs.create()
    if (!await TabService._verifyContainer(containerId)) {
      console.warn("[Workspaces] _reopenInContainer: container %s not found, skipping", containerId);
      return null;
    }

    const url = TabService._isUrlAllowed(tab.url) ? tab.url : undefined;
    const createOpts = { active: tab.active, windowId: tab.windowId, cookieStoreId: containerId };
    if (url) createOpts.url = url;
    console.log("[TabService][_reopenInContainer] creating tab with opts:", JSON.stringify(createOpts));
    try {
      const newTab = await browser.tabs.create(createOpts);
      if (suppressOnCreated) {
        TabService._forceReopenIds.add(newTab.id);
        console.log("[TabService][_reopenInContainer] suppressing onCreated for newTab:", newTab.id);
      }
      await browser.tabs.remove(tab.id);
      console.log("[TabService][_reopenInContainer] reopened: old tab", tab.id, "-> new tab", newTab.id);
      return newTab;
    } catch (e) {
      console.warn("[Workspaces] Force-container reopen failed, keeping original tab:", e.message);
      return null;
    }
  }

  // ── tabSnapshot refresh (resilience) ──
  //
  // tabSnapshot is the URL list per workspace consulted by _restoreWorkspaces
  // when the sessions API drops `wspId` tags across restart. Without a fresh
  // snapshot, restore can only fall back to "all tabs go to active workspace"
  // and inactive workspaces end up empty.
  //
  // Originally tabSnapshot was only written on activate/deactivate. For a
  // workspace the user hasn't touched in days, that means the snapshot is
  // stale. This scheduler refreshes the snapshot on every tab change inside
  // a workspace, debounced per (windowId, wspId) so a flurry of changes
  // collapses into one storage write.

  static _snapshotTimers = new Map(); // key: `${windowId}:${wspId}` -> timeout
  static _SNAPSHOT_DEBOUNCE_MS = 5000;

  static _scheduleSnapshotRefresh(windowId, wspId) {
    if (typeof windowId !== "number" || typeof wspId !== "string") return;
    const key = `${windowId}:${wspId}`;
    const existing = TabService._snapshotTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      TabService._snapshotTimers.delete(key);
      try {
        // Acquire the per-workspace lock so a concurrent
        // addTabToWorkspace/removeTabFromWorkspace doesn't get its tabs[]
        // change clobbered by our full-record _saveState here.
        await WSPStorageManager.withWorkspaceLock(wspId, async () => {
          const wsp = await WSPStorageManager.getWorkspace(wspId);
          // Workspace may have been destroyed or rebound to a new window
          // between schedule and fire. Either way, abort silently.
          if (!wsp || !wsp.id || wsp.windowId !== windowId) return;
          const tabs = await browser.tabs.query({ windowId, pinned: false });
          const tabMap = new Map(tabs.map(t => [t.id, t]));
          const fresh = wsp.tabs
            .map(id => tabMap.get(id))
            .filter(t => t && t.url)
            .map(t => t.url);
          // Avoid a redundant write if nothing changed
          const same = fresh.length === wsp.tabSnapshot.length
            && fresh.every((u, i) => u === wsp.tabSnapshot[i]);
          if (same) return;
          wsp.tabSnapshot = fresh;
          await wsp._saveState();
          console.log("[TabService][_scheduleSnapshotRefresh] refreshed wspId:", wspId,
            "windowId:", windowId, "URLs:", fresh.length);
        });
      } catch (e) {
        console.debug("[TabService][_scheduleSnapshotRefresh] failed:", e.message);
      }
    }, TabService._SNAPSHOT_DEBOUNCE_MS);
    TabService._snapshotTimers.set(key, timer);
  }

  // ── Sessions API helpers (Tier 1) ──

  static async setTabSessionValue(tabId, wspId) {
    try {
      await browser.sessions.setTabValue(tabId, "wspId", wspId);
      console.log("[TabService][setTabSessionValue] tabId:", tabId, "wspId:", wspId);
    } catch (e) {
      console.debug("[Workspaces] setTabSessionValue failed (tab may be closed):", tabId);
    }
  }

  static async addTabToWorkspace(tab, { skipForceContainer = false } = {}) {
    console.log("[TabService][addTabToWorkspace] tabId:", tab.id,
      "windowId:", tab.windowId, "cookieStoreId:", tab.cookieStoreId,
      "skipForceContainer:", skipForceContainer,
      "_reopeningCount:", TabService._reopeningCount,
      "inForceReopenIds:", TabService._forceReopenIds.has(tab.id));

    // Skip Firefox View and other special system tabs — never assign to workspaces
    if (tab.url?.startsWith("about:firefoxview")) {
      console.log("[TabService][addTabToWorkspace] skipped — Firefox View tab:", tab.url);
      return false;
    }

    // Skip tabs created by force-container reopen (_reopenInContainer).
    // Check _reopeningCount first: Firefox can fire onCreated before tabs.create()
    // resolves, so the ID may not be in _forceReopenIds yet.
    if (TabService._reopeningCount > 0 || TabService._forceReopenIds.has(tab.id)) {
      TabService._forceReopenIds.delete(tab.id);
      console.log("[TabService][addTabToWorkspace] skipped -- force-reopen guard (reopeningCount:", TabService._reopeningCount, "or forceReopenIds)");
      return false;
    }
    // Safety valve: clear stale entries that were never consumed (e.g. dropped onCreated events)
    if (TabService._forceReopenIds.size > LIMITS.FORCE_REOPEN_SAFETY_VALVE) {
      console.warn("[Workspaces] _forceReopenIds unexpectedly large, clearing");
      TabService._forceReopenIds.clear();
    }

    const workspaces = await WSPStorageManager.getWorkspaces(tab.windowId);
    const activeWsp = workspaces.find(wsp => wsp.active);
    console.log("[TabService][addTabToWorkspace] activeWsp:", activeWsp?.id, activeWsp?.name,
      "totalWorkspaces:", workspaces.length);

    if (activeWsp) {
      const alreadyAssigned = workspaces.find(wsp => wsp.tabs.includes(tab.id));
      if (!alreadyAssigned) {
        console.log("[TabService][addTabToWorkspace] tab not yet assigned — adding to active workspace:",
          activeWsp.id, activeWsp.name);

        // Session-value check: a tab may already belong to a specific workspace
        // (e.g., late session-restore tab arriving after extension restore completed).
        // Honour the session tag instead of blindly adding to the active workspace.
        let sessionWspId;
        try { sessionWspId = await browser.sessions.getTabValue(tab.id, "wspId"); }
        catch (e) { console.debug("[TabService][addTabToWorkspace] session lookup failed:", e.message); }
        if (sessionWspId && UUID_RE.test(sessionWspId) && sessionWspId !== activeWsp.id) {
          const targetWsp = workspaces.find(wsp => wsp.id === sessionWspId);
          if (targetWsp) {
            console.log("[TabService][addTabToWorkspace] session value points to workspace:",
              sessionWspId, "- honouring instead of active workspace");
            const freshTarget = await WSPStorageManager.getWorkspace(sessionWspId);
            if (!freshTarget.tabs.includes(tab.id)) {
              freshTarget.tabs.push(tab.id);
              await freshTarget._saveState();
            }
            if (freshTarget.active) {
              WorkspaceService._activeCache?.tabIds.add(tab.id);
            } else {
              try { await browser.tabs.hide(tab.id); }
              catch (e) { console.debug("[TabService][addTabToWorkspace] tabs.hide failed for tab", tab.id, ":", e.message); }
            }
            await TabService.setTabSessionValue(tab.id, sessionWspId);
            await MenuService.refreshTabMenu();
            await UIService.updateToolbarButton(tab.windowId);
            return false;
          }
        }

        // Force-container: if the workspace has a container, any new tab must match it.
        // suppressOnCreated=false so the new tab's onCreated fires normally and
        // re-enters addTabToWorkspace with a matching cookieStoreId, completing
        // workspace assignment. Returns false here; that re-entrant call does the work.
        // Skip for privileged about: URLs that can't be opened in containers.
        let clearContainerId = false;
        if (!skipForceContainer && activeWsp.containerId
            && tab.cookieStoreId !== activeWsp.containerId) {
          // Re-fetch tab to get its latest URL. Between onCreated and now there
          // have been multiple awaits; for flows like a bookmark click on
          // about:config Firefox can fire onCreated with a transient about:blank
          // and only set the privileged URL on the next tick. Using the stale
          // captured tab.url here would reopen the tab in the container and
          // drop the about:config destination, redirecting the user to the
          // new-tab page.
          let currentTab;
          try { currentTab = await browser.tabs.get(tab.id); }
          catch (e) {
            console.debug("[TabService][addTabToWorkspace] tab gone before reopen check:", e.message);
            return false;
          }
          if (TabService._canReopenInContainer(currentTab.url)) {
            console.log("[TabService][addTabToWorkspace] container mismatch — tab:", currentTab.cookieStoreId,
              "workspace wants:", activeWsp.containerId, "— reopening in container");
            const reopened = await TabService._reopenInContainer(currentTab, activeWsp.containerId, { suppressOnCreated: false });
            if (reopened) {
              console.log("[TabService][addTabToWorkspace] reopened — deferring to onCreated for new tab:", reopened.id);
              return false;
            }
            // Reopen failed (stale/deleted container). Clear containerId as part of
            // the freshWsp save below (single save) to avoid a concurrent
            // removeTabFromWorkspace overwriting a separate clear save.
            console.warn("[Workspaces] addTabToWorkspace: container %s unavailable for workspace %s, clearing",
              activeWsp.containerId, activeWsp.name);
            clearContainerId = true;
          } else {
            console.log("[TabService][addTabToWorkspace] container mismatch but URL not reopenable — keeping tab as-is:",
              currentTab.url);
          }
        }
        // Lock the workspace to prevent concurrent add/remove from overwriting each other
        await WSPStorageManager.withWorkspaceLock(activeWsp.id, async () => {
          const freshWsp = await WSPStorageManager.getWorkspace(activeWsp.id);
          if (clearContainerId) {
            console.log("[TabService][addTabToWorkspace] clearing stale containerId on workspace:", freshWsp.id);
            freshWsp.containerId = null;
          }
          if (!freshWsp.tabs.includes(tab.id)) {
            freshWsp.tabs.push(tab.id);
            await freshWsp._saveState();
            // Keep active-workspace cache consistent so onTabActivated fast-path stays accurate
            WorkspaceService._activeCache?.tabIds.add(tab.id);
            console.log("[TabService][addTabToWorkspace] tab", tab.id, "added to workspace",
              freshWsp.id, "| workspace now has", freshWsp.tabs.length, "tabs");
          } else {
            console.log("[TabService][addTabToWorkspace] tab", tab.id, "already in fresh workspace — no-op");
          }
        });
        await TabService.setTabSessionValue(tab.id, activeWsp.id);
        TabService._scheduleSnapshotRefresh(tab.windowId, activeWsp.id);
        await MenuService.refreshTabMenu();
        await UIService.updateToolbarButton(tab.windowId);
        return true;
      } else {
        console.log("[TabService][addTabToWorkspace] tab", tab.id,
          "already assigned to workspace:", alreadyAssigned.id, alreadyAssigned.name, "— no-op");
      }
    } else {
      // If workspaces exist but none is active (e.g. after destroying the active
      // workspace), activate the first one instead of creating a phantom workspace.
      if (workspaces.length > 0) {
        const targetWsp = workspaces[0];
        console.log("[TabService][addTabToWorkspace] no active workspace but", workspaces.length,
          "exist - activating first:", targetWsp.id, targetWsp.name);
        // Container mismatch: reopen first (the reopen onCreated re-enters
        // addTabToWorkspace with a fresh tab ID and will hit the active-wsp
        // path on the second pass — there is no double-assign risk here).
        if (targetWsp.containerId
            && tab.cookieStoreId !== targetWsp.containerId) {
          // Re-fetch tab so a transient about:blank / empty URL captured at
          // onCreated time doesn't trick us into reopening a tab that's
          // actually mid-navigation to a privileged about: URL.
          let currentTab;
          try { currentTab = await browser.tabs.get(tab.id); }
          catch (e) {
            console.debug("[TabService][addTabToWorkspace] tab gone before fallback reopen check:", e.message);
            return false;
          }
          if (TabService._canReopenInContainer(currentTab.url)) {
            console.log("[TabService][addTabToWorkspace] container mismatch in fallback path — reopening");
            await TabService._reopenInContainer(currentTab, targetWsp.containerId, { suppressOnCreated: false });
            return false;
          }
          console.log("[TabService][addTabToWorkspace] fallback path: URL not reopenable, keeping as-is:",
            currentTab.url);
        }
        // IMPORTANT: push the new tab into targetWsp's tab list BEFORE calling
        // activateWsp. Otherwise activateWsp's _updateActiveCache runs with a
        // stale tab list (missing our tab), and a concurrent onTabActivated
        // sees a cache miss until the post-activation patch below can run —
        // the old flow did this patch via _activeCache?.tabIds.add which was
        // a band-aid duplicating what activateWsp had already done internally.
        await WSPStorageManager.withWorkspaceLock(targetWsp.id, async () => {
          const freshActive = await WSPStorageManager.getWorkspace(targetWsp.id);
          if (!freshActive.tabs.includes(tab.id)) {
            freshActive.tabs.push(tab.id);
            await freshActive._saveState();
          }
        });
        await TabService.setTabSessionValue(tab.id, targetWsp.id);
        // Now activate: _updateActiveCache will pick up the fresh tab list
        // including our just-added tab in a single pass.
        await WorkspaceService.activateWsp(targetWsp.id, tab.windowId);
      } else {
        console.log("[TabService][addTabToWorkspace] no workspaces at all - creating default");
        const wsp = WorkspaceService._buildDefaultWspData(tab.windowId, [tab.id]);
        await WorkspaceService.createWorkspace(wsp);
        await TabService.setTabSessionValue(tab.id, wsp.id);
      }
    }
    return false;
  }

  // Search ALL workspaces for the tab, not just the active one
  static async removeTabFromWorkspace(windowId, tabId) {
    console.log("[TabService][removeTabFromWorkspace] tabId:", tabId, "windowId:", windowId);
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);

    for (const wsp of workspaces) {
      if (wsp.tabs.includes(tabId)) {
        console.log("[TabService][removeTabFromWorkspace] found tab", tabId,
          "in workspace:", wsp.id, wsp.name, "| before:", wsp.tabs.length, "tabs");
        // Lock the workspace to prevent concurrent add/remove from overwriting each other
        await WSPStorageManager.withWorkspaceLock(wsp.id, async () => {
          const freshWsp = await WSPStorageManager.getWorkspace(wsp.id);
          freshWsp.tabs = freshWsp.tabs.filter(id => id !== tabId);
          for (const group of freshWsp.groups) {
            group.tabs = group.tabs.filter(id => id !== tabId);
          }
          await freshWsp._saveState();
          // Keep active-workspace cache consistent
          WorkspaceService._activeCache?.tabIds.delete(tabId);
          console.log("[TabService][removeTabFromWorkspace] removed — workspace now has", freshWsp.tabs.length, "tabs");
        });
        TabService._scheduleSnapshotRefresh(windowId, wsp.id);
        await MenuService.refreshTabMenu();
        return;
      }
    }
    console.log("[TabService][removeTabFromWorkspace] tab", tabId, "not found in any workspace");
  }

  static async moveTabToWsp(tab, fromWspId, toWspId) {
    console.log("[TabService][moveTabToWsp] tabId:", tab.id,
      "fromWspId:", fromWspId, "toWspId:", toWspId,
      "tab.cookieStoreId:", tab.cookieStoreId, "tab.active:", tab.active);
    let effectiveTabId = tab.id;

    // Fresh-read both workspaces to avoid stale-snapshot overwrites
    const fromWsp = await WSPStorageManager.getWorkspace(fromWspId);
    const wasInSource = fromWsp.tabs.includes(tab.id);
    console.log("[TabService][moveTabToWsp] wasInSource:", wasInSource,
      "fromWsp tabs:", fromWsp.tabs.length);

    // Remove from source first (safer ordering to avoid dual-membership window)
    if (wasInSource) {
      fromWsp.tabs = fromWsp.tabs.filter(id => id !== tab.id);
      for (const group of fromWsp.groups) {
        group.tabs = group.tabs.filter(id => id !== tab.id);
      }
      await fromWsp._saveState();
      // Keep active-workspace cache consistent when moving OUT of active workspace
      WorkspaceService._activeCache?.tabIds.delete(tab.id);
      console.log("[TabService][moveTabToWsp] removed from source, fromWsp now has", fromWsp.tabs.length, "tabs");
    }

    // Force-container: reopen tab in destination's container if mismatched
    const toWsp = await WSPStorageManager.getWorkspace(toWspId);
    console.log("[Workspaces] moveTabToWsp: containerId=%s tab.cookieStoreId=%s",
      toWsp.containerId, tab.cookieStoreId);
    if (toWsp.containerId && tab.cookieStoreId !== toWsp.containerId
        && TabService._canReopenInContainer(tab.url)) {
      console.log("[TabService][moveTabToWsp] container mismatch -- reopening tab in:", toWsp.containerId);
      TabService._reopeningCount++;
      try {
        const newTab = await TabService._reopenInContainer(tab, toWsp.containerId); // suppressOnCreated=true (default)
        if (newTab) {
          effectiveTabId = newTab.id;
          console.log("[Workspaces] moveTabToWsp: reopened tab %d -> %d in container %s",
            tab.id, newTab.id, toWsp.containerId);
        } else {
          console.warn("[Workspaces] moveTabToWsp: reopen failed, keeping original tab");
        }
      } finally {
        TabService._reopeningCount--;
      }
    }

    // Fresh-read destination, then add (avoids overwriting concurrent changes)
    const freshToWsp = await WSPStorageManager.getWorkspace(toWspId);
    if (!freshToWsp.tabs.includes(effectiveTabId)) {
      freshToWsp.tabs.unshift(effectiveTabId);
      await freshToWsp._saveState();
      console.log("[TabService][moveTabToWsp] added tab", effectiveTabId,
        "to destination workspace:", toWspId, "| now has", freshToWsp.tabs.length, "tabs");
    } else {
      console.log("[TabService][moveTabToWsp] tab", effectiveTabId, "already in destination");
    }

    // Update session value to new workspace
    await TabService.setTabSessionValue(effectiveTabId, toWspId);
    TabService._scheduleSnapshotRefresh(freshToWsp.windowId, toWspId);
    if (wasInSource) TabService._scheduleSnapshotRefresh(fromWsp.windowId, fromWspId);

    if (wasInSource) {
      const sourceDestroyed = fromWsp.tabs.length === 0;
      console.log("[TabService][moveTabToWsp] sourceDestroyed:", sourceDestroyed,
        "tab.active:", tab.active);
      if (sourceDestroyed) {
        console.log("[TabService][moveTabToWsp] source workspace empty — destroying:", fromWspId);
        await WorkspaceService.destroyWsp(fromWspId);
      }
      if (tab.active) {
        console.log("[TabService][moveTabToWsp] active tab moved — activating destination workspace");
        await WorkspaceService.activateWsp(toWspId, freshToWsp.windowId, effectiveTabId);
      } else if (!sourceDestroyed) {
        console.log("[TabService][moveTabToWsp] inactive tab moved — hiding inactive tabs, activeWsp:", fromWspId);
        await WorkspaceService.hideInactiveWspTabs(freshToWsp.windowId, fromWspId);
      } else {
        const activeWsp = await WorkspaceService.getActiveWsp(freshToWsp.windowId);
        if (activeWsp) {
          console.log("[TabService][moveTabToWsp] source destroyed — hiding inactive tabs, activeWsp:", activeWsp.id);
          await WorkspaceService.hideInactiveWspTabs(freshToWsp.windowId, activeWsp.id);
        }
      }

      try { await browser.tabs.ungroup(effectiveTabId); }
      catch (e) { console.debug("[TabService][moveTabToWsp] tabs.ungroup failed for tab", effectiveTabId, ":", e.message); }
    }

    await MenuService.refreshTabMenu();
    console.log("[TabService][moveTabToWsp] done — effectiveTabId:", effectiveTabId,
      "now in workspace:", toWspId);
  }

  // ── Tab info cache helpers ──

  static _TAB_INFO_CACHE_MAX = 500;

  static cacheTabInfo(tab) {
    if (tab.url && tab.url !== "about:blank" && tab.url !== "about:newtab") {
      // Evict oldest entry (FIFO via Map insertion order) to prevent unbounded growth
      if (TabService._tabInfoCache.size >= TabService._TAB_INFO_CACHE_MAX
          && !TabService._tabInfoCache.has(tab.id)) {
        const firstKey = TabService._tabInfoCache.keys().next().value;
        TabService._tabInfoCache.delete(firstKey);
      }
      TabService._tabInfoCache.set(tab.id, {
        url: tab.url,
        title: tab.title || tab.url,
        favIconUrl: tab.favIconUrl || ""
      });
    }
  }

  // Pre-populate cache for all tabs in a window (called once at startup)
  static async warmTabInfoCache(windowId) {
    const tabs = await browser.tabs.query({ windowId });
    for (const tab of tabs) TabService.cacheTabInfo(tab);
    console.log("[TabService][warmTabInfoCache] windowId:", windowId, "cached", tabs.length, "tabs");
  }

  // ── Closed Tab helpers (Tier 2) ──

  static async saveClosedTabInfo(windowId, tabId) {
    // Use cached info — browser.tabs.get() fails in onRemoved because the tab is already gone
    console.log("[TabService][saveClosedTabInfo] tabId:", tabId, "windowId:", windowId,
      "inCache:", TabService._tabInfoCache.has(tabId));
    const cached = TabService._tabInfoCache.get(tabId);
    TabService._tabInfoCache.delete(tabId);

    if (!cached || !cached.url) {
      console.log("[TabService][saveClosedTabInfo] no cached info for tabId:", tabId, "— skipping");
      return;
    }

    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    const ownerWsp = workspaces.find(wsp => wsp.tabs.includes(tabId));
    if (!ownerWsp) {
      console.log("[TabService][saveClosedTabInfo] tab", tabId, "not found in any workspace — skipping");
      return;
    }

    console.log("[TabService][saveClosedTabInfo] saving closed tab:", cached.url,
      "to workspace:", ownerWsp.id, ownerWsp.name);
    await WSPStorageManager.saveClosedTab(ownerWsp.id, {
      url: cached.url,
      title: cached.title || cached.url,
      favIconUrl: cached.favIconUrl || "",
      closedAt: Date.now()
    });
  }

  static async getClosedTabs(wspId) {
    const tabs = await WSPStorageManager.getClosedTabs(wspId);
    console.log("[TabService][getClosedTabs] wspId:", wspId, "count:", tabs.length);
    return tabs;
  }

  static _isUrlAllowed(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "moz-extension:") {
        // Only allow this extension's own internal pages, not other extensions'
        return url.startsWith(browser.runtime.getURL(""));
      }
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (e) {
      console.debug("[TabService][_isUrlAllowed] URL parse failed:", url, ":", e.message);
      return false;
    }
  }

  // Check if a URL can be meaningfully reopened in a different container.
  //
  // Allow only:
  //  - about:newtab: Firefox's default new-tab URL. Reopening is fine because
  //    about:newtab is a generic blank state -- losing the URL during the
  //    close-reopen cycle just lands the user on... the same new-tab page in
  //    the container. This is required to make Ctrl+T behave as "open new
  //    tab in this workspace's container".
  //  - URLs _isUrlAllowed accepts (http/https/own moz-extension): preservable
  //    verbatim across the reopen via tabs.create({url}).
  //
  // Internal Firefox pages (about:config, about:preferences, about:addons,
  // about:debugging, about:profiles, about:home, about:performance, ...,
  // plus chrome://, resource://, view-source:, javascript:, etc.) cannot be
  // set via tabs.create({url}) -- they require chrome privileges -- so
  // reopening would silently drop the destination URL and land the user on
  // the new-tab page. They MUST stay in their original (default) container.
  //
  // Null/undefined/empty/about:blank are NOT in the allowlist either: those
  // are transient states for tabs whose final URL is not yet known (e.g.,
  // a bookmark click on about:config that briefly shows about:blank in
  // onCreated before navigating). Reopening such tabs would race the
  // navigation and drop the destination URL.
  static _canReopenInContainer(url) {
    if (url === "about:newtab") return true;
    return TabService._isUrlAllowed(url);
  }

  static async restoreClosedTab(wspId, index, windowId) {
    console.log("[TabService][restoreClosedTab] wspId:", wspId, "index:", index, "windowId:", windowId);
    const closedTabs = await WSPStorageManager.getClosedTabs(wspId);
    if (!Number.isInteger(index) || index < 0 || index >= closedTabs.length) {
      console.warn("[TabService][restoreClosedTab] invalid index:", index, "closedTabs.length:", closedTabs.length);
      return null;
    }

    const tabInfo = closedTabs[index];
    console.log("[TabService][restoreClosedTab] restoring:", tabInfo.url);

    if (!TabService._isUrlAllowed(tabInfo.url)) {
      console.warn("[Workspaces] Blocked restore of disallowed URL scheme:", tabInfo.url);
      await WSPStorageManager.removeClosedTab(wspId, index);
      return null;
    }

    const createOpts = { url: tabInfo.url, windowId };

    // Respect workspace container if set
    const wspState = await WSPStorageManager.getWspState(wspId);
    if (wspState && wspState.containerId) {
      createOpts.cookieStoreId = wspState.containerId;
      console.log("[TabService][restoreClosedTab] using container:", wspState.containerId);
    }

    await browser.tabs.create(createOpts);
    await WSPStorageManager.removeClosedTab(wspId, index);
    console.log("[TabService][restoreClosedTab] done — restored:", tabInfo.url);
    return tabInfo;
  }

  static async clearClosedTabs(wspId) {
    console.log("[TabService][clearClosedTabs] wspId:", wspId);
    await WSPStorageManager.clearClosedTabs(wspId);
  }

  // ── Search helpers (Tier 3) ──

  // Check if a tab matches a search query (used by both omnibox and searchTabs)
  static _matchesQuery(tab, lowerQuery) {
    return (tab.title && tab.title.toLowerCase().includes(lowerQuery)) ||
           (tab.url && tab.url.toLowerCase().includes(lowerQuery));
  }

  static async searchTabs(query, windowId) {
    console.log("[TabService][searchTabs] query:", JSON.stringify(query), "windowId:", windowId);
    const workspaces = await WorkspaceService.getOrderedWorkspaces(windowId);
    const results = [];
    const lowerQuery = query.toLowerCase();

    // Batch-query all tabs for performance
    const allTabs = await browser.tabs.query({ windowId });
    const tabMap = new Map(allTabs.map(t => [t.id, t]));

    for (const wsp of workspaces) {
      for (const tabId of wsp.tabs) {
        const tab = tabMap.get(tabId);
        if (!tab) continue;
        if (TabService._matchesQuery(tab, lowerQuery)) {
          results.push({
            tabId: tab.id,
            title: tab.title || tab.url || "Untitled",
            url: tab.url,
            favIconUrl: tab.favIconUrl || "",
            wspId: wsp.id,
            wspName: wsp.name
          });
        }
      }
    }

    console.log("[TabService][searchTabs] found", results.length, "results for query:", JSON.stringify(query));
    return results;
  }

  // ── Tab preview helper (Tier 3) ──

  static async getTabPreviews(wspId, limit = 0) {
    console.log("[TabService][getTabPreviews] wspId:", wspId, "limit:", limit);
    const wsp = await WSPStorageManager.getWorkspace(wspId);
    const previews = [];
    const tabIds = limit > 0 ? wsp.tabs.slice(0, limit) : wsp.tabs;
    console.log("[TabService][getTabPreviews] fetching", tabIds.length, "tabs (total:", wsp.tabs.length, ")");

    const tabs = await Promise.all(
      tabIds.map(id => browser.tabs.get(id).catch(() => null))
    );

    for (const tab of tabs) {
      if (tab) previews.push(tab.title || tab.url || "Untitled");
    }

    console.log("[TabService][getTabPreviews] returning", previews.length, "previews");
    return { previews, total: wsp.tabs.length };
  }
}
