// Shared additive restoration of a saved workspace. No filesystem I/O.
class WorkspaceRestoreService {
  static sanitizeName(name) {
    return (name || "Restored Workspace").replace(/[\x00-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "").trim().slice(0, 200) || "Restored Workspace";
  }

  static async restore(data, windowId) {
    const urls = data.tabs;
    const recovery = data;
    if (urls.length > 1000) throw new Error("Too many tabs to restore at once (max 1000)");
    // Refuse before creating a workspace or any tabs. Silently substituting
    // the default container could open a different signed-in account.
    const containers = new Set(urls.map(item => item.cookieStoreId).filter(id => id && id !== "firefox-default"));
    if (recovery?.containerId) containers.add(recovery.containerId);
    for (const containerId of containers) {
      try { await browser.contextualIdentities.get(containerId); }
      catch { throw new Error(`Failed to restore: original container ${containerId} is unavailable. No tabs were opened.`); }
    }

    if (!urls.length) {
      const empty = { ...WorkspaceService._buildDefaultWspData(windowId, []),
        name: WorkspaceRestoreService.sanitizeName(data.name), icon: data.icon || "",
        color: data.color || null, containerId: data.containerId || null, active: false };
      await WorkspaceService.createWorkspace(empty);
      return { wspId: empty.id, name: empty.name, tabCount: 0, requested: 0 };
    }

    console.log("[WorkspaceRestoreService][restore] restoring", urls.length, "saved rows as tabs");

    // [M1] Sanitize saved name before using as workspace name
    const wspData = WorkspaceService._buildDefaultWspData(windowId, []);
    wspData.name = WorkspaceRestoreService.sanitizeName(data.name);
    wspData.icon = recovery?.icon || "";
    wspData.color = recovery?.color || null;
    wspData.containerId = recovery?.containerId || null;
    // Fresh keys isolate repeated restores of the same backup.
    const groupKeys = new Map((recovery?.groups || []).map(group => [group.key, crypto.randomUUID()]));
    const restoredGroups = (recovery?.groups || []).map(group => ({ ...group, key: groupKeys.get(group.key), tabs: [] }));
    wspData.active = true;

    // One step of the activation chain (X-23): the restore switches the
    // active workspace and then opens its tabs one by one. A click on an old,
    // still visible tab meanwhile used to start an activation in parallel,
    // leaving storage (old workspace active), the cache (restored workspace)
    // and the screen (one tab) disagreeing. Tab events now wait for the step.
    // [M4 + Firefox reviewer] The reopen guard stays held across the create
    // and tab creation so addTabToWorkspace never files these tabs itself.
    const outcome = await WorkspaceService._onActivationChain(() => TabService.withReopenGuard(async () => {
      const previous = await WorkspaceService.getActiveWsp(windowId);
      // Create the workspace (internally calls deactivateCurrentWsp)
      await WorkspaceService._createWorkspaceOnChain(wspData);
      const wspId = wspData.id;

      // Create tabs for each saved row
      const wsp = await WSPStorageManager.getWorkspace(wspId);
      const containerId = wsp.containerId || null;
      const tabIds = [];
      const errors = [];

      for (const item of urls) {
        const createOpts = { url: item.url, windowId, active: false };
        if (item.cookieStoreId || containerId) createOpts.cookieStoreId = item.cookieStoreId || containerId;
        try {
          const tab = await browser.tabs.create(createOpts);
          tabIds.push(tab.id);
          await TabService.setTabSessionValue(tab.id, wspId, { strict: true });
          const groupKey = groupKeys.get(item.groupKey);
          if (groupKey) await TabService.setGroupTag(tab.id, groupKey, { strict: true });
        } catch (e) {
          errors.push(e.message);
          console.debug("[WorkspaceRestoreService][restore] failed to create tab for:", item.url, e.message);
        }
      }

      // [H3] Rollback if no tabs were created -- after this step: the
      // destroy activates another workspace, which queues on the chain.
      if (tabIds.length === 0) return { rollback: true, wspId, previousId: previous?.id ?? null };

      // File the created tabs: locked merge onto the fresh record (not an
      // overwrite), and no zombie record if the workspace was deleted while
      // its tabs were opening.
      const freshWsp = await WSPStorageManager.mutateWorkspace(wspId, (fresh) => {
        for (const id of tabIds) {
          if (!fresh.tabs.includes(id)) fresh.tabs.push(id);
        }
        fresh.groups = restoredGroups;
      });
      if (!freshWsp) {
        throw new Error("Failed to restore: the workspace was deleted while its tabs were opening");
      }
      if (!await freshWsp._rebuildGroups()) errors.push("Some tab groups could not be restored");
      // Keep tabSnapshot fresh for restart resilience (IC3) -- restore opens
      // the saved URLs as brand-new tabs.
      SnapshotService.schedule(windowId, wspId);

      // Activate the first tab
      await browser.tabs.update(tabIds[0], { active: true });

      // Hide inactive workspace tabs. Re-checked: nothing on the chain can
      // switch away, but the cache must never name an inactive workspace.
      if (freshWsp.active) {
        await WorkspaceService.hideInactiveWspTabs(windowId, wspId);
        WorkspaceService._updateActiveCache(windowId, freshWsp.tabs, wspId, freshWsp.containerId);
      }
      await MenuService.refreshTabMenu();
      await UIService.updateToolbarButton(windowId);
      return { wspId, tabIds, errors };
    }));

    if (outcome.rollback) {
      console.warn("[WorkspaceRestoreService][restore] all tab creations failed -- rolling back");
      await WorkspaceService.destroyWsp(outcome.wspId, windowId, { successorId: outcome.previousId }).catch(e =>
        console.warn("[WorkspaceRestoreService][restore] rollback destroy failed:", e.message)
      );
      throw new Error("Failed to restore any tabs from backup");
    }
    const { wspId, tabIds } = outcome;
    console.log("[WorkspaceRestoreService][restore] done - wspId:", wspId,
      "tabs:", tabIds.length);
    return { wspId, name: wspData.name, tabCount: tabIds.length, requested: urls.length,
      complete: outcome.errors.length === 0,
      error: outcome.errors.length ? "Some tabs, groups or their recovery metadata could not be restored. Opened tabs were kept." : null };
  }
}
