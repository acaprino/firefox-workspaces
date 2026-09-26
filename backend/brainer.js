// Orchestrator: init + listener registration only. All logic delegated to services.
class Brainer {
  // Lifecycle states: 'uninitialized' -> 'initializing' -> 'restoring' -> 'ready'
  // ('restoring' is skipped on the first-start / already-running path; the
  // state goes 'initializing' -> 'ready' directly there.)
  static _state = 'uninitialized';
  static _initStarted = false;
  static _lastFocusedWindowId = null;
  static _primaryWindowId = null;
  // Set when refuse-to-wipe (or a Phase 4 failure) trips: the restore is
  // paused for the user. While set, only a window holding the workspaces'
  // tagged tabs takes them over (see _windowTakeOverMode). Cleared on
  // successful restore or via acknowledge/giveUp.
  // In-memory only -- a fresh Firefox start naturally clears it.
  static _refuseToWipeActive = false;

  // The error of the last initialize() pass that failed for any reason other
  // than a refused restore, null otherwise (X-06). While set, _state stays
  // 'uninitialized' (tab events, menus and mutating actions stay gated, as
  // stored tab ids may be stale), the "init-failure" banner explains it, a
  // retry is scheduled (LIMITS.INIT_RETRY_DELAYS_MS) and Dismiss retries at
  // once. A failed pass used to leave _state at 'initializing' for the rest
  // of the session, which every re-entry point refuses.
  static _initFailure = null;
  static _initRetryTimer = null;
  static _initRetryCount = 0;
  static INIT_FAILURE_REASON = "init-failure";

  // The primary window closed while the browser kept running: another
  // window stayed open, or macOS keeps Firefox running without windows (an
  // initialize() that finds no normal window is in the same situation).
  // { windowId, noted } -- `noted`: the primary-window-closed banner was
  // raised for it. A window opened afterwards is not a browser restart
  // (X-11); see _windowTakeOverMode. In-memory only: a restart or an
  // extension reload starts without it (the banner, when raised, persists).
  static _closedPrimary = null;

  // Listeners are registered once per background page, however many
  // initialize() passes run (X-06 retries, re-init after Give up).
  static _listenersRegistered = false;
  // storage.session restart evidence, read once per background page: a
  // retried pass would otherwise find the sentinel the first pass wrote and
  // lose the restart signal.
  static _sessionRestartEvidence = null;
  // Take-overs of the waiting workspaces run one at a time (_serializeTakeOver).
  static _takeOverChain = Promise.resolve();
  // An update is waiting for the background to go idle (_reloadWhenIdle).
  static _reloadPending = false;

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
  // Synchronous re-entrancy flag for _onWindowCreated: its state guards run
  // before its storage reads, so without this two concurrent invocations can
  // both enter the restore path (FLW-007).
  static _restoreInFlight = false;

  // Accessor for the refuse-to-wipe circuit breaker so the message handler
  // doesn't write private state directly (banner acknowledge / give-up).
  static setRefuseToWipeActive(value) {
    Brainer._refuseToWipeActive = value === true;
  }
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
      console.log("[Brainer][initialize] starting -- current state:", Brainer._state);
      // Register listeners BEFORE the schema-version await so any buffered
      // events fire against handlers that guard on _state. The handlers
      // themselves no-op while _state is 'initializing' or 'restoring'.
      Brainer._registerListeners();
      await Brainer._initializePass();
      console.log("[Brainer][initialize] done -- final state:", Brainer._state);
      // C-19 sweep, fire-and-forget: must not delay or fail startup.
      Brainer._recoverOrphanWorkspaces().catch(() => {});
    } catch (e) {
      await Brainer._onInitializeFailed(e);
    } finally {
      // Always clear _initStarted, even on throw. Without this, any failure in
      // initialize() permanently blocks _onWindowCreated (which guards on
      // _initStarted && _state !== 'ready'), silently dropping all future
      // windows from workspace tracking until extension restart.
      Brainer._initStarted = false;
    }
  }

  static _registerListeners() {
    if (Brainer._listenersRegistered) return;
    Brainer._listenersRegistered = true;
    Brainer._registerWindowListeners();
    Brainer._registerTabListeners();
    Brainer._registerCommandListeners();
    MenuService.registerOmniboxListeners();
  }

  // One initialize() pass: restart detection, then the restore path or the
  // first-start / already-running path. Throws on failure; initialize()
  // decides what the failure means (_onInitializeFailed).
  static async _initializePass() {
    await WSPStorageManager.ensureSchemaVersion();

    // Crash-proof restart evidence via storage.session (in-memory, cleared
    // when the browser session ends; Firefox 115+, available in MV2): if
    // the sentinel written at the end of every init is gone, the browser
    // (or the extension) restarted -- no matter how the previous session
    // ended. This complements the onWindowRemoved-based lastId signal,
    // which unclean shutdowns (crash, kill, power loss) bypass entirely.
    // Arms `restartLikely` for the repair pass AND the session-loss
    // detector. A false positive on a plain extension reload is harmless
    // only while session tags stay readable: the repair is a no-op when
    // stored arrays agree with session values, and _isSessionLost bails on
    // any tagged tab and treats thrown session lookups as indeterminate
    // rather than as evidence of loss.
    // Read once per background page: a retried pass would find the sentinel
    // the first pass wrote.
    if (Brainer._sessionRestartEvidence == null) {
      Brainer._sessionRestartEvidence = false;
      try {
        const sentinel = await browser.storage.session.get("wsp-session-alive");
        Brainer._sessionRestartEvidence = !sentinel["wsp-session-alive"];
        await browser.storage.session.set({ "wsp-session-alive": true });
      } catch (e) {
        console.debug("[Brainer][initialize] storage.session unavailable:", e?.message);
      }
    }
    const sessionRestartEvidence = Brainer._sessionRestartEvidence;

    // Detect restart vs first-ever startup BEFORE _ensureDefaultWorkspace
    // to eliminate the race with onStartup event.
    let existingPrimary = await WSPStorageManager.getPrimaryWindowId();
    let lastId = await WSPStorageManager.getPrimaryWindowLastId();
    console.log("[Brainer][initialize] existingPrimary:", existingPrimary, "| lastId:", lastId);

    // Validate stored primaryWindowId still exists AND is the same physical
    // window. After a non-clean shutdown (crash, kill, power loss)
    // onWindowRemoved never fired, so primaryWindowLastId was never armed and
    // the stored primaryWindowId belongs to the PREVIOUS session. Firefox
    // reassigns window IDs from low numbers each session, so that stale ID
    // may be gone entirely, or -- worse -- may now name a different physical
    // window. Either case used to fall through to _ensureDefaultWorkspace /
    // _repairTabAssignments against the wrong window, which destroyed
    // recoverable workspace state. Convert both into the detected-restart
    // signal so the guarded restore path below handles them. A stored
    // primary that is not a normal window (an older version could claim a
    // popup, X-118) is treated the same way.
    // NOTE: TOCTOU limitation -- the window could close between this check and
    // subsequent use. This is a sub-millisecond race; onWindowRemoved provides
    // eventual consistency if it occurs.
    if (existingPrimary != null) {
      let staleReason = null;
      try {
        const win = await browser.windows.get(existingPrimary);
        if (win?.type != null && win.type !== "normal") staleReason = `is a ${win.type} window, not a normal one`;
      } catch {
        staleReason = "no longer exists";
      }
      if (staleReason == null) {
        try {
          if (!(await Brainer._primaryWindowHoldsItsWorkspaces(existingPrimary))) {
            staleReason = "names a different physical window (its workspace tabs live elsewhere)";
          }
        } catch (e) {
          // Identity check is best-effort: on failure trust the stored ID
          // (the pre-guard behavior) rather than triggering a restore.
          console.warn("[Brainer][initialize] primary-window identity check failed -- trusting stored ID:", e?.message);
        }
      }
      if (staleReason != null) {
        console.warn("[Brainer][initialize] stored primaryWindowId", existingPrimary,
          staleReason, "-- treating as undetected restart");
        // Arm the restart-retry signal so the guarded restore path runs,
        // instead of _ensureDefaultWorkspace absorbing every tab into a
        // fresh default workspace and overwriting their session values.
        // Only when there is actually workspace state to restore. Armed
        // BEFORE the primary claim is dropped, the order onWindowRemoved
        // uses (X-67): a crash or a failed write between the two leaves both
        // keys set, which this same check handles on the next start, instead
        // of neither, which read as a first-ever start and stranded every
        // workspace under the dead window id (C-19).
        if (lastId == null &&
            (await WSPStorageManager.getWorkspaces(existingPrimary)).length > 0) {
          await WSPStorageManager.setPrimaryWindowLastId(existingPrimary);
          lastId = existingPrimary;
        }
        await WSPStorageManager.removePrimaryWindowId();
        Brainer._primaryWindowId = null;
        existingPrimary = null;
      }
    }

    if (existingPrimary == null && lastId != null) {
      // Restart: restore workspaces directly (don't rely on onStartup event).
      // Set state first to block any onWindowCreated races during window lookup.
      console.log("[Brainer][initialize] restart detected -- entering restore path");
      Brainer._state = 'restoring';
      let target;
      try {
        // The primary window closed while the browser kept running and the
        // banner still offers it back (X-100; an extension update or a
        // restart came since): only a window holding the workspaces' tabs
        // is theirs (X-11).
        const waiting = await Brainer._awaitsClosedPrimary();
        target = await Brainer._findRestoreWindow(lastId, { requireTags: waiting });
        if (!target) {
          // No normal window at all (macOS: Firefox running without one), or
          // none holding the tabs the banner waits for. The workspaces wait
          // for a window that takes them over (_windowTakeOverMode).
          Brainer._state = 'uninitialized';
          if (!Brainer._closedPrimary) Brainer._closedPrimary = { windowId: lastId, noted: waiting };
          console.log("[Brainer][initialize] no window to restore into yet -- the workspaces wait (waiting for the closed window:",
            waiting, ")");
          await Brainer._clearInitFailure();
          return;
        }
        console.log("[Brainer][initialize] restore window chosen:", target.id);
        await Brainer._restoreWorkspaces(target, { midSession: waiting });
      } catch (e) {
        Brainer._state = 'uninitialized';
        console.error("[Brainer][initialize] restore failed -- state reset to uninitialized:", e);
        throw e;
      }
      Brainer._state = 'ready';
      console.log("[Brainer][initialize] restore complete -- state: ready");
      // Reconcile tabs that Firefox session-restored during the 'restoring'
      // window (their onTabCreated was blocked). Past this point the restore
      // is committed: a failure is logged and the state stays 'ready' (X-06).
      await Brainer._settleReady(target.id, { lateTabs: true });
      return;
    }

    console.log("[Brainer][initialize] first-start or already-running path");
    await Brainer._ensureDefaultWorkspace();
    // Repair tab->workspace assignments. After a non-clean shutdown (crash,
    // kill, power loss) the restart is not detected because onWindowRemoved
    // never fired, so we are on this path even though the browser actually
    // restarted. Firefox reuses tab IDs from low numbers across sessions, so
    // stored arrays now point to DIFFERENT restored tabs. _repairTabAssignments
    // re-files every open tab by its session value (and, when a restart is
    // confirmed, by URL snapshot). No-op on a genuine already-running reload.
    const pid = await WSPStorageManager.getPrimaryWindowId();
    if (pid) {
      await Brainer._repairTabAssignments(pid,
        Brainer._browserStarted || sessionRestartEvidence);
    }
    // 'ready' even when onInstalled fired before its listener was registered
    // (during the ensureSchemaVersion() await above), and even without a
    // primary window: with no normal window open yet, the first one opened
    // is claimed by _onWindowCreated.
    Brainer._state = 'ready';
    await Brainer._settleReady(pid ?? null);
  }

  // A failed initialize() pass (X-06). A refused restore (refuse-to-wipe,
  // Phase 4 failure) wrote its own banner and waits for the user or a
  // restart. Any other failure (a tabs or storage error in the repair, a
  // window gone mid-restore) used to leave _state at 'initializing' for the
  // rest of the session -- every re-entry point refuses that state, so tabs
  // went untracked and every action said "still starting up", with no
  // banner. Now: 'uninitialized', an "init-failure" banner and a retry.
  static async _onInitializeFailed(e) {
    if (Brainer._state === 'ready') {
      console.error("[Brainer][initialize] failed after the state was ready -- kept ready:", e);
      return;
    }
    Brainer._state = 'uninitialized';
    if (Brainer._refuseToWipeActive) {
      console.warn("[Brainer][initialize] restore refused -- waiting for the user or a restart:", e?.message);
      return;
    }
    console.error("[Brainer][initialize] failed -- state: uninitialized, retry scheduled:", e);
    Brainer._initFailure = e ?? new Error("initialize failed");
    await Brainer._surfaceInitFailure(e);
    Brainer._scheduleInitRetry();
  }

  // Surface a failed start through the restore-error banner and the "!"
  // badge (gotcha 8: only via setLastRestoreError). A pending warning keeps
  // the single slot: an unread refuse-to-wipe or session-loss warning, or an
  // earlier pass of this failure, whose `when` a banner on screen echoes.
  static async _surfaceInitFailure(e) {
    try {
      if (await WSPStorageManager.getLastRestoreError()) return;
      await WSPStorageManager.setLastRestoreError({
        when: Date.now(),
        reason: Brainer.INIT_FAILURE_REASON,
        error: String(e?.message ?? e),
      });
    } catch (err) {
      console.error("[Brainer][_surfaceInitFailure] failed to store the warning:", err?.message);
      UIService.forceWarnBadge();
    }
    await UIService.refreshWarnBadge();
  }

  static _scheduleInitRetry() {
    clearTimeout(Brainer._initRetryTimer);
    Brainer._initRetryTimer = null;
    const delays = LIMITS.INIT_RETRY_DELAYS_MS;
    if (Brainer._initRetryCount >= delays.length) {
      console.warn("[Brainer][initialize] no automatic retry left -- Dismiss on the banner retries");
      return;
    }
    const delay = delays[Brainer._initRetryCount++];
    console.log("[Brainer][initialize] retrying in", delay, "ms");
    Brainer._initRetryTimer = setTimeout(() => {
      Brainer._initRetryTimer = null;
      Brainer.retryInitialize("timer").catch(() => {});
    }, delay);
  }

  // Another initialize() pass after a failed one: on the retry timer, on
  // Dismiss, or when a window opens or onStartup/onInstalled fires. No-op
  // unless a failure is pending and nothing else is in flight. Resolves to
  // whether the extension is ready afterwards; never throws.
  static async retryInitialize(trigger) {
    if (Brainer._initFailure == null || Brainer._state !== 'uninitialized'
        || Brainer._initStarted || Brainer._restoreInFlight) return false;
    console.log("[Brainer][retryInitialize] trigger:", trigger, "| last failure:",
      String(Brainer._initFailure?.message ?? Brainer._initFailure));
    await Brainer.initialize();
    return Brainer._state === 'ready';
  }

  // A pass got through (ready, or knowingly waiting for a window): drop the
  // pending failure, its retry and its banner.
  static async _clearInitFailure() {
    Brainer._initFailure = null;
    Brainer._initRetryCount = 0;
    clearTimeout(Brainer._initRetryTimer);
    Brainer._initRetryTimer = null;
    try {
      if ((await WSPStorageManager.getLastRestoreError())?.reason === Brainer.INIT_FAILURE_REASON) {
        await WSPStorageManager.clearLastRestoreError();
        await UIService.refreshWarnBadge();
      }
    } catch (e) {
      console.debug("[Brainer][_clearInitFailure] could not clear the init-failure banner:", e?.message);
    }
  }

  // Common tail of every path that leaves the state 'ready' with a window
  // primary: initialize() on both paths, a window taking the workspaces over
  // (_onWindowCreated, Dismiss), the banner's reopen and the fresh start
  // after Give up (X-35). Files the tabs Firefox added while 'restoring'
  // held tab events back (`lateTabs`), warms the closed-tab cache and
  // repaints the menu and toolbar: a focus event mid-restore painted the
  // pre-restore state ("Workspaces", no badge, no Move Tab menu). The state
  // stays 'ready': a failure here is logged, never turned into an inert
  // extension (X-06). `windowId` null: ready without a primary window yet.
  // `settleMs`: how long Firefox gets to add the late tabs first.
  static async _settleReady(windowId, { lateTabs = false, settleMs = LIMITS.RESTORE_DELAY_MS } = {}) {
    Brainer._closedPrimary = null;
    if (windowId != null) Brainer._primaryWindowId = windowId;
    const step = async (name, fn) => {
      try { await fn(); }
      catch (e) { console.warn("[Brainer][_settleReady]", name, "failed for window", windowId, ":", e?.message); }
    };
    await step("clearInitFailure", () => Brainer._clearInitFailure());
    if (windowId != null && lateTabs) {
      await step("reconcileLateTabs", async () => {
        if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs));
        // The window may have closed meanwhile (onWindowRemoved took over)
        if (Brainer._state !== 'ready' || (await WSPStorageManager.getPrimaryWindowId()) !== windowId) return;
        await Brainer._reconcileLateTabs(windowId);
      });
    }
    // Warm tab info cache so closed-tab tracking works from the start
    if (windowId != null) await step("warmTabInfoCache", () => TabService.warmTabInfoCache(windowId));
    await step("refreshTabMenu", () => MenuService.refreshTabMenu());
    if (windowId != null) await step("updateToolbarButton", () => UIService.updateToolbarButton(windowId));
  }

  // Shared initialization: ensure primary window and default workspace exist.
  // Callable from initialize() (legit, runs while _state === 'initializing')
  // and from event handlers (onInstalled, onStartup); the event-handler entry
  // points guard themselves on _initStarted / _state before calling.
  // `target`: the window to claim (a new window, _onWindowCreated); default
  // the focused normal window. Returns the id of the window it claimed as
  // primary, else null.
  static async _ensureDefaultWorkspace(target = null) {
    console.log("[Brainer][_ensureDefaultWorkspace] state:", Brainer._state);
    if (Brainer._state === 'restoring') {
      console.log("[Brainer][_ensureDefaultWorkspace] skipped -- state is 'restoring'");
      return null;
    }
    // If primaryWindowLastId exists, this is a restart -- let restore handle it
    const lastId = await WSPStorageManager.getPrimaryWindowLastId();
    if (lastId != null) {
      console.log("[Brainer][_ensureDefaultWorkspace] skipped -- lastId present:", lastId, "(restart path)");
      return null;
    }
    const existing = await WSPStorageManager.getPrimaryWindowId();
    if (existing == null) {
      // A normal window only (X-118): getCurrent() is the last focused window
      // of any type -- a window.open popup or another extension's pop-out.
      // With none open (macOS: Firefox running without windows) there is
      // nothing to claim yet, not an error: the first normal window opened
      // is claimed by _onWindowCreated. getCurrent() used to throw here and
      // leave the state at 'initializing' (X-06).
      const currentWindow = target ?? await Brainer._pickNormalWindow();
      if (!currentWindow) {
        console.log("[Brainer][_ensureDefaultWorkspace] no normal window open -- the first one opened becomes primary");
        return null;
      }
      console.log("[Brainer][_ensureDefaultWorkspace] no primary window -- setting to:", currentWindow.id);
      await WSPStorageManager.setPrimaryWindowId(currentWindow.id);
      Brainer._primaryWindowId = currentWindow.id;

      const activeWsp = await WorkspaceService.getActiveWsp(currentWindow.id);
      if (!activeWsp) {
        console.log("[Brainer][_ensureDefaultWorkspace] no active workspace — creating default");
        const allTabs = await browser.tabs.query({windowId: currentWindow.id, pinned: false});
        const candidates = allTabs.filter(tab => !tab.url?.startsWith("about:firefoxview"));
        // Preserve session tags that reference a workspace still present in
        // storage: they are the last-line recovery data after an undetected
        // restart. The tabs are still absorbed into the default workspace so
        // they stay tracked, but the original tag survives for the
        // repair/restore machinery. Tags referencing wiped workspaces (or no
        // tag at all) are (re)written to the new default as before.
        const keepTag = new Set();
        const tagged = new Set();
        await Promise.all(candidates.map(async (tab) => {
          try {
            const sv = await browser.sessions.getTabValue(tab.id, "wspId");
            if (sv && UUID_RE.test(sv)) {
              tagged.add(tab.id);
              // windowId is the existence marker: a zombie record (written
              // back after its workspace was destroyed) has none and must not
              // keep a tag alive.
              const state = await WSPStorageManager.getWspState(sv);
              if (state && state.windowId != null) keepTag.add(tab.id);
            }
          } catch (e) {
            console.debug("[Brainer][_ensureDefaultWorkspace] session lookup failed for tab",
              tab.id, ":", e.message);
          }
        }));
        // A hidden tab without our tag was hidden by another tab-hiding
        // extension (Simple Tab Groups, Sidebery, Panorama, ...): every tab
        // this extension hides is tagged first. Absorbing those tabs made
        // the next activation show them all -- every group of the other
        // extension dumped into one strip.
        const currentTabs = candidates.filter(tab => !tab.hidden || tagged.has(tab.id));
        if (currentTabs.length !== candidates.length) {
          console.log("[Brainer][_ensureDefaultWorkspace] left", candidates.length - currentTabs.length,
            "untagged hidden tab(s) to the extension that hid them");
        }
        console.log("[Brainer][_ensureDefaultWorkspace] unpinned tabs to absorb:", currentTabs.length,
          currentTabs.map(t => t.id));
        const wsp = WorkspaceService._buildDefaultWspData(
          currentWindow.id,
          currentTabs.map(tab => tab.id)
        );
        await WorkspaceService.createWorkspace(wsp);
        for (const tab of currentTabs) {
          if (keepTag.has(tab.id)) continue;
          await TabService.setTabSessionValue(tab.id, wsp.id);
        }
        if (keepTag.size > 0) {
          console.warn("[Brainer][_ensureDefaultWorkspace] preserved original session tags on",
            keepTag.size, "tab(s) referencing stored workspaces");
        }
        console.log("[Brainer][_ensureDefaultWorkspace] default workspace created:", wsp.id);
      } else {
        console.log("[Brainer][_ensureDefaultWorkspace] active workspace already exists:", activeWsp.id, activeWsp.name);
      }
      return currentWindow.id;
    }
    console.log("[Brainer][_ensureDefaultWorkspace] primary window already set:", existing);
    return null;
  }

  // Normal browser windows: the only candidates for the primary window and
  // for a restore target (X-118). windows.getAll's default also lists popups
  // and panels (a window.open OAuth or payment popup, another extension's
  // pop-out): no tab strip, and gone again in seconds. Private windows are
  // left out while a non-private one exists: private browsing data is never
  // adopted (D2).
  static async _normalWindows() {
    const wins = await browser.windows.getAll({ windowTypes: ["normal"] });
    const normal = wins.filter(w => w.type == null || w.type === "normal");
    const regular = normal.filter(w => !w.incognito);
    return regular.length > 0 ? regular : normal;
  }

  // The normal window to claim as primary: the focused one, else the last
  // one focused, else the first. null when none is open.
  static async _pickNormalWindow() {
    const wins = await Brainer._normalWindows();
    return wins.find(w => w.focused)
      ?? wins.find(w => w.id === Brainer._lastFocusedWindowId)
      ?? wins[0]
      ?? null;
  }

  // ── Window & Lifecycle Listeners ──

  static _registerWindowListeners() {
    browser.runtime.onInstalled.addListener(async () => {
      try {
        console.log("[Brainer][onInstalled] fired -- state:", Brainer._state);
        // Skip while initialize() is still in flight (either the schema-check
        // await or the restart-detect window). initialize() will run
        // _ensureDefaultWorkspace itself once it reaches the right path.
        if (Brainer._state === 'restoring' || Brainer._state === 'initializing' || Brainer._initStarted) {
          console.log("[Brainer][onInstalled] skipped -- state:", Brainer._state, "initStarted:", Brainer._initStarted);
          return;
        }
        // Not ready: a failed start (retried now), a refused restore or
        // workspaces waiting for their window. None of them is an install
        // event's to resolve: forcing 'ready' here opened the handler's gate
        // with no primary window while a refused restore was pending, and
        // hid the pending restore from reopenClosedPrimaryWindow (X-68).
        if (Brainer._state !== 'ready') {
          if (!(await Brainer.retryInitialize("onInstalled"))) {
            console.log("[Brainer][onInstalled] state stays", Brainer._state);
          }
          return;
        }
        // Ready without a primary window (none was open at init): claim one,
        // serialized with windows.onCreated (both claiming made two defaults).
        if ((await WSPStorageManager.getPrimaryWindowId()) == null) {
          const win = await Brainer._pickNormalWindow();
          if (win) await Brainer._queueWindowCreated(win);
        }
        console.log("[Brainer][onInstalled] done -- state:", Brainer._state);
      } catch (e) { console.error("[Workspaces] onInstalled error:", e); }
    });

    browser.runtime.onUpdateAvailable?.addListener(() => {
      console.log("[Brainer][onUpdateAvailable] update pending -- applying once idle");
      Brainer._reloadWhenIdle().catch(e => console.error("[Workspaces] onUpdateAvailable error:", e));
    });

    browser.windows.onCreated.addListener(async (window) => {
      try {
        console.log("[Brainer][onWindowCreated] windowId:", window.id, "state:", Brainer._state);
        await Brainer._queueWindowCreated(window);
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
              // 'restoring' gates new activations; let one already in flight
              // finish so it cannot show/hide from lists the repair rewrites.
              await WorkspaceService._activationChain.catch(() => {});
              await Brainer._repairTabAssignments(pid, true);
            } finally {
              // Unless the primary window closed meanwhile (onWindowRemoved
              // set 'uninitialized'): ready with no primary opened the gates.
              if (Brainer._state === 'restoring') Brainer._state = 'ready';
            }
          }
          return;
        }

        // state is 'uninitialized': a failed start is retried; otherwise a
        // normal window that session restore finished filling since init may
        // now hold the workspaces' tabs (_windowTakeOverMode decides).
        if (Brainer._initFailure) {
          await Brainer.retryInitialize("onStartup");
          return;
        }
        const windowsOnLoad = await Brainer._normalWindows();
        console.log("[Brainer][onStartup] normal windows on load:", windowsOnLoad.length);
        if (windowsOnLoad.length === 1) {
          await Brainer._queueWindowCreated(windowsOnLoad[0]);
        }
      } catch (e) { console.error("[Workspaces] onStartup error:", e); }
    });

    browser.windows.onRemoved.addListener(async (windowId) => {
      try {
        console.log("[Brainer][onWindowRemoved] windowId:", windowId);
        const primaryId = await WSPStorageManager.getPrimaryWindowId();
        if (primaryId === windowId) {
          console.log("[Brainer][onWindowRemoved] primary window closed -- flushing last active tab, arming lastId, clearing primary");
          // A pending snapshot refresh would query the closed window, find
          // nothing and overwrite the last good tabSnapshot with [].
          TabService._cancelSnapshotRefreshes(windowId);
          await WorkspaceService.flushLastActiveTab();
          // Arm the restart signal BEFORE dropping the primary claim. A crash
          // between these two writes then leaves BOTH keys set -- a state
          // initialize() already handles via the stale-primary check --
          // instead of NEITHER, which read as a first-ever startup and
          // silently orphaned every workspace under the dead windowId (C-19).
          await WSPStorageManager.setPrimaryWindowLastId(windowId);
          await WSPStorageManager.removePrimaryWindowId();
          Brainer._primaryWindowId = null;
          Brainer._state = 'uninitialized';
          // Not a browser restart unless the browser is quitting (then this
          // process ends anyway): a window opened next takes the workspaces
          // over only on evidence (X-11, _windowTakeOverMode).
          const closed = { windowId, noted: false };
          Brainer._closedPrimary = closed;
          console.log("[Brainer][onWindowRemoved] state reset to uninitialized");
          closed.noted = await Brainer._noteClosedPrimaryWindow(windowId);
        } else {
          console.log("[Brainer][onWindowRemoved] non-primary window (primary was:", primaryId, ") -- no action");
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
      } catch (e) {
        // A transient window (extension popout, dialog) can vanish between
        // the focus event and our queries -- routine churn, not an error.
        if (/Invalid window ID/i.test(String(e?.message))) {
          console.debug("[Brainer][onFocusChanged] window vanished:", e.message);
        } else {
          console.error("[Workspaces] onFocusChanged error:", e);
        }
      }
    });

    browser.theme.onUpdated.addListener(async ({ theme, windowId: themeWindowId } = {}) => {
      try {
        console.log("[Brainer][onThemeUpdated] fired -- themeWindowId:", themeWindowId,
          "| colors:", JSON.stringify(theme?.colors ?? null));
        // Invalidate caches: custom icons must be regenerated with the new theme colors
        UIService.invalidateThemeCaches();
        const primaryWindowId = await WSPStorageManager.getPrimaryWindowId();
        console.log("[Brainer][onThemeUpdated] primaryWindowId:", primaryWindowId);
        if (primaryWindowId) await UIService.updateToolbarButton(primaryWindowId, theme?.colors);
        await MenuService.refreshTabMenu();
      } catch (e) { console.error("[Workspaces] onThemeUpdated error:", e); }
    });

    // OS-level scheme flips (System/"Automatic" theme, adaptive colorways) do
    // not reliably fire theme.onUpdated -- the theme object itself is unchanged.
    // The background document's prefers-color-scheme tracks the effective
    // browser scheme, so its change event is the recovery signal. Seed the
    // dark-mode hint from it: _isThemeDark resolves from theme colors first,
    // so the seed only takes effect when colors are inconclusive (System
    // theme) -- exactly the case where the browser scheme IS the OS scheme.
    // Under resistFingerprinting the query is pinned to light and never
    // fires; the popup's setDarkModeHint path still recovers in that case.
    const schemeQuery = self.matchMedia?.("(prefers-color-scheme: dark)");
    if (schemeQuery?.addEventListener) {
      schemeQuery.addEventListener("change", async (e) => {
        try {
          console.log("[Brainer][onSchemeChanged] prefers-color-scheme flipped -> dark:", e.matches);
          UIService.invalidateThemeCaches();
          UIService.setDarkModeHint(e.matches);
          const primaryWindowId = await WSPStorageManager.getPrimaryWindowId();
          if (primaryWindowId) await UIService.updateToolbarButton(primaryWindowId);
        } catch (err) { console.error("[Workspaces] onSchemeChanged error:", err); }
      });
    }
  }

  // Everything that may hand the waiting workspaces to a window runs one at
  // a time: windows.onCreated, Dismiss, Give up and the banner's reopen.
  // Deciding whether a window takes them over can wait for Firefox to fill
  // it (_findTaggedWindow), and a window created meanwhile -- a multi-window
  // session restore, or the closed window reopened right after a Dismiss --
  // used to be dropped as "restore already in flight", possibly the one
  // holding the workspaces' tabs. `fn` must not await this chain.
  static _serializeTakeOver(fn) {
    const run = Brainer._takeOverChain.catch(() => {}).then(fn);
    Brainer._takeOverChain = run;
    return run;
  }

  static _queueWindowCreated(window) {
    return Brainer._serializeTakeOver(() => Brainer._onWindowCreated(window));
  }

  // Resolves once no initialize() pass and no post-start repair runs (or
  // after `timeoutMs`, leaving the caller's own state checks to decide).
  static async _whenInitSettled({ timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while ((Brainer._initStarted || Brainer._state === 'initializing' || Brainer._state === 'restoring')
        && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  static async _onWindowCreated(window) {
    // Only a normal browser window can hold the workspaces (X-118): a
    // window.open popup (OAuth, payment) or another extension's pop-out has
    // no tab strip and closes again in seconds -- claiming one rebound every
    // workspace to it, filed its tab into the active workspace and let the
    // snapshot refresh overwrite that workspace's tabSnapshot.
    if (window.type != null && window.type !== "normal") {
      console.log("[Brainer][_onWindowCreated] windowId:", window.id, "skipped -- a", window.type, "window");
      return;
    }
    // A window created while initialize() or the post-start repair runs is
    // looked at once they are done: both racing to restore workspaces could
    // create duplicate entries, and skipping it outright lost a window
    // session restore added mid-init that holds the workspaces' tabs.
    await Brainer._whenInitSettled();
    // Fast-exit guards BEFORE the expensive stringified log (minor perf win
    // on non-primary window creation, more importantly avoids misleading
    // "looks like we processed it" log entries for skipped paths).
    if (Brainer._state === 'restoring' || Brainer._state === 'initializing') {
      console.log("[Brainer][_onWindowCreated] windowId:", window.id, "skipped -- state is", Brainer._state);
      return;
    }
    if (Brainer._initStarted && Brainer._state !== 'ready') {
      console.log("[Brainer][_onWindowCreated] windowId:", window.id, "skipped -- initialize() still running");
      return;
    }
    // A failed start: a new window is a good moment to retry it (X-06).
    if (Brainer._initFailure) {
      await Brainer.retryInitialize("window created");
      return;
    }
    // Check-then-act guard for a direct call outside _serializeTakeOver:
    // the state checks above happen before the storage reads below. The
    // flag is set synchronously before the first await.
    if (Brainer._restoreInFlight) {
      console.log("[Brainer][_onWindowCreated] windowId:", window.id, "skipped -- restore already in flight");
      return;
    }
    Brainer._restoreInFlight = true;
    let claimed = null;
    try {
      console.log("[Brainer][_onWindowCreated] windowId:", window.id, "state:", Brainer._state,
        "initStarted:", Brainer._initStarted);

      const primaryId = await WSPStorageManager.getPrimaryWindowId();
      const lastId = await WSPStorageManager.getPrimaryWindowLastId();
      console.log("[Brainer][_onWindowCreated] primaryId:", primaryId, "lastId:", lastId);

      // Re-check after the awaits: initialize() may have claimed the restore
      // while we were reading storage.
      if (Brainer._state === 'restoring' || Brainer._state === 'initializing') {
        console.log("[Brainer][_onWindowCreated] windowId:", window.id, "skipped post-read -- state is", Brainer._state);
        return;
      }
      if (primaryId != null) {
        console.log("[Brainer][_onWindowCreated] additional window opened (primary already:", primaryId, ") -- no action");
        return;
      }
      // Never a private window while a non-private one is open (D2)
      if (window.incognito && (await Brainer._normalWindows()).some(w => !w.incognito)) {
        console.log("[Brainer][_onWindowCreated] windowId:", window.id, "skipped -- private window");
        return;
      }

      // First-ever startup (no primary window recorded), or a start that
      // found no normal window open: claim it with a default workspace that
      // absorbs its tabs. 'initializing' holds tab events back meanwhile (a
      // tab filed before the default workspace existed created a second
      // one); the tail files what they missed.
      if (lastId == null) {
        console.log("[Brainer][_onWindowCreated] first-ever startup -- claiming:", window.id);
        const prevState = Brainer._state;
        Brainer._state = 'initializing';
        try {
          claimed = await Brainer._ensureDefaultWorkspace(window);
        } finally {
          Brainer._state = claimed != null ? 'ready' : prevState;
        }
        console.log("[Brainer][_onWindowCreated] default workspace ready -- state:", Brainer._state);
        return;
      }

      // The workspaces wait for their window (primary closed, restore
      // refused or failed): does this one take them over?
      const mode = await Brainer._windowTakeOverMode(window, lastId);
      if (!mode) return;
      if (Brainer._state !== 'uninitialized') return;
      console.log("[Brainer][_onWindowCreated] windowId:", window.id, "takes the workspaces of window", lastId,
        "over -- mode:", mode);
      await Brainer._takeOverWindow(window, mode);
      claimed = window.id;
      console.log("[Brainer][_onWindowCreated] take-over complete -- state: ready");
    } finally {
      Brainer._restoreInFlight = false;
      // Outside the claim: the tail waits for late tabs (X-35)
      if (claimed != null) await Brainer._settleReady(claimed, { lateTabs: true });
    }
  }

  // Whether a normal window opened while the workspaces wait for theirs
  // (primary window closed, restore refused or failed) takes them over.
  // Opening a window is not a browser restart (X-11): restoring into any new
  // window emptied every workspace into it and raised a false "not fully
  // restored" warning with a bookmark export (a window with a real first
  // tab), or tripped a false refuse-to-wipe (a blank one) -- and the closed
  // window, reopened from History, then came back unmanaged, its inactive
  // tabs hidden for good.
  //  - "restore": the window holds tabs tagged for the workspaces (the closed
  //    window reopened from History, or tabs Firefox restored late).
  //  - "adopt": the primary window closed while the browser kept running and
  //    nothing waits in it (no inactive workspace had tabs): the workspaces
  //    move to the new window, as its first tab joins the active one.
  //  - null: they keep waiting (for their window, a restart, or the banner).
  //    A closed primary window whose inactive tabs wait is reported once
  //    (the primary-window-closed banner offers it back).
  static async _windowTakeOverMode(window, lastId) {
    if (await Brainer._windowHoldsTaggedTabs(window.id, lastId)) return "restore";
    if (Brainer._refuseToWipeActive || !(await Brainer._awaitsClosedPrimary())) {
      console.log("[Brainer][_onWindowCreated] windowId:", window.id,
        "holds none of the waiting workspaces' tabs -- not taking them over");
      return null;
    }
    const workspaces = await WSPStorageManager.getWorkspaces(lastId);
    if (workspaces.every(w => w.active || w.tabs.length === 0)) return "adopt";
    console.log("[Brainer][_onWindowCreated] windowId:", window.id,
      "holds none of the closed primary window's tabs, whose inactive workspaces wait -- not taking them over");
    const closed = Brainer._closedPrimary;
    if (closed && !closed.noted) {
      closed.noted = true;
      if (!(await WSPStorageManager.getLastRestoreError())) await Brainer._noteClosedPrimaryWindow(lastId);
    }
    return null;
  }

  // Hand the waiting workspaces to `window`: "restore" (it holds their
  // tabs) or "adopt" (see _windowTakeOverMode). The caller holds
  // _restoreInFlight and runs _settleReady afterwards.
  static async _takeOverWindow(window, mode) {
    Brainer._state = 'restoring';
    try {
      await Brainer._restoreWorkspaces(window, { adopt: mode === "adopt", midSession: true });
    } catch (e) {
      Brainer._state = 'uninitialized';
      console.error("[Brainer][_takeOverWindow] failed:", e);
      throw e;
    }
    Brainer._state = 'ready';
  }

  // The workspaces wait for a primary window that closed while the browser
  // kept running: known in memory, or from the primary-window-closed banner
  // (it persists across an extension update or a restart).
  static async _awaitsClosedPrimary() {
    if (Brainer._closedPrimary) return true;
    try {
      return (await WSPStorageManager.getLastRestoreError())?.reason === Brainer.PRIMARY_CLOSED_REASON;
    } catch {
      return false;
    }
  }

  // ── Primary window closed mid-session (X-100) ──
  // Firefox closes a window when its last VISIBLE tab closes
  // (browser.tabs.closeWindowWithLastTab, true by default): hidden tabs do
  // not count, so closing the only tab of the workspace on screen closed
  // every other workspace's tabs with the window, and nothing said so. The
  // close cannot be intercepted. When another window stays open (not a
  // browser quit) and the closed window held tabs of inactive workspaces,
  // the restore-error banner reports it and offers a way back that the user
  // triggers (reopenClosedPrimaryWindow). Firefox keeps the window in
  // Recently Closed Windows; nothing is reopened automatically (gotcha 7).
  static PRIMARY_CLOSED_REASON = "primary-window-closed";

  // Returns whether the banner was raised.
  static async _noteClosedPrimaryWindow(windowId) {
    try {
      const others = (await browser.windows.getAll()).filter(w => w.id !== windowId);
      if (others.length === 0) return false; // browser quitting: the next start restores
      const workspaces = await WSPStorageManager.getWorkspaces(windowId);
      const inactive = workspaces.filter(w => !w.active && w.tabs.length > 0);
      const hiddenTabCount = inactive.reduce((n, w) => n + w.tabs.length, 0);
      if (hiddenTabCount === 0) return false;
      const payload = {
        when: Date.now(),
        reason: Brainer.PRIMARY_CLOSED_REASON,
        windowId,
        wspCount: workspaces.length,
        hiddenWspCount: inactive.length,
        hiddenTabCount,
      };
      console.warn("[Brainer][_noteClosedPrimaryWindow] primary window closed with",
        hiddenTabCount, "tab(s) of", inactive.length, "inactive workspace(s) -- payload:", JSON.stringify(payload));
      await WSPStorageManager.setLastRestoreError(payload);
      await UIService.refreshWarnBadge();
      return true;
    } catch (e) {
      console.warn("[Brainer][_noteClosedPrimaryWindow] failed:", e?.message);
      return false;
    }
  }

  // The first of `windows` holding a tab tagged for a workspace stored
  // under `oldWindowId` -- the one Firefox preserves across a close and a
  // reopen, so it identifies the workspaces' window. A window restored by
  // Firefox gets its tabs after windows.onCreated, so an empty first look
  // is retried once.
  static async _findTaggedWindow(windows, oldWindowId) {
    if (windows.length === 0) return null;
    const wspIds = new Set((await WSPStorageManager.getWorkspaces(oldWindowId)).map(w => w.id));
    if (wspIds.size === 0) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const win of windows) {
        const tabs = await browser.tabs.query({ windowId: win.id }).catch(() => []);
        for (const t of tabs) {
          try {
            if (wspIds.has(await browser.sessions.getTabValue(t.id, "wspId"))) return win;
          } catch { /* closed meanwhile */ }
        }
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, LIMITS.RESTORE_WINDOW_DELAY_MS));
    }
    return null;
  }

  static async _windowHoldsTaggedTabs(windowId, oldWindowId) {
    return (await Brainer._findTaggedWindow([{ id: windowId }], oldWindowId)) != null;
  }

  // The Recently Closed Windows entry of the closed primary window: the one
  // whose tabs match the most URLs recorded in its workspaces' snapshots.
  static async _findClosedPrimaryWindow(oldWindowId) {
    const workspaces = await WSPStorageManager.getWorkspaces(oldWindowId);
    const urls = new Set(workspaces.flatMap(w => [...(w.tabSnapshot || []), w.lastActiveTabUrl].filter(Boolean)));
    if (urls.size === 0) return null;
    let best = null;
    let bestScore = 0;
    for (const session of await browser.sessions.getRecentlyClosed()) {
      const win = session.window;
      if (!win?.sessionId) continue;
      const score = (win.tabs || []).filter(t => urls.has(t.url)).length;
      if (score > bestScore) { best = win; bestScore = score; }
    }
    return best;
  }

  // User-triggered (popup banner, handler reopenClosedPrimaryWindow): reopen
  // the closed primary window from Recently Closed Windows and restore the
  // workspaces into it, as the startup restore path does.
  static reopenClosedPrimaryWindow() {
    return Brainer._serializeTakeOver(() => Brainer._reopenClosedPrimaryWindow());
  }

  static async _reopenClosedPrimaryWindow() {
    const lastId = await WSPStorageManager.getPrimaryWindowLastId();
    if (Brainer._state !== 'uninitialized' || Brainer._restoreInFlight || Brainer._initStarted
        || lastId == null || (await WSPStorageManager.getPrimaryWindowId()) != null) {
      throw new Error(Brainer.NOTHING_TO_REOPEN_MESSAGE);
    }
    const entry = await Brainer._findClosedPrimaryWindow(lastId);
    if (!entry) throw new Error(Brainer.NOT_IN_RECENTLY_CLOSED_MESSAGE);
    // Synchronous claim: _onWindowCreated skips while a restore runs
    if (Brainer._restoreInFlight || Brainer._state !== 'uninitialized') {
      throw new Error(Brainer.NOTHING_TO_REOPEN_MESSAGE);
    }
    Brainer._restoreInFlight = true;
    Brainer._state = 'restoring';
    let windowId;
    try {
      console.log("[Brainer][reopenClosedPrimaryWindow] restoring closed window, sessionId:", entry.sessionId);
      const restored = await browser.sessions.restore(entry.sessionId);
      windowId = restored?.window?.id;
      if (windowId == null) throw new Error("sessions.restore returned no window");
      // Same settle as the startup restore: Firefox adds the tabs after the window
      await new Promise(r => setTimeout(r, LIMITS.RESTORE_DELAY_MS));
      await Brainer._restoreWorkspaces(await browser.windows.get(windowId), { midSession: true });
      Brainer._state = 'ready';
    } catch (e) {
      if (Brainer._state === 'restoring') Brainer._state = 'uninitialized';
      throw e;
    } finally {
      Brainer._restoreInFlight = false;
    }
    // Committed: the tail's failures no longer fail the request (X-06)
    await Brainer._settleReady(windowId, { lateTabs: true, settleMs: 0 });
    console.log("[Brainer][reopenClosedPrimaryWindow] done -- windowId:", windowId);
    return { windowId };
  }

  // User-facing refusals of reopenClosedPrimaryWindow (handler.js passes
  // them through).
  static NOTHING_TO_REOPEN_MESSAGE = "Nothing to reopen - the workspaces are not waiting for a closed window.";
  static NOT_IN_RECENTLY_CLOSED_MESSAGE =
    "The closed window is no longer in Firefox's Recently Closed Windows list (History menu).";

  // ── Banner actions: Dismiss and Give up (X-34) ──

  // After Dismiss (handler acknowledgeLastRestoreError). Dismissing used to
  // leave the extension inert until a restart when the start had failed or
  // the restore was refused. Now a failed start is retried at once, and
  // workspaces waiting for their window are restored into a normal window
  // that already holds their tabs (Firefox may have finished restoring them
  // since the banner went up). Nothing else: a refused restore is not run
  // again against a window without them, so the banner the user just
  // dismissed does not come straight back. Resolves to whether the
  // extension is ready afterwards; never throws.
  static resumeAfterDismiss() {
    return Brainer._serializeTakeOver(() => Brainer._resumeAfterDismiss());
  }

  static async _resumeAfterDismiss() {
    try {
      if (Brainer._state !== 'uninitialized' || Brainer._initStarted || Brainer._restoreInFlight) return false;
      if (Brainer._initFailure) return await Brainer.retryInitialize("dismiss");
      const [primaryId, lastId] = await Promise.all([
        WSPStorageManager.getPrimaryWindowId(),
        WSPStorageManager.getPrimaryWindowLastId(),
      ]);
      if (primaryId != null || lastId == null) return false;
      if (Brainer._restoreInFlight || Brainer._state !== 'uninitialized') return false;
      Brainer._restoreInFlight = true;
      let target = null;
      try {
        target = await Brainer._findTaggedWindow(await Brainer._normalWindows(), lastId);
        if (!target || Brainer._state !== 'uninitialized') return false;
        console.log("[Brainer][resumeAfterDismiss] window", target.id, "holds the waiting workspaces' tabs -- restoring");
        await Brainer._takeOverWindow(target, "restore");
      } finally {
        Brainer._restoreInFlight = false;
      }
      await Brainer._settleReady(target.id, { lateTabs: true });
      return true;
    } catch (e) {
      console.error("[Brainer][resumeAfterDismiss] failed:", e);
      return false;
    }
  }

  static RESTORE_BUSY_MESSAGE = "Workspaces is restoring the previous session - please try again in a moment.";

  // Give up (handler giveUpRestoreRetry): drop the restore-retry signal for
  // good and start over in the current window.
  //  - Refused while a start or a restore runs (X-72): the restore commits
  //    anyway, and the give-up's clear wiped the warning it wrote.
  //  - The waiting workspaces' snapshots are exported to bookmarks first,
  //    then the old window's index is detached (X-71): Firefox numbers
  //    windows from low ids each session, and a later first window with
  //    the same id adopted the given-up workspaces instead of the promised
  //    fresh default. The index stays when the export failed, so nothing is
  //    stranded without a copy (the orphan sweep retries it).
  //  - The banner is cleared compare-and-clear again after the slow export:
  //    a warning written meanwhile is not the one the user gave up on.
  //  - Then the first-start path runs against the focused normal window
  //    (X-34): the extension used to stay inert until the next Firefox start.
  // `when`: the payload the popup displayed (null: old popup, no check).
  // Resolves to { stale } or { exported }. A take-over already running
  // (a window, Dismiss) is waited for; the `when` check then tells whether
  // it changed what the user gave up on.
  static giveUpRestore(when = null) {
    return Brainer._serializeTakeOver(() => Brainer._giveUpRestore(when));
  }

  static async _giveUpRestore(when) {
    if (Brainer._initStarted || Brainer._restoreInFlight
        || Brainer._state === 'initializing' || Brainer._state === 'restoring') {
      throw new Error(Brainer.RESTORE_BUSY_MESSAGE);
    }
    const isStale = (pending) => when != null && pending != null
      && Number.isFinite(pending.when) && pending.when !== when;
    if (isStale(await WSPStorageManager.getLastRestoreError())) return { stale: true };
    Brainer._restoreInFlight = true;
    let exported = { folders: 0, urls: 0, deduped: false };
    try {
      const [lastId, primaryId] = await Promise.all([
        WSPStorageManager.getPrimaryWindowLastId(),
        WSPStorageManager.getPrimaryWindowId(),
      ]);
      // With a primary set the retry signal is a leftover (a crash between
      // onWindowRemoved's two writes) and may name the live primary window:
      // dropped below, its index never touched.
      if (lastId != null && primaryId == null) {
        const orphans = await WSPStorageManager.getWorkspaces(lastId);
        exported = await Brainer._exportSnapshotsSafe(orphans);
        const exportable = orphans.some(w => (w.tabSnapshot || []).length > 0);
        if (exported.folders > 0 || exported.deduped || !exportable) {
          await WSPStorageManager.detachWindow(lastId);
        } else {
          console.warn("[Brainer][giveUpRestore] bookmark export failed -- keeping window", lastId,
            "index for the orphan sweep to retry");
        }
      }
      if (!isStale(await WSPStorageManager.getLastRestoreError())) {
        await WSPStorageManager.clearLastRestoreError();
      }
      await WSPStorageManager.removePrimaryWindowLastId();
      Brainer._refuseToWipeActive = false;
      Brainer._closedPrimary = null;
    } finally {
      Brainer._restoreInFlight = false;
    }
    await UIService.refreshWarnBadge();
    // Start over now. With a primary still set (a restore committed before
    // the give-up), there is nothing to start.
    if (Brainer._state === 'uninitialized' && !Brainer._initStarted
        && (await WSPStorageManager.getPrimaryWindowId()) == null) {
      console.log("[Brainer][giveUpRestore] starting over in the current window");
      await Brainer.initialize();
    }
    return { exported };
  }

  // AMO updates restart the background at once unless something listens to
  // runtime.onUpdateAvailable. Applied only when no activation, create,
  // destroy, restore, container migration or tab reopen runs, so an update
  // cannot cut a multi-step operation in half (X-95, X-99): a container
  // migration takes the tab ids out of storage before the reopened tabs are
  // filed and tagged. If that never happens, Firefox applies it at the next
  // start.
  static async _reloadWhenIdle() {
    if (Brainer._reloadPending) return;
    Brainer._reloadPending = true;
    for (;;) {
      await WorkspaceService.whenActivationsSettled();
      const busy = Brainer._initStarted || Brainer._restoreInFlight
        || Brainer._state === 'initializing' || Brainer._state === 'restoring'
        || WorkspaceService._pendingDestroys.size > 0 || WorkspaceService._handoffs.size > 0
        || WorkspaceService.isActivating() || WorkspaceService._migrationsInFlight > 0
        || TabService._reopeningCount > 0;
      if (!busy) break;
      await new Promise(r => setTimeout(r, 500));
    }
    console.log("[Brainer][_reloadWhenIdle] idle -- applying the update");
    browser.runtime.reload();
  }

  // Identity check for the stored primaryWindowId (undetected-restart guard).
  // After a crash the stored ID can match a LIVE window that is a different
  // physical window than the one the workspaces belong to (Firefox reassigns
  // window IDs from low numbers each session). Trusting it would run
  // _cleanStaleTabIds against the wrong window, stripping every real tab ID
  // from the stored workspaces before reconciliation can use them.
  // Identity is tested via the per-tab session values Firefox preserves
  // across restarts: the ID is rejected only when the presumed primary
  // window holds ZERO tabs tagged for its stored workspaces while another
  // window holds at least one. Indeterminate evidence (no tagged tabs
  // anywhere, e.g. session restore disabled) trusts the stored ID -- the
  // same behavior as before this guard existed.
  static async _primaryWindowHoldsItsWorkspaces(windowId) {
    const workspaces = await WSPStorageManager.getWorkspaces(windowId);
    if (workspaces.length === 0) return true; // nothing to protect
    const allWindows = await Brainer._normalWindows();
    if (allWindows.length <= 1) return true;  // no other window to confuse it with
    const wspIds = new Set(workspaces.map(w => w.id));

    const countTagged = async (winId) => {
      const tabs = await browser.tabs.query({ windowId: winId, pinned: false });
      const tags = await Promise.all(tabs.map(async (t) => {
        try { return await browser.sessions.getTabValue(t.id, "wspId"); }
        catch { return null; }
      }));
      return tags.filter(sv => sv && wspIds.has(sv)).length;
    };

    const ownCount = await countTagged(windowId);
    if (ownCount > 0) return true; // fast path: identity confirmed
    for (const win of allWindows) {
      if (win.id === windowId) continue;
      const count = await countTagged(win.id);
      if (count > 0) {
        console.warn("[Brainer][_primaryWindowHoldsItsWorkspaces] window", win.id,
          "holds", count, "tab(s) tagged for workspaces stored under window", windowId);
        return false;
      }
    }
    return true;
  }

  // Pick the window that corresponds to the old primary window.
  // With multiple windows (e.g. user had 2 windows open), getCurrent() may
  // return a fresh blank window instead of the session-restored one.
  // We score each window by how many of its tab URLs appear in the saved
  // workspace snapshots, with one retry to tolerate session-restore lag.
  // Normal windows only (X-118); null when none is open. `requireTags`:
  // only a window holding the workspaces' tagged tabs qualifies (they wait
  // for a primary window that closed while the browser kept running, X-11).
  static async _findRestoreWindow(oldWindowId, { requireTags = false } = {}) {
    const allWindows = await Brainer._normalWindows();
    console.log("[Brainer][_findRestoreWindow] oldWindowId:", oldWindowId, "normal windows:", allWindows.map(w => w.id),
      "requireTags:", requireTags);
    if (requireTags) return Brainer._findTaggedWindow(allWindows, oldWindowId);
    if (allWindows.length === 0) return null;
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

  // Rebind the workspaces waiting under primaryWindowLastId to `window`.
  // Startup restore by default.
  //  - `midSession`: the window takes them over while the browser keeps
  //    running (_windowTakeOverMode, Dismiss, the banner's reopen). The
  //    commit clears the warnings about the wait (refused or failed
  //    restore, closed primary window) but keeps an unread report of what
  //    an earlier restore did to the tabs (_REPORTS_KEPT_BY_TAKEOVER).
  //  - `adopt` (implies midSession): the window holds none of their tabs
  //    and nothing waits for the closed one (X-11). Its tabs join the active
  //    workspace without the URL-snapshot matching, and the startup checks
  //    (refuse-to-wipe, incomplete-restore export and warning) are skipped:
  //    the tabs are gone because the user closed their window, not because
  //    a restart lost them.
  static _REPORTS_KEPT_BY_TAKEOVER = new Set(["session-not-restored", "tabs-closed-at-startup"]);

  static async _restoreWorkspaces(window, { adopt = false, midSession = adopt } = {}) {
    console.log("[Brainer][_restoreWorkspaces] windowId:", window.id, "adopt:", adopt, "midSession:", midSession);
    // All tab IDs are invalidated across restart; clear stale force-reopen entries
    TabService._forceReopenIds.clear();

    // ── Phase 1: read everything we need into memory. NO writes yet. ──
    const newTabs = await browser.tabs.query({windowId: window.id});
    console.log("[Brainer][_restoreWorkspaces] tabs in window:", newTabs.length);

    const sessionMap = new Map();
    // Thrown lookups are counted separately from "no value": a degraded
    // sessions API must not read as "zero tagged tabs" to the session-loss
    // detector below (a throw is not evidence of absence).
    let sessionLookupFailures = 0;
    await Promise.all(newTabs.map(async (tab) => {
      try {
        const wspId = await browser.sessions.getTabValue(tab.id, "wspId");
        if (wspId) sessionMap.set(tab.id, wspId);
      } catch (e) {
        sessionLookupFailures++;
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
    // Hidden tabs of a workspace whose destroy was cut short: closed in
    // Phase 4 instead of being filed and shown (X-96).
    const pendingDestroys = await WSPStorageManager.getPendingDestroys();
    const destroyLeftovers = [];

    for (const tab of newTabs) {
      if (tab.pinned) continue;
      const wspId = sessionMap.get(tab.id);
      if (tab.hidden && wspId && !wspIdSet.has(wspId)
          && await Brainer._isDestroyLeftover(wspId, pendingDestroys)) {
        destroyLeftovers.push(tab.id);
        continue;
      }
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
    if (adopt) {
      unmatchedTabs.push(...untaggedTabs);
    } else if (untaggedTabs.length > 0) {
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

    // Exactly one active workspace (X-95). An activation, create or destroy
    // cut short by the background's death can leave none -- every tab but
    // the selected one was then hidden below -- or two. Keep the one that
    // owns the selected tab, else the first flagged one, else the first in
    // the saved order.
    const flagged = wspData.filter(w => w.active);
    if (wspData.length > 0 && flagged.length !== 1) {
      const selected = newTabs.find(t => t.active);
      const ownerId = selected ? [...assigned].find(([, ids]) => ids.includes(selected.id))?.[0] : null;
      const owner = wspData.find(w => w.id === ownerId);
      const keep = (owner && (flagged.length === 0 || owner.active) ? owner : null)
        ?? flagged[0]
        ?? wspData.find(w => w.id === oldOrder?.find(id => wspIdSet.has(id)))
        ?? wspData[0];
      console.warn("[Brainer][_restoreWorkspaces]", flagged.length, "workspaces flagged active -- keeping",
        keep.id, keep.name);
      for (const w of wspData) w.active = w === keep;
    }

    const totalAssigned = [...assigned.values()].reduce((n, a) => n + a.length, 0);
    const hadRecoverableData = wspData.some(w => w.tabSnapshot.length > 0);
    const snapshotUrlCount = wspData.reduce((n, w) => n + w.tabSnapshot.length, 0);
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
    const liveContentTabs = newTabs.filter(t => !t.pinned && t.url && !Brainer._PLACEHOLDER_URL_RE.test(t.url)
      && !destroyLeftovers.includes(t.id));
    if (!adopt && wspData.length > 0 && totalAssigned === 0 && liveContentTabs.length === 0 && hadRecoverableData) {
      const errorPayload = {
        when: Date.now(),
        reason: "refuse-to-wipe",
        oldWindowId,
        newWindowId: window.id,
        wspCount: wspData.length,
        snapshotUrlCount,
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
      // Paint the "!" badge proactively -- in this state no primary window
      // exists, so without this only an incidental focus change would show it.
      UIService.refreshWarnBadge().catch(() => {});
      Brainer._refuseToWipeActive = true;
      throw new Error(
        `Refuse-to-wipe: would recreate ${wspData.length} workspaces with 0 tabs ` +
        `while ${errorPayload.snapshotUrlCount} snapshot URLs exist; user data left untouched.`
      );
    }

    // Phase 3b: incomplete session restore. Preserve snapshots before any
    // tab activity can refresh them away, then continue with live tabs only.
    // Missing tags/URLs do not establish why tabs are absent. In particular,
    // Firefox can put intentionally closed tabs into the recently-closed
    // list with fresh timestamps at startup. Never use that list as consent
    // to reopen tabs; recovery from the bookmark backup is user-initiated.
    // Fingerprint dedup avoids repeated exports and warnings for the same
    // snapshot content. Placeholder-only starts still use refuse-to-wipe.
    const sessionLost = !adopt && Brainer._isSessionLost({
      snapshotUrlCount,
      taggedCount: [...sessionMap.values()].filter(v => wspIdSet.has(v)).length,
      survivingUrlCount: totalAssigned,
      liveContentCount: liveContentTabs.length,
      lookupFailures: sessionLookupFailures,
    });
    let sessionLossExport = null;
    if (sessionLost) {
      console.warn("[Brainer][_restoreWorkspaces] incomplete session restore --",
        snapshotUrlCount, "snapshot URL(s) but", totalAssigned,
        "assigned and 0 session-tagged; exporting snapshots without reopening closed tabs");
      sessionLossExport = await Brainer._exportSnapshotsSafe(wspData);
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
        await WSPStorageManager.withOrderLock(window.id,
          () => WSPStorageManager.saveWorkspaceOrder(window.id, oldOrder));
      }

      // Detach old window's metadata only. Per-workspace state was already
      // rewritten above, so we keep the shared `ld-wsp-{wspId}` and
      // `ld-wsp-closed-{wspId}` keys intact -- detachWindow only touches the
      // window-keyed indexes.
      if (oldWindowId != null && oldWindowId !== window.id) {
        console.log("[Brainer][_restoreWorkspaces] detaching old window metadata:", oldWindowId);
        await WSPStorageManager.detachWindow(oldWindowId);
      }

      await Brainer._closeDestroyLeftovers(destroyLeftovers);

      // Truly unmatched tabs go to the active workspace via the normal entry point.
      for (const tab of unmatchedTabs) {
        console.log("[Brainer][_restoreWorkspaces] no URL match, adding to active workspace:", tab.url);
        if (await TabService.addTabToWorkspace(tab, { skipForceContainer: true })) {
          await TabService.showTabs(tab.id);
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
            // Only the lastActiveTabId field, on the fresh record
            await WSPStorageManager.mutateWorkspace(wsp.id, (fresh) => {
              if (fresh.tabs.length === 0 || fresh.tabs.includes(fresh.lastActiveTabId)) return false;
              fresh.lastActiveTabId = fresh.tabs.includes(remapped) ? remapped : fresh.tabs[0];
            });
          }
        }
      }

      const activeWspData = wspData.find(w => w.active);
      console.log("[Brainer][_restoreWorkspaces] active workspace:", activeWspData?.id, activeWspData?.name);
      if (activeWspData) {
        const activeWspObj = await WSPStorageManager.getWorkspace(activeWspData.id);
        if (await activeWspObj.activate()) {
          WorkspaceService._updateActiveCache(window.id, activeWspObj.tabs, activeWspObj.id, activeWspObj.containerId);
        }
      }

      await WorkspaceService.hideInactiveWspTabs(window.id, activeWspData ? activeWspData.id : null);

      // Final commit: claim primary, drop the retry signal, clear any banner.
      // If anything above threw, we never get here; the next restart will see
      // primaryWindowId still null and primaryWindowLastId still set, and the
      // restart-detect path retries from scratch.
      await WSPStorageManager.setPrimaryWindowId(window.id);
      Brainer._primaryWindowId = window.id;
      await WSPStorageManager.removePrimaryWindowLastId();
      if (!midSession
          || !Brainer._REPORTS_KEPT_BY_TAKEOVER.has((await WSPStorageManager.getLastRestoreError())?.reason)) {
        await WSPStorageManager.clearLastRestoreError();
      }
      Brainer._refuseToWipeActive = false;
      if (sessionLost) {
        if (sessionLossExport?.deduped) {
          // Same loss content as the last announced one (the steady state for
          // a clear-history-on-close user): the bookmarks already exist and
          // the user already saw -- or dismissed -- the banner. Re-arming it
          // on every start would just train the user to ignore it.
          console.log("[Brainer][_restoreWorkspaces] session loss unchanged since last export -- banner not re-armed");
        } else {
          await Brainer._flagSessionLoss({
            windowId: window.id,
            wspCount: wspData.length,
            snapshotUrlCount,
            exportedWorkspaces: sessionLossExport?.folders ?? 0,
            exportedUrls: sessionLossExport?.urls ?? 0,
          });
        }
      }
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
      // Carry incomplete-restore evidence and actual export counts into the
      // failure payload so the popup can point to voluntary recovery without
      // assuming a wiped session store or promising a retry will recover tabs.
      if (sessionLost) {
        errorPayload.sessionLost = true;
        errorPayload.exportedWorkspaces = sessionLossExport?.folders ?? 0;
        errorPayload.exportedUrls = sessionLossExport?.urls ?? 0;
      }
      console.error("[Brainer][_restoreWorkspaces] Phase 4 threw -- payload:", JSON.stringify(errorPayload), "error:", e);
      try { await WSPStorageManager.setLastRestoreError(errorPayload); }
      catch (writeErr) { console.error("[Brainer][_restoreWorkspaces] failed to surface phase4 banner:", writeErr); }
      UIService.refreshWarnBadge().catch(() => {});
      Brainer._refuseToWipeActive = true;
      throw e;
    }
  }

  // Single source of truth for the session-loss verdict. Both detection paths
  // (Phase 3b of _restoreWorkspaces and _detectSessionLoss) feed their
  // evidence through here so the thresholds and semantics can never drift.
  //  - snapshotUrlCount:  URLs recorded across all workspace tabSnapshots
  //  - taggedCount:       open tabs whose session value names a stored workspace
  //  - survivingUrlCount: snapshot URLs found among live tab URLs, counted by
  //                       consumption (each snapshot entry matches at most one tab)
  //  - liveContentCount:  live non-placeholder tabs (0 = refuse-to-wipe territory)
  //  - lookupFailures:    sessions.getTabValue calls that THREW. A throw is
  //                       not evidence of absence: with zero tags and failed
  //                       lookups the verdict is indeterminate, not "lost".
  static _isSessionLost({ snapshotUrlCount, taggedCount, survivingUrlCount,
                          liveContentCount, lookupFailures = 0 }) {
    if (snapshotUrlCount < LIMITS.SESSION_LOSS_MIN_SNAPSHOT_URLS) return false;
    if (taggedCount > 0) return false;
    if (lookupFailures > 0) return false;
    if (liveContentCount === 0) return false;
    return survivingUrlCount < snapshotUrlCount * LIMITS.SESSION_LOSS_SURVIVAL_RATIO;
  }

  // Stable fingerprint of the exportable snapshot content. Used to make the
  // automatic bookmark export idempotent: the same loss re-observed on a later
  // start (identical workspace ids + snapshot URLs) is not exported again.
  static _snapshotFingerprint(workspaces) {
    const parts = workspaces
      .map(w => w.id + ":" + (w.tabSnapshot || []).join("\n"))
      .sort()
      .join("\n\n");
    let h = 5381;
    for (let i = 0; i < parts.length; i++) {
      h = ((h << 5) + h + parts.charCodeAt(i)) >>> 0;
    }
    return h + ":" + parts.length;
  }

  // Best-effort bookmark export of workspace URL snapshots. Never throws:
  // the export is a safety net and must not block restore/repair.
  // Deduplicated via a persisted content fingerprint -- for a user whose
  // session store is wiped on every start, the same loss is re-detected at
  // every launch and would otherwise mint duplicate folders without bound.
  // Returns { folders, urls, deduped }; a failed export returns zeros WITHOUT
  // storing the fingerprint, so the next start retries.
  // Check, export and record run as one step under the export lock: two
  // exporters (startup sweep, session-loss detection, Give up) overlapping
  // could both pass the check and export the same content twice.
  static async _exportSnapshotsSafe(workspaces) {
    try {
      return await WSPStorageManager.withSessionLossExportLock(async () => {
        const fingerprint = Brainer._snapshotFingerprint(workspaces);
        const known = await WSPStorageManager.getSessionLossExportFingerprints();
        if (known.includes(fingerprint)) {
          console.log("[Brainer][_exportSnapshotsSafe] identical snapshot content already exported -- skipping");
          return { folders: 0, urls: 0, deduped: true };
        }
        const result = await BookmarkService.exportSnapshots(workspaces);
        console.log("[Brainer][_exportSnapshotsSafe] exported", result.urls,
          "URL(s) across", result.folders, "folder(s)");
        if (result.folders > 0) {
          await WSPStorageManager.addSessionLossExportFingerprint(fingerprint);
        }
        return { ...result, deduped: false };
      });
    } catch (e) {
      console.error("[Brainer][_exportSnapshotsSafe] export failed:", e?.message);
      return { folders: 0, urls: 0, deduped: false };
    }
  }

  // Surface incomplete startup recovery via the existing session-not-restored
  // reason and "!" badge. This is evidence of missing tabs, not their cause.
  static async _flagSessionLoss(details) {
    // "Permanent private browsing" is only a safe diagnosis when EVERY window
    // is private -- a single incognito window picked as restore window proves
    // nothing about the pref. Computed here so both detection paths agree.
    let privateBrowsing = false;
    try {
      const wins = await browser.windows.getAll();
      privateBrowsing = wins.length > 0 && wins.every(w => w.incognito);
    } catch (e) {
      console.debug("[Brainer][_flagSessionLoss] windows.getAll failed:", e?.message);
    }
    const payload = {
      when: Date.now(),
      reason: "session-not-restored",
      privateBrowsing,
      ...details,
    };
    console.warn("[Brainer][_flagSessionLoss] payload:", JSON.stringify(payload));
    try {
      await WSPStorageManager.setLastRestoreError(payload);
    } catch (e) {
      // The banner is gone for this session, but the badge can still signal:
      // force the cache to "warning pending" so the user gets at least the
      // toolbar-level cue that something happened to their tabs.
      console.error("[Brainer][_flagSessionLoss] failed to store warning:", e?.message);
      UIService.forceWarnBadge();
    }
    await UIService.refreshWarnBadge(details.windowId ?? null);
  }

  // Session-loss detection for the already-running / undetected-restart path.
  // Same evidence -> same verdict as Phase 3b of _restoreWorkspaces: both
  // paths call _isSessionLost; only the evidence gathering differs (here the
  // window is already live, there it comes from the restore's Phase 1 reads).
  // Must run BEFORE anything that can trigger a snapshot refresh (the refresh
  // would overwrite the last good tabSnapshot with the post-loss state).
  static async _detectSessionLoss(windowId) {
    try {
      const workspaces = await WSPStorageManager.getWorkspaces(windowId);
      const snapshotUrlCount = workspaces.reduce((n, w) => n + (w.tabSnapshot || []).length, 0);
      const wspIds = new Set(workspaces.map(w => w.id));
      // All tabs, pinned included: a pinned tagged tab is evidence the
      // session survived, same as Phase 3b's sessionMap.
      const tabs = await browser.tabs.query({ windowId });
      const liveContent = tabs.filter(t => !t.pinned && t.url && !Brainer._PLACEHOLDER_URL_RE.test(t.url));
      let tagged = 0;
      let lookupFailures = 0;
      await Promise.all(tabs.map(async (t) => {
        try {
          const sv = await browser.sessions.getTabValue(t.id, "wspId");
          if (sv && wspIds.has(sv)) tagged++;
        } catch (e) {
          lookupFailures++;
          console.debug("[Brainer][_detectSessionLoss] session lookup failed for tab",
            t.id, ":", e.message);
        }
      }));
      // Consumption-based matching, same as Phase 3b's URL fallback: each
      // snapshot entry consumes at most one live tab, so duplicate snapshot
      // URLs cannot all be "matched" by a single surviving tab.
      const liveUrlCounts = new Map();
      for (const t of tabs) {
        if (t.url) liveUrlCounts.set(t.url, (liveUrlCounts.get(t.url) || 0) + 1);
      }
      let matched = 0;
      for (const u of workspaces.flatMap(w => w.tabSnapshot || [])) {
        const n = liveUrlCounts.get(u) || 0;
        if (n > 0) { matched++; liveUrlCounts.set(u, n - 1); }
      }
      if (!Brainer._isSessionLost({
        snapshotUrlCount,
        taggedCount: tagged,
        survivingUrlCount: matched,
        liveContentCount: liveContent.length,
        lookupFailures,
      })) return;
      console.warn("[Brainer][_detectSessionLoss] incomplete session restore --",
        snapshotUrlCount, "snapshot URL(s),", matched, "matched, 0 session-tagged");
      // Export FIRST, before any guard can skip it: the repair that follows
      // re-tags tabs and schedules snapshot refreshes that destroy this
      // evidence. The fingerprint inside _exportSnapshotsSafe keeps repeats
      // cheap and duplicate-free.
      const exported = await Brainer._exportSnapshotsSafe(workspaces);
      // Flag only when there is something new to say: an unrelated pending
      // banner keeps priority on the single-slot surface, and a deduplicated
      // re-observation of the same loss was already announced.
      if (await WSPStorageManager.getLastRestoreError()) {
        console.log("[Brainer][_detectSessionLoss] banner already pending -- export done, flag skipped");
        return;
      }
      if (exported.deduped) {
        console.log("[Brainer][_detectSessionLoss] loss unchanged since last export -- banner not re-armed");
        return;
      }
      await Brainer._flagSessionLoss({
        windowId,
        wspCount: workspaces.length,
        snapshotUrlCount,
        exportedWorkspaces: exported.folders,
        exportedUrls: exported.urls,
      });
    } catch (e) {
      console.warn("[Brainer][_detectSessionLoss] failed:", e?.message);
    }
  }

  // C-19: classify window-keyed workspace indexes against reality. A window
  // key whose id is neither a live window, nor the primary, nor the armed
  // restart signal (primaryWindowLastId) belongs to a window that will never
  // come back -- its workspaces are invisible to every windowId-keyed
  // recovery path. Pure function: all I/O stays in the caller.
  static _findOrphanWindowIds(storageSnapshot, { liveWindowIds, primaryId, lastId }) {
    const prefix = "ld-wsp-window-";
    const orphans = [];
    for (const [key, value] of Object.entries(storageSnapshot)) {
      if (!key.startsWith(prefix)) continue;
      const id = Number(key.slice(prefix.length));
      if (!Number.isInteger(id)) continue;
      if (!Array.isArray(value) || value.length === 0) continue;
      if (id === primaryId || id === lastId) continue;
      if (liveWindowIds.has(id)) continue;
      orphans.push(id);
    }
    return orphans;
  }

  // C-19 sweep: export and detach workspaces stranded under dead window ids
  // (crash leftovers from pre-swap versions, or any historical corruption).
  // Runs fire-and-forget after init settles: orphan records have no live
  // tabs, so nothing here races the repair or snapshot-refresh machinery.
  // Never throws. No popup banner by design -- the exported folders surface
  // through the existing "Restore from bookmarks" flow.
  static async _recoverOrphanWorkspaces() {
    try {
      const [snapshot, wins, primaryId, lastId] = await Promise.all([
        browser.storage.local.get(null),
        browser.windows.getAll(),
        WSPStorageManager.getPrimaryWindowId(),
        WSPStorageManager.getPrimaryWindowLastId(),
      ]);
      const orphanIds = Brainer._findOrphanWindowIds(snapshot, {
        liveWindowIds: new Set(wins.map(w => w.id)),
        primaryId,
        lastId,
      });
      if (orphanIds.length === 0) return;
      for (const windowId of orphanIds) {
        const workspaces = await WSPStorageManager.getWorkspaces(windowId);
        const exportable = workspaces.filter(w => (w.tabSnapshot || []).length > 0);
        console.warn("[Brainer][_recoverOrphanWorkspaces] dead window", windowId,
          "still owns", workspaces.length, "workspace(s),", exportable.length, "with snapshots");
        if (exportable.length > 0) {
          const exported = await Brainer._exportSnapshotsSafe(exportable);
          if (exported.folders === 0 && !exported.deduped) {
            // Export failed outright: keep the records so the next start
            // retries. Detaching now would strand data with no bookmark copy.
            console.warn("[Brainer][_recoverOrphanWorkspaces] export failed for window",
              windowId, "-- keeping records for retry");
            continue;
          }
        }
        // Data (if any) is in bookmarks; drop only the window-keyed indexes.
        // Per-workspace ld-wsp-{id} records stay for the diagnostics dump.
        await WSPStorageManager.detachWindow(windowId);
        console.warn("[Brainer][_recoverOrphanWorkspaces] detached dead window", windowId);
      }
    } catch (e) {
      console.warn("[Brainer][_recoverOrphanWorkspaces] failed:", e?.message);
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
        await WSPStorageManager.mutateWorkspace(wsp.id, (fresh) => {
          fresh.tabs = fresh.tabs.filter(id => openTabIds.has(id));
          for (const group of fresh.groups) {
            group.tabs = group.tabs.filter(id => openTabIds.has(id));
          }
        });
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
      // The plan was computed from the read above; merge it with any locked
      // write that landed since instead of overwriting: drop ids this
      // workspace lost meanwhile, keep ids it gained that the plan knows
      // nothing about.
      const planned = new Set(w.tabs);
      await WSPStorageManager.mutateWorkspace(w.id, (fresh) => {
        const current = new Set(fresh.tabs);
        fresh.tabs = [
          ...next.filter(id => !planned.has(id) || current.has(id)),
          ...fresh.tabs.filter(id => !planned.has(id) && !desiredOf.has(id)),
        ];
        // Group membership is rebuilt on activate; just drop IDs that left.
        const nextSet = new Set(fresh.tabs);
        for (const g of fresh.groups) g.tabs = g.tabs.filter(id => nextSet.has(id));
      });
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
  // by session value (and URL snapshot when a restart is likely), re-apply
  // the one-active invariant and visibility, then assign any leftovers.
  // Idempotent: writes nothing when assignments already match session values
  // and one workspace is active.
  static async _repairTabAssignments(windowId, restartLikely = false) {
    // Hold back pending snapshot refreshes (scheduled before an onStartup
    // that fired after init): they would land between the repair's writes
    // and could overwrite the snapshots the session-loss check reads.
    // Re-armed once the repair is done.
    const deferred = TabService._cancelSnapshotRefreshes(windowId);
    try {
      // Session-loss check first: _reconcileLateTabs below can assign tabs and
      // schedule snapshot refreshes, which would destroy the evidence (and the
      // last good snapshots) this check needs.
      if (restartLikely) await Brainer._detectSessionLoss(windowId);
      await Brainer._cleanStaleTabIds(windowId);
      const corrected = await Brainer._reconcileFromSessionValues(windowId, restartLikely);
      // Every time, not only after a correction: see _enforceActiveWorkspace.
      await Brainer._enforceActiveWorkspace(windowId, { reactivate: corrected });
      await Brainer._reconcileLateTabs(windowId);
      return corrected;
    } finally {
      for (const wspId of deferred) TabService._scheduleSnapshotRefresh(windowId, wspId);
    }
  }

  // One active workspace, the right tabs on screen and a primed active cache
  // on the already-running path, whatever the reconcile found:
  //  - Firefox shows every tab this extension hid when it is disabled, and
  //    re-enabling it (also the "Run in Private Windows" toggle, which
  //    reloads it) left every workspace's tabs mixed in the strip: the
  //    session tags still agree with the stored lists, so nothing re-hid
  //    them (X-94).
  //  - An activation, create or destroy cut short by the background's death
  //    can leave no workspace active, or two (X-95).
  //  - Nothing primed the active cache on this path, which kept navigation-
  //    time container enforcement and the URL snapshot refresh off until
  //    the first switch (X-10).
  // The workspace that owns the selected tab wins (the user is looking at
  // it), else the flagged one, else the first in the saved order. A full
  // activation runs only when that workspace is not the one flagged active
  // or `reactivate` is set (the reconcile moved tabs); otherwise its hidden
  // tabs are shown and every other workspace's tabs hidden.
  static async _enforceActiveWorkspace(windowId, { reactivate = false } = {}) {
    const workspaces = await WorkspaceService.getOrderedWorkspaces(windowId);
    if (workspaces.length === 0) return;
    const [selected] = await browser.tabs.query({ windowId, active: true });
    const owner = selected ? workspaces.find(w => w.tabs.includes(selected.id)) : null;
    const flagged = workspaces.filter(w => w.active);
    const target = owner ?? flagged[0] ?? workspaces[0];
    if (reactivate || !target.active) {
      console.warn("[Brainer][_enforceActiveWorkspace] activating", target.id, target.name,
        "| flagged active:", flagged.map(w => w.id), "| reactivate:", reactivate);
      // Stands every other flagged workspace down and primes the cache
      await WorkspaceService.activateWsp(target.id, windowId, owner === target ? selected.id : null);
      return;
    }
    for (const w of flagged) {
      if (w.id === target.id) continue;
      console.warn("[Brainer][_enforceActiveWorkspace] workspace", w.id, "was also flagged active -- standing it down");
      await WSPStorageManager.mutateWorkspace(w.id, (fresh) => {
        if (!fresh.active) return false;
        fresh.active = false;
      });
    }
    const hiddenOwn = (await browser.tabs.query({ windowId, hidden: true }))
      .filter(t => target.tabs.includes(t.id)).map(t => t.id);
    if (hiddenOwn.length > 0) await TabService.showTabs(hiddenOwn);
    await WorkspaceService.hideInactiveWspTabs(windowId, target.id);
    const fresh = await WSPStorageManager.getWorkspace(target.id);
    if (fresh.windowId != null) {
      WorkspaceService._updateActiveCache(windowId, fresh.tabs, fresh.id, fresh.containerId);
    }
  }

  // Catch tabs that Firefox session-restored during the 'restoring' phase.
  // Their onTabCreated events were blocked, so they need explicit assignment.
  // Tabs filed into the active workspace are shown: a hidden one used to
  // become an invisible member of the workspace on screen (X-96).
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
    const leftovers = [];
    const pendingDestroys = await WSPStorageManager.getPendingDestroys();

    for (const tab of untracked) {
      let wspId;
      try { wspId = await browser.sessions.getTabValue(tab.id, "wspId"); }
      catch (e) { console.debug("[Brainer][_reconcileLateTabs] session lookup failed for tab", tab.id, ":", e.message); }
      const target = wspId ? workspaces.find(w => w.id === wspId) : null;
      if (target) {
        if (!byWsp.has(wspId)) byWsp.set(wspId, []);
        byWsp.get(wspId).push(tab);
      } else if (tab.hidden && !wspId) {
        // Hidden and never tagged by us: another tab-hiding extension's tab
        // (see _ensureDefaultWorkspace). Adopting it made our activations
        // show it.
        console.log("[Brainer][_reconcileLateTabs] tab", tab.id, "hidden by another extension -- left alone");
      } else if (tab.hidden && await Brainer._isDestroyLeftover(wspId, pendingDestroys)) {
        // A visible one is on screen: kept and filed below instead.
        leftovers.push(tab.id);
      } else {
        noSession.push(tab);
      }
    }

    // Tabs of a workspace whose destroy was cut short: finish closing them.
    await Brainer._closeDestroyLeftovers(leftovers);

    // Assign session-tagged tabs to their correct workspaces (locked
    // read-modify-write, same discipline as add/remove)
    const toHide = [];
    const toShow = [];
    for (const [wspId, tabs] of byWsp) {
      let wspActive = false;
      await WSPStorageManager.mutateWorkspace(wspId, (wsp) => {
        for (const tab of tabs) {
          if (!wsp.tabs.includes(tab.id)) wsp.tabs.push(tab.id);
        }
        wspActive = wsp.active;
        console.log("[Brainer][_reconcileLateTabs] assigned", tabs.length, "tabs to workspace", wsp.name);
      });
      await Promise.all(tabs.map(tab => TabService.setTabSessionValue(tab.id, wspId)));
      // Keep tabSnapshot fresh for restart resilience (IC3) -- this site
      // mutates tabs[] without going through TabService.addTabToWorkspace.
      TabService._scheduleSnapshotRefresh(windowId, wspId);
      if (!wspActive) {
        toHide.push(...tabs.map(t => t.id));
      } else {
        for (const tab of tabs) WorkspaceService.addTabToActiveCache(tab.id, wspId);
        toShow.push(...tabs.filter(t => t.hidden).map(t => t.id));
      }
    }

    // Assign untagged tabs to active workspace (last resort)
    if (noSession.length > 0 && activeWsp) {
      await WSPStorageManager.mutateWorkspace(activeWsp.id, (fresh) => {
        for (const tab of noSession) {
          if (!fresh.tabs.includes(tab.id)) fresh.tabs.push(tab.id);
        }
      });
      await Promise.all(noSession.map(tab => TabService.setTabSessionValue(tab.id, activeWsp.id)));
      for (const tab of noSession) WorkspaceService.addTabToActiveCache(tab.id, activeWsp.id);
      toShow.push(...noSession.filter(t => t.hidden).map(t => t.id));
      // Keep tabSnapshot fresh for restart resilience (IC3).
      TabService._scheduleSnapshotRefresh(windowId, activeWsp.id);
      console.log("[Brainer][_reconcileLateTabs] assigned", noSession.length, "untagged tabs to active workspace");
    }

    if (toShow.length > 0) {
      await TabService.showTabs(toShow);
      console.log("[Brainer][_reconcileLateTabs] shown", toShow.length, "hidden tab(s) filed into the active workspace");
    }

    if (toHide.length > 0) {
      await TabService.hideTabs(toHide);
      const grouped = untracked.filter(t => t.groupId !== -1 && toHide.includes(t.id)).map(t => t.id);
      if (grouped.length > 0) await TabService.ungroup(grouped);
      console.log("[Brainer][_reconcileLateTabs] hidden", toHide.length, "inactive-workspace tabs");
    }
  }

  // A tab whose session tag names a workspace whose destroy was cut short
  // (tombstone written, record gone): the user deleted that workspace, so
  // its tab is closed rather than adopted into whatever is active (X-96).
  // Without the tombstone a tag naming a missing workspace proves nothing
  // (wiped storage, a detached dead window), and the tab is kept.
  static async _isDestroyLeftover(wspId, pendingDestroys) {
    if (!wspId || !pendingDestroys.includes(wspId)) return false;
    return (await WSPStorageManager.getWspState(wspId)).windowId == null;
  }

  static async _closeDestroyLeftovers(tabIds) {
    if (tabIds.length === 0) return;
    console.warn("[Brainer][_closeDestroyLeftovers] closing", tabIds.length,
      "tab(s) of a workspace whose destroy was interrupted:", tabIds);
    await TabService._eachTab("remove", tabIds);
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
          // File it once the switch is done (it used to be dropped: a tab
          // opened right after a switch stayed unfiled, untagged and outside
          // the workspace's container). Re-read: it may have moved, been
          // pinned or closed meanwhile.
          console.log("[Brainer][onTabCreated] workspace activating -- filing tab", tab.id, "after it settles");
          await WorkspaceService.whenActivationsSettled();
          if (Brainer._state !== 'ready') return;
          try { tab = await browser.tabs.get(tab.id); }
          catch { console.log("[Brainer][onTabCreated] tab", tab.id, "closed during the activation"); return; }
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
        // Before any guard and any await: the cache entry must go even when
        // the close is ignored below (else dead entries evict live ones),
        // and an add of this tab still in flight must see the removal.
        const info = TabService.takeTabInfo(tabId);
        TabService.noteTabRemoved(tabId);
        WorkspaceService.removeTabFromActiveCache(tabId);
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
        // One read serves both helpers (they used to scan every workspace
        // record twice per closed tab).
        const workspaces = await WSPStorageManager.getWorkspaces(removeInfo.windowId);
        const owner = workspaces.find(wsp => wsp.tabs.includes(tabId));
        if (!owner) {
          // A destroy or a container reopen takes its tabs out of storage
          // before closing them: nothing to record, nothing to repaint.
          console.log("[Brainer][onTabRemoved] tab", tabId, "not in any workspace -- nothing to do");
          return;
        }
        await TabService.saveClosedTabInfo(removeInfo.windowId, tabId, info, owner);
        await TabService.removeTabFromWorkspace(removeInfo.windowId, tabId, workspaces);
        // The badge counts the active workspace's tabs only
        if (owner.active) UIService.scheduleToolbarUpdate(removeInfo.windowId);
      } catch (e) { console.error("[Workspaces] onTabRemoved error:", e); }
    });

    // A tab moved between windows keeps its id and its session values. Torn
    // out of the primary window it used to stay in its workspace (badge,
    // previews); dragged back in, its old tag routed it to its old workspace
    // and hid it there, although the user had just placed it on screen.
    browser.tabs.onDetached.addListener(async (tabId, detachInfo) => {
      try {
        console.log("[Brainer][onTabDetached] tabId:", tabId, "oldWindowId:", detachInfo.oldWindowId,
          "state:", Brainer._state);
        if (Brainer._state !== 'ready') return;
        const primaryId = await Brainer.getCachedPrimaryWindowId();
        if (primaryId !== detachInfo.oldWindowId) return;
        const workspaces = await WSPStorageManager.getWorkspaces(detachInfo.oldWindowId);
        const owner = workspaces.find(wsp => wsp.tabs.includes(tabId));
        await TabService.clearTabSessionValue(tabId);
        if (!owner) return;
        console.log("[Brainer][onTabDetached] tab", tabId, "left the primary window -- removing from", owner.id);
        await TabService.removeTabFromWorkspace(detachInfo.oldWindowId, tabId, workspaces);
        if (owner.active) UIService.scheduleToolbarUpdate(detachInfo.oldWindowId);
      } catch (e) { console.error("[Workspaces] onTabDetached error:", e); }
    });

    browser.tabs.onAttached.addListener(async (tabId, attachInfo) => {
      try {
        console.log("[Brainer][onTabAttached] tabId:", tabId, "newWindowId:", attachInfo.newWindowId,
          "state:", Brainer._state);
        if (Brainer._state !== 'ready') return;
        if (WorkspaceService.isActivating()) {
          await WorkspaceService.whenActivationsSettled();
          if (Brainer._state !== 'ready') return;
        }
        const primaryId = await Brainer.getCachedPrimaryWindowId();
        if (primaryId !== attachInfo.newWindowId) return;
        let tab;
        try { tab = await browser.tabs.get(tabId); }
        catch { return; } // closed meanwhile
        if (tab.windowId !== primaryId || tab.pinned) return;
        // Drop membership left from an earlier stay (a detach this listener
        // did not see), then file it where the user put it: the workspace on
        // screen, overwriting the old tag.
        await TabService.removeTabFromWorkspace(primaryId, tabId);
        await TabService.addTabToWorkspace(tab, { ignoreSessionTag: true });
      } catch (e) { console.error("[Workspaces] onTabAttached error:", e); }
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

        const seq = WorkspaceService.activationSeq();
        const workspaces = await WSPStorageManager.getWorkspaces(activeInfo.windowId);
        const activeWsp = workspaces.find(wsp => wsp.active);
        console.log("[Brainer][onTabActivated] activeWsp:", activeWsp?.id, activeWsp?.name,
          "tabs:", activeWsp?.tabs.length);

        if (!activeWsp || activeWsp.tabs.includes(activeInfo.tabId)) {
          if (activeWsp) {
            // Cold or stale cache: fill it from this read, so the next click
            // takes the fast path (X-10).
            WorkspaceService.primeActiveCache(activeInfo.windowId, activeWsp, seq);
            WorkspaceService.updateLastActiveTab(activeInfo.windowId, activeInfo.tabId);
          }
          console.log("[Brainer][onTabActivated] tab already in active workspace or no active wsp - no action");
          return;
        }

        // Stale event: Firefox delivers onActivated asynchronously, and an
        // activation that ran meanwhile has selected another tab. Switching
        // back for it undid that activation, whose own selection event then
        // switched again: back-to-back activations (keyboard cycling, a
        // destroy followed by a switch) ping-ponged between two workspaces.
        const [selectedNow] = await browser.tabs.query({ active: true, windowId: activeInfo.windowId });
        if (selectedNow && selectedNow.id !== activeInfo.tabId) {
          console.log("[Brainer][onTabActivated] tab", activeInfo.tabId, "is no longer selected (now",
            selectedNow.id, ") -- stale event, no switch");
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

    // Navigation-time container enforcement. The creation-time force in
    // addTabToWorkspace only fires when the tab already has a reopenable URL at
    // onCreated; tabs born as about:blank (window.open, target="_blank", links
    // from external apps) or tabs navigated in place would otherwise escape the
    // active workspace's container. Re-check when the URL settles and reopen if
    // it mismatches. forceTabIntoActiveContainer is a cheap no-op unless the tab
    // actually escaped, so running it on every URL change is fine.
    browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      try {
        if (Brainer._state !== 'ready') return;
        if (WorkspaceService.isActivating()) {
          // Enforce against the workspace the switch lands on (was skipped)
          await WorkspaceService.whenActivationsSettled();
          if (Brainer._state !== 'ready') return;
          try { tab = await browser.tabs.get(tabId); }
          catch { return; }
        }
        await TabService.forceTabIntoActiveContainer(tab, changeInfo.url);
      } catch (e) { console.error("[Workspaces] onUpdated(container-force) error:", e); }
    }, {properties: ["url"]});

    // Firefox refuses to hide a tab that shares camera, microphone or screen
    // (tabs.hide leaves it out of its result), so a workspace switch leaves
    // such a tab of the previous workspace on screen. Nothing hid it once
    // the sharing stopped: it lingered in the active workspace's strip until
    // the next switch, and clicking it switched workspaces (X-103).
    browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      try {
        if (Brainer._state !== 'ready') return;
        const sharing = tab.sharingState;
        if (sharing && (sharing.camera || sharing.microphone || sharing.screen)) return;
        if (tab.hidden || tab.active || tab.pinned) return;
        if (WorkspaceService.isActivating()) {
          await WorkspaceService.whenActivationsSettled();
          if (Brainer._state !== 'ready') return;
          try { tab = await browser.tabs.get(tabId); }
          catch { return; }
          if (tab.hidden || tab.active || tab.pinned) return;
        }
        const primaryId = await Brainer.getCachedPrimaryWindowId();
        if (primaryId !== tab.windowId) return;
        const workspaces = await WSPStorageManager.getWorkspaces(tab.windowId);
        const owner = workspaces.find(wsp => wsp.tabs.includes(tabId));
        if (!owner || owner.active) return;
        console.log("[Brainer][onTabUpdated/sharingState] tab", tabId, "of inactive workspace", owner.id,
          "stopped sharing -- hiding it");
        await TabService.hideTabs(tabId);
      } catch (e) { console.error("[Workspaces] onUpdated(sharingState) error:", e); }
    }, {properties: ["sharingState"]});

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
        // A pin/unpin mid-activation is applied once the switch is done
        // (dropping it left a pinned tab in tabs[]).
        if (WorkspaceService.isActivating()) {
          console.log("[Brainer][onTabUpdated/pinned] workspace activating -- applying after it settles");
          await WorkspaceService.whenActivationsSettled();
          if (Brainer._state !== 'ready') return;
          try { tab = await browser.tabs.get(tabId); }
          catch { return; }
        }
        const primaryId = await Brainer.getCachedPrimaryWindowId();
        if (primaryId !== tab.windowId) {
          console.log("[Brainer][onTabUpdated/pinned] skipped — not primary window");
          return;
        }
        if (tab.pinned) {
          console.log("[Brainer][onTabUpdated/pinned] tab pinned — removing from workspace");
          await TabService.removeTabFromWorkspace(tab.windowId, tabId);
          // Pinned tabs are shared by every workspace: the tag of the one it
          // was pinned in must not decide where it goes when unpinned.
          await TabService.clearTabSessionValue(tabId);
        } else {
          // Unpinned in front of the user: file into the workspace on
          // screen. A tag from before the pin (or from an older version,
          // which kept it) used to hide the tab into that workspace.
          console.log("[Brainer][onTabUpdated/pinned] tab unpinned — adding to workspace");
          await TabService.addTabToWorkspace(tab, { ignoreSessionTag: true });
        }
      } catch (e) { console.error("[Workspaces] onUpdated(pinned) error:", e); }
    }, {properties: ["pinned"]});

    browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      try {
        // Unconditional, like the url/title cache listener above
        TabService.updateCachedGroup(tabId, changeInfo.groupId);
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

    // "Save and close group" / "Delete group": Firefox records the group
    // itself, so its tabs' pending closed-tab entries are dropped.
    browser.tabGroups.onRemoved?.addListener(async (group, removeInfo) => {
      try {
        if (removeInfo?.isWindowClosing) return;
        await TabService.onTabGroupRemoved(group.id);
      } catch (e) { console.error("[Workspaces] onTabGroupsRemoved error:", e); }
    });

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
        // Keyboard-driven activation must not interleave with restore/repair:
        // during that window the popup is gated too (handler state gate).
        if (Brainer._state !== 'ready') {
          console.log("[Brainer][onCommand] skipped — state not ready:", Brainer._state);
          return;
        }
        const windowId = (await browser.windows.getCurrent()).id;
        const workspaces = await WorkspaceService.getOrderedWorkspaces(windowId);
        console.log("[Brainer][onCommand] windowId:", windowId, "workspaces:", workspaces.length);
        if (workspaces.length < 2) {
          console.log("[Brainer][onCommand] skipped — fewer than 2 workspaces");
          return;
        }

        // Step from the workspace an activation still in flight is bringing
        // up: storage names the one being left until it is done, and a
        // second quick press repeated the first switch or was dropped (X-37).
        // Read after the storage read above, so a press queued meanwhile is seen.
        const pendingId = WorkspaceService.pendingActivation(windowId);
        let activeIdx = pendingId ? workspaces.findIndex(w => w.id === pendingId) : -1;
        if (activeIdx === -1) activeIdx = workspaces.findIndex(w => w.active);
        console.log("[Brainer][onCommand] activeIdx:", activeIdx,
          "active:", workspaces[activeIdx]?.name, "pending:", pendingId);
        if (activeIdx === -1) {
          // None active: next starts at the first workspace, previous at the last
          activeIdx = command === "workspace-prev" ? 0 : workspaces.length - 1;
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

// initialize() handles its own failures (X-06); the catch only keeps an
// unexpected throw from surfacing as an unhandled rejection.
Brainer.initialize().catch(e => console.error("[Workspaces] initialize error:", e));
