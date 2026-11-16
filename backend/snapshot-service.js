// Snapshot acquisition and refresh scheduling. All writes use the workspace lock.
class SnapshotService {
  // Strict acquisition for explicit exports. Failure is distinct from an
  // unchanged snapshot; a caller must never export stale data as current.
  static async capture(tabs, groups) {
    const rows = await Promise.all(tabs.filter(tab => tab.url).map(async tab => ({
      url: tab.url,
      title: tab.title || tab.url,
      cookieStoreId: tab.cookieStoreId || "firefox-default",
      groupKey: await browser.sessions.getTabValue(tab.id, TabService._GROUP_TAG) || null,
    })));
    const snapshot = {
      version: RecoveryData.VERSION, savedAt: Date.now(), tabs: rows,
      groups: groups.map(({ key, title, color, collapsed }) => ({ key, title, color, collapsed })),
    };
    if (!RecoveryData.readSnapshot(snapshot)) throw new Error("Failed to capture a complete recovery snapshot");
    return snapshot;
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

  static _timers = new Map(); // key: `${windowId}:${wspId}` -> timeout
  static DEBOUNCE_MS = 5000;

  // URL fallback and recovery metadata are saved together. Duplicate URLs
  // may have different containers and groups, so keep their individual rows.
  static async update(wsp, tabs, { requireReady = false } = {}) {
    if (requireReady && Brainer._state !== "ready") return false;
    if (tabs.length === 0 && wsp.tabs.length > 0) return false;
    try {
      const snapshot = await SnapshotService.capture(tabs, wsp.groups);
      if (requireReady && Brainer._state !== "ready") return false;
      const { tabs: snapshotTabs, groups } = snapshot;
      const previous = wsp.recoverySnapshot;
      if (previous && JSON.stringify(previous.tabs) === JSON.stringify(snapshotTabs)
          && JSON.stringify(previous.groups) === JSON.stringify(groups)) return false;
      wsp.tabSnapshot = snapshotTabs.map(tab => tab.url);
      wsp.recoverySnapshot = snapshot;
      return true;
    } catch (e) {
      // A failed session read must not silently erase group membership.
      console.warn("[SnapshotService][update] keeping previous snapshot:", e.message);
      return false;
    }
  }

  static schedule(windowId, wspId) {
    if (typeof windowId !== "number" || typeof wspId !== "string") return;
    const key = `${windowId}:${wspId}`;
    const existing = SnapshotService._timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      SnapshotService._timers.delete(key);
      if (Brainer._state !== 'ready') return;
      try {
        // Locked fresh read-modify-write (mutateWorkspace) so a concurrent
        // addTabToWorkspace/removeTabFromWorkspace doesn't get its tabs[]
        // change clobbered by our full-record save here. A destroyed
        // workspace is skipped there.
        await WSPStorageManager.mutateWorkspace(wspId, async (wsp) => {
          // Rebound to a new window between schedule and fire: abort.
          if (wsp.windowId !== windowId) return false;
          const tabs = await browser.tabs.query({ windowId, pinned: false });
          // A startup guard can pause recovery while these reads are in
          // flight. Never replace its saved evidence from an earlier timer.
          if (Brainer._state !== 'ready') return false;
          const tabMap = new Map(tabs.map(t => [t.id, t]));
          const fresh = wsp.tabs
            .map(id => tabMap.get(id))
            .filter(t => t && t.url);
          // The window closed after this refresh was scheduled (another
          // window keeps Firefox running, or macOS with no window left): the
          // query found nothing, and writing that would replace the last
          // good snapshot -- restore's URL fallback and the session-loss
          // export -- with []. Never trade a member list for an empty one.
          if (fresh.length === 0 && wsp.tabs.length > 0) return false;
          try { await browser.windows.get(windowId); }
          catch { return false; }
          if (Brainer._state !== 'ready') return false;
          if (!await SnapshotService.update(wsp, fresh, { requireReady: true })) return false;
          console.log("[SnapshotService][schedule] refreshed wspId:", wspId,
            "windowId:", windowId, "URLs:", fresh.length);
        });
      } catch (e) {
        console.debug("[SnapshotService][schedule] failed:", e.message);
      }
    }, SnapshotService.DEBOUNCE_MS);
    SnapshotService._timers.set(key, timer);
  }

  // Drop the pending refreshes of one window (its primary closed, or a
  // repair is about to rewrite its records). Returns the wspIds whose
  // refresh was dropped so a caller can re-arm them afterwards.
  static cancel(windowId) {
    const cancelled = [];
    for (const [key, timer] of SnapshotService._timers) {
      const sep = key.indexOf(":");
      if (Number(key.slice(0, sep)) !== windowId) continue;
      clearTimeout(timer);
      SnapshotService._timers.delete(key);
      cancelled.push(key.slice(sep + 1));
    }
    if (cancelled.length > 0) {
      console.log("[SnapshotService][cancel] windowId:", windowId, "cancelled:", cancelled);
    }
    return cancelled;
  }

}
