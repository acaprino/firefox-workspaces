// Tab add/remove/move/search/previews, closed tabs, sessions
// NOTE: TabService and WorkspaceService have a bidirectional dependency.
// TabService calls WorkspaceService for workspace CRUD (destroyWsp, activateWsp,
// hideInactiveWspTabs, _buildDefaultWspData, createWorkspace, getOrderedWorkspaces).
// WorkspaceService calls TabService for tab operations (setTabSessionValue,
// addTabToWorkspace). Both are singletons loaded in the same MV2 scope.
class TabService {
  // Lightweight in-memory cache of tab info (url, title, favIconUrl, groupId) for
  // closed-tab tracking. Populated by onCreated/onUpdated, taken by onRemoved
  // (takeTabInfo) for saveClosedTabInfo -- the tab is already gone by then, so
  // browser.tabs.get() no longer works.
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

  // Navigation-time force-container loop guard. forceTabIntoActiveContainer
  // records each URL it reopens here; if the same URL would be reopened again
  // within _FORCE_NAV_GUARD_MS, a conflicting rule (e.g. Multi-Account
  // Containers "always open this site in X") is fighting us, so we bail instead
  // of ping-ponging the tab between containers.
  static _forceNavGuard = new Map(); // url -> last forced timestamp (ms)
  static _FORCE_NAV_GUARD_MS = 4000;

  // Run `fn` with the coarse reopen guard held (see the _reopeningCount
  // contract below). Encapsulates the increment / finally-decrement pairing
  // so callers in other services don't reach into private state -- the
  // pairing used to be a comment-enforced convention across five call sites.
  static async withReopenGuard(fn) {
    TabService._reopeningCount++;
    try {
      return await fn();
    } finally {
      TabService._reopeningCount--;
    }
  }

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
        // Locked fresh read-modify-write (mutateWorkspace) so a concurrent
        // addTabToWorkspace/removeTabFromWorkspace doesn't get its tabs[]
        // change clobbered by our full-record save here. A destroyed
        // workspace is skipped there.
        await WSPStorageManager.mutateWorkspace(wspId, async (wsp) => {
          // Rebound to a new window between schedule and fire: abort.
          if (wsp.windowId !== windowId) return false;
          const tabs = await browser.tabs.query({ windowId, pinned: false });
          const tabMap = new Map(tabs.map(t => [t.id, t]));
          const fresh = wsp.tabs
            .map(id => tabMap.get(id))
            .filter(t => t && t.url)
            .map(t => t.url);
          // Avoid a redundant write if nothing changed
          const same = fresh.length === wsp.tabSnapshot.length
            && fresh.every((u, i) => u === wsp.tabSnapshot[i]);
          if (same) return false;
          // The window closed after this refresh was scheduled (another
          // window keeps Firefox running, or macOS with no window left): the
          // query found nothing, and writing that would replace the last
          // good snapshot -- restore's URL fallback and the session-loss
          // export -- with []. Never trade a member list for an empty one.
          if (fresh.length === 0 && wsp.tabs.length > 0) return false;
          try { await browser.windows.get(windowId); }
          catch { return false; }
          wsp.tabSnapshot = fresh;
          console.log("[TabService][_scheduleSnapshotRefresh] refreshed wspId:", wspId,
            "windowId:", windowId, "URLs:", fresh.length);
        });
      } catch (e) {
        console.debug("[TabService][_scheduleSnapshotRefresh] failed:", e.message);
      }
    }, TabService._SNAPSHOT_DEBOUNCE_MS);
    TabService._snapshotTimers.set(key, timer);
  }

  // Drop the pending refreshes of one window (its primary closed, or a
  // repair is about to rewrite its records). Returns the wspIds whose
  // refresh was dropped so a caller can re-arm them afterwards.
  static _cancelSnapshotRefreshes(windowId) {
    const cancelled = [];
    for (const [key, timer] of TabService._snapshotTimers) {
      const sep = key.indexOf(":");
      if (Number(key.slice(0, sep)) !== windowId) continue;
      clearTimeout(timer);
      TabService._snapshotTimers.delete(key);
      cancelled.push(key.slice(sep + 1));
    }
    if (cancelled.length > 0) {
      console.log("[TabService][_cancelSnapshotRefreshes] windowId:", windowId, "cancelled:", cancelled);
    }
    return cancelled;
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

  // Drop a tab's workspace tag. For tabs that leave workspace tracking while
  // staying open (pinned, moved to another window): a tag left behind would
  // later file the tab back into that workspace -- and hide it there.
  static async clearTabSessionValue(tabId) {
    try {
      await browser.sessions.removeTabValue(tabId, "wspId");
      console.log("[TabService][clearTabSessionValue] tabId:", tabId);
    } catch (e) {
      console.debug("[Workspaces] clearTabSessionValue failed (tab may be closed):", tabId);
    }
  }

  // ── Removed-tab ledger (short-lived tabs) ──
  // Ids of tabs Firefox reported closed, noted synchronously at the top of
  // onRemoved. An add still awaiting its reads when its tab closed checks
  // this under the workspace lock: the close found nothing to remove yet, so
  // the add used to leave a dead id in the workspace (badge, previews). Tab
  // ids are never reused within a session, so a bounded FIFO is enough.
  static _removedTabIds = new Set();
  static _REMOVED_IDS_MAX = 500;

  static noteTabRemoved(tabId) {
    const ids = TabService._removedTabIds;
    ids.add(tabId);
    if (ids.size > TabService._REMOVED_IDS_MAX) ids.delete(ids.values().next().value);
  }

  static wasRemoved(tabId) {
    return TabService._removedTabIds.has(tabId);
  }

  // Extension-initiated ungroup. A group emptied this way fires
  // tabGroups.onRemoved exactly like a group the user saved and closed, so
  // the time is remembered (see onTabGroupRemoved).
  static _ownUngroupAt = 0;
  static _OWN_UNGROUP_GRACE_MS = 1000;

  static async ungroup(tabIds) {
    TabService._ownUngroupAt = Date.now();
    await TabService._eachTab("ungroup", tabIds);
  }

  // tabs.hide / show / ungroup validate every id before acting on any. A tab
  // that is closing is still returned by tabs.query (it stays in the strip
  // while it animates closed) but its id is already invalid, so one such id
  // used to reject the whole call and leave every other tab of the pass as
  // it was: the previous workspace stayed on screen after a switch (X-104).
  // Ids noted closed are dropped up front, and a rejected batch is retried
  // tab by tab so one dead id cannot cancel the rest.
  // hideTabs resolves to the ids Firefox actually hid. It silently refuses
  // the selected tab, pinned tabs and tabs sharing camera, microphone or
  // screen (see the sharingState listener in Brainer, X-103).
  static async hideTabs(tabIds) {
    return TabService._eachTab("hide", tabIds);
  }

  static async showTabs(tabIds) {
    await TabService._eachTab("show", tabIds);
  }

  static async _eachTab(method, tabIds) {
    const ids = [].concat(tabIds).filter(id => !TabService.wasRemoved(id));
    if (ids.length === 0) return [];
    try {
      return (await browser.tabs[method](ids)) ?? [];
    } catch (e) {
      console.debug(`[TabService][_eachTab] tabs.${method} of ${ids.length} tab(s) failed (${e.message}) -- retrying tab by tab`);
      const results = await Promise.allSettled(ids.map(async id => browser.tabs[method](id)));
      return results.flatMap(r => (r.status === "fulfilled" ? [].concat(r.value ?? []) : []));
    }
  }

  // `ignoreSessionTag`: file into the active workspace even when the tab
  // carries another workspace's tag. For tabs the user just put in front of
  // them (unpinned, dragged in from another window): their tag predates
  // that and would hide them into a workspace they are not looking at.
  static async addTabToWorkspace(tab, { skipForceContainer = false, ignoreSessionTag = false } = {}) {
    console.log("[TabService][addTabToWorkspace] tabId:", tab.id,
      "windowId:", tab.windowId, "cookieStoreId:", tab.cookieStoreId,
      "skipForceContainer:", skipForceContainer, "ignoreSessionTag:", ignoreSessionTag,
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

    return TabService._fileTab(tab, { skipForceContainer, ignoreSessionTag });
  }

  // The filing part of addTabToWorkspace, after its reopen guards.
  // `afterHandoff`: internal, set on the re-run after a handoff settled.
  static async _fileTab(tab, { skipForceContainer = false, ignoreSessionTag = false, afterHandoff = false } = {}) {
    const workspaces = await WSPStorageManager.getWorkspaces(tab.windowId);
    // Two flagged active: an activation has brought its target up and not
    // yet stood the previous workspace down (X-29). Wait for it, as the
    // no-active branch below waits for a handoff.
    if (!afterHandoff && workspaces.filter(wsp => wsp.active).length > 1) {
      await WorkspaceService.whenActivationsSettled();
      return TabService._fileTab(tab, { skipForceContainer, ignoreSessionTag, afterHandoff: true });
    }
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
        if (!ignoreSessionTag) {
          try { sessionWspId = await browser.sessions.getTabValue(tab.id, "wspId"); }
          catch (e) { console.debug("[TabService][addTabToWorkspace] session lookup failed:", e.message); }
        }
        if (sessionWspId && UUID_RE.test(sessionWspId) && sessionWspId !== activeWsp.id
            && workspaces.some(wsp => wsp.id === sessionWspId)) {
          console.log("[TabService][addTabToWorkspace] session value points to workspace:",
            sessionWspId, "- honouring instead of active workspace");
          if (await TabService._fileUnderTaggedWorkspace(tab, sessionWspId)) return false;
          // Destroyed since the read above: file under the active workspace.
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
        // Locked fresh read-modify-write so concurrent add/remove cannot
        // overwrite each other; a workspace destroyed meanwhile is not
        // resurrected as a zombie record.
        let added = false;
        let gone = false;
        const filed = await WSPStorageManager.mutateWorkspace(activeWsp.id, (freshWsp) => {
          // Compare-and-clear: a concurrent setWorkspaceContainer to a
          // working container must survive.
          const clear = clearContainerId && freshWsp.containerId === activeWsp.containerId;
          if (clear) {
            console.log("[TabService][addTabToWorkspace] clearing stale containerId on workspace:", freshWsp.id);
            freshWsp.containerId = null;
          }
          // Closed while this add awaited its reads: its onRemoved already
          // ran against a list without it, so pushing now leaves a dead id.
          if (TabService.wasRemoved(tab.id)) {
            gone = true;
            return clear;
          }
          if (freshWsp.tabs.includes(tab.id)) {
            console.log("[TabService][addTabToWorkspace] tab", tab.id, "already in fresh workspace -- no-op");
            return clear;
          }
          freshWsp.tabs.push(tab.id);
          added = true;
          console.log("[TabService][addTabToWorkspace] tab", tab.id, "added to workspace",
            freshWsp.id, "| workspace now has", freshWsp.tabs.length, "tabs");
        });
        if (!filed) {
          console.log("[TabService][addTabToWorkspace] workspace", activeWsp.id, "destroyed meanwhile -- tab not filed");
          return false;
        }
        if (gone) {
          console.log("[TabService][addTabToWorkspace] tab", tab.id, "closed before it was filed -- skipped");
          return false;
        }
        // Keep active-workspace cache consistent so onTabActivated fast-path stays accurate
        if (added) WorkspaceService.addTabToActiveCache(tab.id, activeWsp.id);
        await TabService.setTabSessionValue(tab.id, activeWsp.id);
        TabService._scheduleSnapshotRefresh(tab.windowId, activeWsp.id);
        await MenuService.refreshTabMenu();
        UIService.scheduleToolbarUpdate(tab.windowId);
        return true;
      } else {
        console.log("[TabService][addTabToWorkspace] tab", tab.id,
          "already assigned to workspace:", alreadyAssigned.id, alreadyAssigned.name, "— no-op");
      }
    } else {
      // If workspaces exist but none is active (e.g. after destroying the active
      // workspace), activate the first one instead of creating a phantom workspace.
      if (workspaces.length > 0) {
        // Usually a handoff in flight (createWorkspace, destroying the active
        // workspace) or an activation: wait for it and file into whichever
        // workspace took over, instead of activating workspaces[0] -- which
        // may be the one being destroyed (its destroy then closed this tab).
        if (!afterHandoff) {
          await WorkspaceService.whenHandoffsSettled(tab.windowId);
          await WorkspaceService.whenActivationsSettled();
          return TabService._fileTab(tab, { skipForceContainer, ignoreSessionTag, afterHandoff: true });
        }
        const targetWsp = workspaces.find(wsp => !WorkspaceService._pendingDestroys.has(wsp.id))
          ?? workspaces[0];
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
        let gone = false;
        const filed = await WSPStorageManager.mutateWorkspace(targetWsp.id, (freshActive) => {
          if (TabService.wasRemoved(tab.id)) { gone = true; return false; }
          if (freshActive.tabs.includes(tab.id)) return false;
          freshActive.tabs.push(tab.id);
        });
        if (!filed) {
          console.log("[TabService][addTabToWorkspace] fallback target", targetWsp.id, "destroyed meanwhile -- tab not filed");
          return false;
        }
        if (gone) {
          console.log("[TabService][addTabToWorkspace] tab", tab.id, "closed before it was filed -- skipped");
          return false;
        }
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

  // File a tab whose session tag names another workspace of this window: a
  // closed tab brought back (Undo Close Tab, Recently Closed, Restore
  // Previous Session into a running window) carries its old tag. Returns
  // false when that workspace no longer exists (the caller then files the
  // tab under the active workspace).
  //  - Locked fresh read-modify-write: tagged tabs restored together used to
  //    overwrite each other's push and end up hidden in no workspace.
  //  - Hides only after the save landed, and only once no activation runs
  //    (one that shows the target would otherwise race this hide).
  //  - Firefox silently refuses to hide the selected tab (tabs.hide leaves
  //    it out of its result). Undo Close Tab selects the restored tab, which
  //    therefore stayed on screen in the current workspace while filed under
  //    a hidden one. Switch to its workspace instead, as selecting any tab
  //    of another workspace does.
  static async _fileUnderTaggedWorkspace(tab, wspId) {
    let gone = false;
    const filed = await WSPStorageManager.mutateWorkspace(wspId, (fresh) => {
      if (TabService.wasRemoved(tab.id)) { gone = true; return false; }
      if (fresh.tabs.includes(tab.id)) return false;
      fresh.tabs.push(tab.id);
    });
    if (!filed) return false;
    if (gone) {
      console.log("[TabService][_fileUnderTaggedWorkspace] tab", tab.id, "closed before it was filed -- skipped");
      return true;
    }
    await TabService.setTabSessionValue(tab.id, wspId);
    TabService._scheduleSnapshotRefresh(tab.windowId, wspId);

    await WorkspaceService.whenActivationsSettled();
    let target = await WSPStorageManager.getWorkspace(wspId);
    if (target.windowId != null && !target.active) {
      const hidden = await TabService.hideTabs(tab.id);
      if (!hidden.includes(tab.id)) {
        let live = null;
        try { live = await browser.tabs.get(tab.id); }
        catch { /* closed meanwhile: onRemoved drops it */ }
        if (live && !live.hidden && live.active) {
          // Unless an activation queued meanwhile (onActivated) already did
          await WorkspaceService.whenActivationsSettled();
          target = await WSPStorageManager.getWorkspace(wspId);
          if (target.windowId != null && !target.active) {
            console.log("[TabService][_fileUnderTaggedWorkspace] tab", tab.id,
              "is selected and cannot be hidden -- switching to its workspace", wspId);
            await WorkspaceService.activateWsp(wspId, tab.windowId, tab.id);
          }
        } else if (live && !live.hidden) {
          console.warn("[TabService][_fileUnderTaggedWorkspace] Firefox refused to hide tab", tab.id,
            "-- it stays visible until it stops sharing or the next workspace switch hides it");
        }
      }
    } else if (target.active) {
      WorkspaceService.addTabToActiveCache(tab.id, wspId);
    }
    await MenuService.refreshTabMenu();
    UIService.scheduleToolbarUpdate(tab.windowId);
    return true;
  }

  // Navigation-time container enforcement.
  //
  // The creation-time force in addTabToWorkspace only fires when the tab
  // already has a reopenable URL at onCreated. Tabs born as about:blank
  // (window.open, target="_blank", links from external apps) or tabs whose URL
  // is navigated in place escape the workspace container, because nothing
  // re-checks once the URL settles. This runs on tabs.onUpdated(url) and
  // reopens such a tab in the active workspace's container.
  //
  // Cheap by design: returns immediately (sync, no storage) unless the active
  // workspace is container-bound AND this tab is a member AND it is in the
  // wrong container AND the settled URL is reopenable -- so only tabs that
  // actually escaped ever reach the reopen path. Firefox-internal pages
  // (about:settings, about:config, about:addons, ...) are not reopenable, so
  // they are left untouched automatically.
  static async forceTabIntoActiveContainer(tab, url) {
    const cache = WorkspaceService._activeCache;
    if (!cache || !cache.containerId || !cache.activeWspId) return;
    if (cache.windowId !== tab.windowId) return;          // only the active window
    if (!cache.tabIds.has(tab.id)) return;                // only active-workspace tabs
    if (tab.cookieStoreId === cache.containerId) return;  // already correct (common case)
    if (TabService._reopeningCount > 0 || TabService._forceReopenIds.has(tab.id)) return;
    if (!TabService._canReopenInContainer(url)) return;   // internal/about: pages stay put
    if (TabService._recentlyForced(url)) {
      console.warn("[TabService][forceTabIntoActiveContainer] skipping repeated reopen for", url,
        "-- possible container-assignment conflict (e.g. Multi-Account Containers)");
      return;
    }

    const { containerId, activeWspId } = cache;
    console.log("[TabService][forceTabIntoActiveContainer] tab", tab.id,
      "in container", tab.cookieStoreId, "but active workspace wants", containerId,
      "-- reopening; url:", url);

    // Remove-before-reopen (same pattern as _migrateTabsToContainer / moveTabToWsp):
    // pull the old tab out of workspace storage first so the close fired by
    // _reopenInContainer does NOT save a closed-tab entry. suppressOnCreated=true
    // (the default) so we assign the new tab here instead of via onCreated.
    TabService._markForced(url);
    await TabService.removeTabFromWorkspace(tab.windowId, tab.id);
    await TabService.withReopenGuard(async () => {
      const newTab = await TabService._reopenInContainer(tab, containerId);
      if (!newTab) {
        console.warn("[TabService][forceTabIntoActiveContainer] reopen failed -- tab kept as-is");
        return;
      }
      // mutateWorkspace skips a workspace destroyed meanwhile (the old
      // `fresh.id` guard was always true: missing keys read as a stub).
      const filed = await WSPStorageManager.mutateWorkspace(activeWspId, (fresh) => {
        if (fresh.tabs.includes(newTab.id)) return false;
        fresh.tabs.push(newTab.id);
      });
      if (!filed) {
        console.warn("[TabService][forceTabIntoActiveContainer] workspace", activeWspId,
          "destroyed meanwhile -- new tab", newTab.id, "not filed");
        return;
      }
      WorkspaceService.addTabToActiveCache(newTab.id, activeWspId);
      await TabService.setTabSessionValue(newTab.id, activeWspId);
      TabService._scheduleSnapshotRefresh(tab.windowId, activeWspId);
      await MenuService.refreshTabMenu();
      await UIService.updateToolbarButton(tab.windowId);
      console.log("[TabService][forceTabIntoActiveContainer] reopened tab", tab.id,
        "->", newTab.id, "in container", containerId);
    });
  }

  // Loop-guard helpers for forceTabIntoActiveContainer (see _forceNavGuard).
  static _recentlyForced(url) {
    const t = TabService._forceNavGuard.get(url);
    return t != null && (Date.now() - t) < TabService._FORCE_NAV_GUARD_MS;
  }

  static _markForced(url) {
    const now = Date.now();
    TabService._forceNavGuard.set(url, now);
    if (TabService._forceNavGuard.size > 50) {
      for (const [u, t] of TabService._forceNavGuard) {
        if (now - t >= TabService._FORCE_NAV_GUARD_MS) TabService._forceNavGuard.delete(u);
      }
    }
  }

  // Search ALL workspaces for the tab, not just the active one.
  // `workspaces`: optional list the caller already read for this window
  // (onRemoved shares one read with saveClosedTabInfo).
  static async removeTabFromWorkspace(windowId, tabId, workspaces = null) {
    console.log("[TabService][removeTabFromWorkspace] tabId:", tabId, "windowId:", windowId);
    workspaces ??= await WSPStorageManager.getWorkspaces(windowId);

    for (const wsp of workspaces) {
      if (wsp.tabs.includes(tabId)) {
        console.log("[TabService][removeTabFromWorkspace] found tab", tabId,
          "in workspace:", wsp.id, wsp.name, "| before:", wsp.tabs.length, "tabs");
        // Locked fresh read-modify-write so concurrent add/remove cannot
        // overwrite each other. A close queued behind a destroy of this
        // workspace no longer writes a zombie record back.
        await WSPStorageManager.mutateWorkspace(wsp.id, (freshWsp) => {
          freshWsp.tabs = freshWsp.tabs.filter(id => id !== tabId);
          for (const group of freshWsp.groups) {
            group.tabs = group.tabs.filter(id => id !== tabId);
          }
          console.log("[TabService][removeTabFromWorkspace] removed -- workspace now has", freshWsp.tabs.length, "tabs");
        });
        // Keep active-workspace cache consistent
        WorkspaceService.removeTabFromActiveCache(tabId);
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

    // Verify the destination still exists BEFORE touching the source: a move
    // racing a destroy would otherwise strand the tab (getWorkspace returns a
    // stub for missing keys; windowId is the existence marker).
    const toWsp = await WSPStorageManager.getWorkspace(toWspId);
    if (toWsp.windowId == null) {
      console.warn("[TabService][moveTabToWsp] destination workspace", toWspId,
        "no longer exists -- aborting move");
      return;
    }

    const fromWsp = await WSPStorageManager.getWorkspace(fromWspId);
    let wasInSource = fromWsp.tabs.includes(tab.id);
    console.log("[TabService][moveTabToWsp] wasInSource:", wasInSource,
      "fromWsp tabs:", fromWsp.tabs.length);

    // Remove from source first (safer ordering to avoid dual-membership
    // window). Locked read-modify-write, same discipline as add/remove.
    if (wasInSource) {
      const freshFrom = await WSPStorageManager.mutateWorkspace(fromWspId, (fresh) => {
        fresh.tabs = fresh.tabs.filter(id => id !== tab.id);
        for (const group of fresh.groups) {
          group.tabs = group.tabs.filter(id => id !== tab.id);
        }
      });
      // Reflect the post-save source size for the empty-source check below
      if (freshFrom) fromWsp.tabs = freshFrom.tabs;
      else wasInSource = false;
      // Keep active-workspace cache consistent when moving OUT of active workspace
      WorkspaceService.removeTabFromActiveCache(tab.id);
      console.log("[TabService][moveTabToWsp] removed from source, fromWsp now has", fromWsp.tabs.length, "tabs");
    }

    // Force-container: reopen tab in destination's container if mismatched
    console.log("[Workspaces] moveTabToWsp: containerId=%s tab.cookieStoreId=%s",
      toWsp.containerId, tab.cookieStoreId);
    if (toWsp.containerId && tab.cookieStoreId !== toWsp.containerId
        && TabService._canReopenInContainer(tab.url)) {
      console.log("[TabService][moveTabToWsp] container mismatch -- reopening tab in:", toWsp.containerId);
      await TabService.withReopenGuard(async () => {
        const newTab = await TabService._reopenInContainer(tab, toWsp.containerId); // suppressOnCreated=true (default)
        if (newTab) {
          effectiveTabId = newTab.id;
          console.log("[Workspaces] moveTabToWsp: reopened tab %d -> %d in container %s",
            tab.id, newTab.id, toWsp.containerId);
        } else {
          console.warn("[Workspaces] moveTabToWsp: reopen failed, keeping original tab");
        }
      });
    }

    // Locked read-modify-write on the destination
    await WSPStorageManager.mutateWorkspace(toWspId, (freshToWsp) => {
      if (freshToWsp.tabs.includes(effectiveTabId)) {
        console.log("[TabService][moveTabToWsp] tab", effectiveTabId, "already in destination");
        return false;
      }
      freshToWsp.tabs.unshift(effectiveTabId);
      console.log("[TabService][moveTabToWsp] added tab", effectiveTabId,
        "to destination workspace:", toWspId, "| now has", freshToWsp.tabs.length, "tabs");
    });
    const freshToWsp = toWsp; // windowId/containerId only below; stub already validated

    // Update session value to new workspace
    await TabService.setTabSessionValue(effectiveTabId, toWspId);
    TabService._scheduleSnapshotRefresh(freshToWsp.windowId, toWspId);
    if (wasInSource) TabService._scheduleSnapshotRefresh(fromWsp.windowId, fromWspId);

    if (wasInSource) {
      const sourceDestroyed = fromWsp.tabs.length === 0;
      console.log("[TabService][moveTabToWsp] sourceDestroyed:", sourceDestroyed,
        "tab.active:", tab.active);
      // The destination comes up BEFORE an emptied source is destroyed.
      // Destroying the active source first brought up whichever workspace
      // came first in the window list -- an unrelated one flickered through
      // (shown, focused, snapshot rewritten) before the destination (X-38).
      if (tab.active || (sourceDestroyed && fromWsp.active)) {
        console.log("[TabService][moveTabToWsp] activating destination workspace");
        await WorkspaceService.activateWsp(toWspId, freshToWsp.windowId, tab.active ? effectiveTabId : null);
      }
      if (sourceDestroyed) {
        console.log("[TabService][moveTabToWsp] source workspace empty — destroying:", fromWspId);
        await WorkspaceService.destroyWsp(fromWspId, freshToWsp.windowId, { successorId: toWspId });
      }
      if (!tab.active) {
        // Hide the moved tab unless it landed in the workspace on screen
        // (then show it: moved while hidden, e.g. part of a multiselection)
        const activeWsp = await WorkspaceService.getActiveWsp(freshToWsp.windowId);
        if (activeWsp?.id === toWspId) {
          await TabService.showTabs(effectiveTabId);
        } else if (activeWsp) {
          console.log("[TabService][moveTabToWsp] inactive tab moved — hiding inactive tabs, activeWsp:", activeWsp.id);
          await WorkspaceService.hideInactiveWspTabs(freshToWsp.windowId, activeWsp.id);
        }
      }

      try { await TabService.ungroup(effectiveTabId); }
      catch (e) { console.debug("[TabService][moveTabToWsp] tabs.ungroup failed for tab", effectiveTabId, ":", e.message); }
    }

    await MenuService.refreshTabMenu();
    console.log("[TabService][moveTabToWsp] done — effectiveTabId:", effectiveTabId,
      "now in workspace:", toWspId);
  }

  // ── Tab info cache helpers ──

  // Only a memory bound: entries are dropped as soon as their tab closes
  // (takeTabInfo at the top of onRemoved, every window), so the cache holds
  // live tabs only. The old 500-entry FIFO filled up with dead entries and
  // evicted the oldest LIVE tabs first -- the long-lived ones, whose closes
  // then recorded nothing.
  static _TAB_INFO_CACHE_MAX = 2000;

  static cacheTabInfo(tab) {
    if (tab.url && tab.url !== "about:blank" && tab.url !== "about:newtab") {
      // Least-recently-updated first: re-insert so an update refreshes the
      // entry's position (Map.set on an existing key does not).
      TabService._tabInfoCache.delete(tab.id);
      if (TabService._tabInfoCache.size >= TabService._TAB_INFO_CACHE_MAX) {
        const firstKey = TabService._tabInfoCache.keys().next().value;
        TabService._tabInfoCache.delete(firstKey);
      }
      TabService._tabInfoCache.set(tab.id, {
        url: tab.url,
        title: tab.title || tab.url,
        favIconUrl: tab.favIconUrl || "",
        // Group membership, for "Save and close group" (see saveClosedTabInfo)
        groupId: tab.groupId ?? -1
      });
    }
  }

  // Group change of a cached tab (tabs.onUpdated groupId).
  static updateCachedGroup(tabId, groupId) {
    const cached = TabService._tabInfoCache.get(tabId);
    if (cached) cached.groupId = groupId ?? -1;
  }

  // Remove and return a closed tab's cached info. Called at the top of
  // onRemoved, before any guard, so no dead entry survives a close that the
  // listener then ignores (other window, window closing, not ready).
  static takeTabInfo(tabId) {
    const cached = TabService._tabInfoCache.get(tabId) ?? null;
    TabService._tabInfoCache.delete(tabId);
    return cached;
  }

  // Pre-populate cache for all tabs in a window (called once at startup)
  static async warmTabInfoCache(windowId) {
    const tabs = await browser.tabs.query({ windowId });
    for (const tab of tabs) TabService.cacheTabInfo(tab);
    console.log("[TabService][warmTabInfoCache] windowId:", windowId, "cached", tabs.length, "tabs");
  }

  // ── Closed Tab helpers (Tier 2) ──

  // `info`: the entry takeTabInfo removed at the top of onRemoved (null:
  // nothing cached). `owner`: the workspace whose tabs[] held the tab, from
  // the caller's single read; null skips (a destroy or a container reopen
  // takes its tabs out of storage first so their closes record nothing).
  static async saveClosedTabInfo(windowId, tabId, info, owner) {
    console.log("[TabService][saveClosedTabInfo] tabId:", tabId, "windowId:", windowId,
      "cached:", !!info, "owner:", owner?.id ?? null);
    if (!info || !info.url) {
      console.log("[TabService][saveClosedTabInfo] no cached info for tabId:", tabId, "— skipping");
      return;
    }
    if (!owner) {
      console.log("[TabService][saveClosedTabInfo] tab", tabId, "not found in any workspace — skipping");
      return;
    }
    const entry = {
      url: info.url,
      title: info.title || info.url,
      favIconUrl: info.favIconUrl || "",
      closedAt: Date.now()
    };
    // Tabs of an inactive workspace are hidden: the user cannot close them
    // from the tab strip, so something else did -- typically Firefox's
    // "Close Duplicate Tabs", which includes hidden tabs, or another
    // extension. Flagged so the popup can point it out.
    if (!owner.active) entry.closedWhileHidden = true;

    const groupId = info.groupId ?? -1;
    if (groupId !== -1) {
      TabService._deferGroupedClosure(groupId, owner.id, entry);
      return;
    }
    console.log("[TabService][saveClosedTabInfo] saving closed tab:", info.url,
      "to workspace:", owner.id, owner.name);
    await WSPStorageManager.saveClosedTab(owner.id, entry);
  }

  // ── Closed tab groups ("Save and close group", "Delete group") ──
  // Firefox records a whole closed group itself (skipSessionStore per tab)
  // and fires one tabs.onRemoved per tab, then tabGroups.onRemoved once the
  // group is gone. Recording each tab flooded the workspace's 25-entry list
  // (evicting real closures), and restoring those entries duplicated the
  // group Firefox keeps. Entries of grouped tabs therefore wait briefly:
  // dropped if their group is removed, saved once the wait expires (a tab
  // closed out of a group that lives on).
  static _pendingGroupClosures = new Map(); // groupId -> { timer, entries: [{ wspId, entry }] }
  static _removedGroupIds = new Set();      // groups already reported removed
  static _GROUP_CLOSE_WAIT_MS = 2000;

  static _deferGroupedClosure(groupId, wspId, entry) {
    if (TabService._removedGroupIds.has(groupId)) {
      // The group's removal was handled before this close finished its reads
      console.log("[TabService][_deferGroupedClosure] group", groupId, "already closed as a whole -- entry dropped");
      return;
    }
    let pending = TabService._pendingGroupClosures.get(groupId);
    if (!pending) {
      pending = { timer: null, entries: [] };
      TabService._pendingGroupClosures.set(groupId, pending);
    }
    pending.entries.push({ wspId, entry });
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      TabService._flushGroupedClosures(groupId).catch(e =>
        console.debug("[TabService][_deferGroupedClosure] flush failed:", e.message));
    }, TabService._GROUP_CLOSE_WAIT_MS);
  }

  static async _flushGroupedClosures(groupId) {
    const pending = TabService._pendingGroupClosures.get(groupId);
    if (!pending) return;
    TabService._pendingGroupClosures.delete(groupId);
    clearTimeout(pending.timer);
    for (const { wspId, entry } of pending.entries) {
      await WSPStorageManager.saveClosedTab(wspId, entry);
    }
  }

  // tabGroups.onRemoved (not window closing). An emptied group removed by
  // the extension's own ungroup (workspace switch) is not a user closing
  // it: its pending entries are saved, not dropped.
  static async onTabGroupRemoved(groupId) {
    if (Date.now() - TabService._ownUngroupAt < TabService._OWN_UNGROUP_GRACE_MS) {
      console.log("[TabService][onTabGroupRemoved] group", groupId, "emptied by our own ungroup -- entries kept");
      await TabService._flushGroupedClosures(groupId);
      return;
    }
    TabService._removedGroupIds.add(groupId);
    if (TabService._removedGroupIds.size > 100) {
      TabService._removedGroupIds.delete(TabService._removedGroupIds.values().next().value);
    }
    const pending = TabService._pendingGroupClosures.get(groupId);
    if (!pending) return;
    TabService._pendingGroupClosures.delete(groupId);
    clearTimeout(pending.timer);
    console.log("[TabService][onTabGroupRemoved] group", groupId, "closed as a whole --",
      pending.entries.length, "per-tab closed entries dropped (Firefox keeps the group)");
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

  // Entries are addressed by identity (url + closedAt), not by index: the
  // stored array mutates while the popup is open (new closures unshift), so
  // a render-time index can restore the wrong tab.
  static async restoreClosedTab(wspId, { url, closedAt } = {}, windowId) {
    console.log("[TabService][restoreClosedTab] wspId:", wspId, "url:", url,
      "closedAt:", closedAt, "windowId:", windowId);
    const closedTabs = await WSPStorageManager.getClosedTabs(wspId);
    const tabInfo = closedTabs.find(t => t.url === url && t.closedAt === closedAt);
    if (!tabInfo) {
      console.warn("[TabService][restoreClosedTab] entry not found (already restored or cleared)");
      return null;
    }
    console.log("[TabService][restoreClosedTab] restoring:", tabInfo.url);

    if (!TabService._isUrlAllowed(tabInfo.url)) {
      console.warn("[Workspaces] Blocked restore of disallowed URL scheme:", tabInfo.url);
      await WSPStorageManager.removeClosedTab(wspId, tabInfo);
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
    await WSPStorageManager.removeClosedTab(wspId, tabInfo);
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
