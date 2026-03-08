browser.runtime.onMessage.addListener(async (message, sender) => {
  if (sender.id !== browser.runtime.id) return;
  try {
    return await _handleMessage(message);
  } catch (e) {
    console.error("[Workspaces] Handler error:", message.action, e);
    return { _error: true, message: "An internal error occurred" };
  }
});

async function _handleMessage(message) {
  const { action, ...args } = message;
  // Summarize args to avoid dumping large workspace objects in logs
  const argsSummary = Object.fromEntries(
    Object.entries(args).map(([k, v]) =>
      Array.isArray(v) ? [k, `[array len=${v.length}]`] :
      (v && typeof v === "object") ? [k, `{${Object.keys(v).join(",")}}` ] :
      [k, v]
    )
  );
  console.log("[Handler] action:", action, "args:", JSON.stringify(argsSummary));
  let result;

  switch (action) {
    case "getWorkspaces":
      result = await WorkspaceService.getOrderedWorkspaces(message.windowId);
      console.log("[Handler] getWorkspaces -> count:", result?.length);
      return result;
    case "createWorkspace":
      await WorkspaceService.createWorkspace(message);
      console.log("[Handler] createWorkspace -> success");
      return { success: true };
    case "createWorkspaceWithTab":
      result = await WorkspaceService.createWorkspaceWithTab(message);
      console.log("[Handler] createWorkspaceWithTab -> wspId:", result?.wspId, "tabId:", result?.tabId);
      return result;
    case "renameWorkspace":
      await WorkspaceService.renameWorkspace(message.wspId, { name: message.wspName, icon: message.wspIcon, color: message.wspColor });
      console.log("[Handler] renameWorkspace -> success");
      return { success: true };
    case "getNumWorkspaces":
      result = await WSPStorageManager.getNumWorkspaces(message.windowId);
      console.log("[Handler] getNumWorkspaces -> count:", result);
      return result;
    case "hideInactiveWspTabs":
      await WorkspaceService.hideInactiveWspTabs(message.windowId, message.activeWspId ?? null);
      console.log("[Handler] hideInactiveWspTabs -> success");
      return { success: true };
    case "destroyWsp":
      await WorkspaceService.destroyWsp(message.wspId);
      console.log("[Handler] destroyWsp -> success");
      return { success: true };
    case "activateWorkspace":
      await WorkspaceService.activateWsp(message.wspId, message.windowId, message.tabId || null);
      console.log("[Handler] activateWorkspace -> success");
      return { success: true };
    case "getWorkspaceName":
      result = WorkspaceService.generateWspName();
      console.log("[Handler] getWorkspaceName ->", result);
      return result;
    case "getPrimaryWindowId":
      result = await WSPStorageManager.getPrimaryWindowId();
      console.log("[Handler] getPrimaryWindowId ->", result);
      return result;

    // Tier 2: Containers
    case "getContainers":
      result = await WorkspaceService.getContainerList();
      console.log("[Handler] getContainers -> count:", result?.length);
      return result;
    case "setWorkspaceContainer":
      await WorkspaceService.setWorkspaceContainer(message.wspId, message.containerId);
      console.log("[Handler] setWorkspaceContainer -> success");
      return { success: true };
    // Tier 2: Closed tabs
    case "getClosedTabs":
      result = await TabService.getClosedTabs(message.wspId);
      console.log("[Handler] getClosedTabs -> count:", result?.length);
      return result;
    case "restoreClosedTab":
      result = await TabService.restoreClosedTab(message.wspId, message.index, message.windowId);
      console.log("[Handler] restoreClosedTab -> url:", result?.url);
      return result;
    case "clearClosedTabs":
      await TabService.clearClosedTabs(message.wspId);
      console.log("[Handler] clearClosedTabs -> success");
      return { success: true };

    // Tier 3: Workspace order
    case "saveWorkspaceOrder": {
      const ids = message.orderedIds;
      if (!Array.isArray(ids) || !ids.every(id => typeof id === "string")) {
        console.warn("[Handler] saveWorkspaceOrder -> invalid orderedIds:", ids);
        return { _error: true, message: "orderedIds must be an array of strings" };
      }
      await WorkspaceService.saveWorkspaceOrder(message.windowId, ids);
      console.log("[Handler] saveWorkspaceOrder -> success, length:", ids.length);
      return { success: true };
    }

    // Tier 3: Tab search
    case "searchTabs":
      result = await TabService.searchTabs(message.query, message.windowId);
      console.log("[Handler] searchTabs -> results:", result?.length);
      return result;

    // Tier 3: Tab previews
    case "getTabPreviews":
      result = await TabService.getTabPreviews(message.wspId, message.limit);
      console.log("[Handler] getTabPreviews -> previews:", result?.previews?.length, "total:", result?.total);
      return result;

    // Dark-mode hint from popup (popup has real DOM, bypasses resistFingerprinting)
    case "setDarkModeHint":
      UIService._darkModeHint = message.isDark === true;
      UIService._isDarkCache = UIService._darkModeHint;
      console.log("[Handler] setDarkModeHint ->", UIService._darkModeHint);
      return { success: true };

    default:
      console.warn("[Workspaces] Unknown message action:", action);
      return { _error: true, message: `Unknown action: ${action}` };
  }
}
