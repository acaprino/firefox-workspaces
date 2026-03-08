// Tab context menu + omnibox
class MenuService {
  static _refreshTimer = null;
  // Map from menuItemId to {toWspId} for the onClicked handler
  static _menuActionMap = new Map();
  // Escape XML-special characters for omnibox descriptions
  static _escapeXml(str) {
    return str.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&apos;"}[c]));
  }

  static async initializeTabMenu() {
    const currentWindow = await browser.windows.getCurrent();
    console.log("[MenuService][initializeTabMenu] windowId:", currentWindow.id);

    const primaryId = await WSPStorageManager.getPrimaryWindowId();
    if (primaryId !== currentWindow.id) {
      console.log("[MenuService][initializeTabMenu] skipped — not primary window (primary:", primaryId, ")");
      return;
    }

    const workspaces = await WorkspaceService.getOrderedWorkspaces(currentWindow.id);
    console.log("[MenuService][initializeTabMenu] workspaces:", workspaces.length,
      workspaces.map(w => `"${w.name}"(${w.tabs.length}t, active:${w.active})`));

    MenuService._menuActionMap.clear();

    const menuId = `ld-wsp-manager-menu-${currentWindow.id}`;
    await new Promise(resolve => browser.menus.create({
      id: menuId,
      title: "Move Tab to Another Workspace",
      enabled: workspaces.length > 1,
      contexts: ["tab"]
    }, resolve));
    console.log("[MenuService][initializeTabMenu] root menu created:", menuId,
      "enabled:", workspaces.length > 1);

    for (const workspace of workspaces) {
      const subMenuId = `sub-menu-${workspace.id}`;
      const menuLabel = `${workspace.name} (${workspace.tabs.length} tabs)`;
      browser.menus.create({
        title: menuLabel,
        parentId: menuId,
        id: subMenuId,
        enabled: !workspace.active
      });
      MenuService._menuActionMap.set(subMenuId, { toWspId: workspace.id });
      console.log("[MenuService][initializeTabMenu] submenu:", subMenuId,
        "label:", menuLabel, "enabled:", !workspace.active);
    }
    console.log("[MenuService][initializeTabMenu] done — menuActionMap size:", MenuService._menuActionMap.size);
  }

  static _onMenuClicked = async (info, tab) => {
    try {
      console.log("[MenuService][_onMenuClicked] menuItemId:", info.menuItemId,
        "tabId:", tab.id, "windowId:", tab.windowId);
      const action = MenuService._menuActionMap.get(info.menuItemId);
      if (!action) {
        console.log("[MenuService][_onMenuClicked] no action for menuItemId:", info.menuItemId, "— ignoring");
        return;
      }
      console.log("[MenuService][_onMenuClicked] action: move to wspId:", action.toWspId);

      // Re-read active workspace from storage to avoid stale closures
      const activeWsp = await WorkspaceService.getActiveWsp(tab.windowId);
      if (!activeWsp) {
        console.log("[MenuService][_onMenuClicked] no active workspace — aborting");
        return;
      }
      console.log("[MenuService][_onMenuClicked] activeWsp:", activeWsp.id, activeWsp.name);

      const highlightedTabs = await browser.tabs.query({
        currentWindow: true,
        highlighted: true
      });
      console.log("[MenuService][_onMenuClicked] highlighted tabs:", highlightedTabs.length);

      const tabsToMove = highlightedTabs.length > 1 && highlightedTabs.some(t => t.id === tab.id)
        ? highlightedTabs
        : [tab];
      console.log("[MenuService][_onMenuClicked] moving", tabsToMove.length, "tab(s):",
        tabsToMove.map(t => t.id), "from", activeWsp.id, "to", action.toWspId);

      for (const t of tabsToMove) {
        await TabService.moveTabToWsp(t, activeWsp.id, action.toWspId);
      }
      console.log("[MenuService][_onMenuClicked] done");
    } catch (e) { console.error("[Workspaces] menus.onClicked error:", e); }
  };

  static _onClickedRegistered = false;

  static refreshTabMenu() {
    clearTimeout(MenuService._refreshTimer);
    MenuService._refreshTimer = setTimeout(async () => {
      console.log("[MenuService][refreshTabMenu] rebuilding menu (debounced)");
      await browser.menus.removeAll();
      if (!MenuService._onClickedRegistered) {
        browser.menus.onClicked.addListener(MenuService._onMenuClicked);
        MenuService._onClickedRegistered = true;
        console.log("[MenuService][refreshTabMenu] onClicked listener registered");
      }
      await MenuService.initializeTabMenu();
    }, 50);
  }

  static registerOmniboxListeners() {
    console.log("[MenuService][registerOmniboxListeners] registering omnibox listeners");
    browser.omnibox.setDefaultSuggestion({
      description: "Search workspaces and tabs \u2014 type a name to filter"
    });

    browser.omnibox.onInputChanged.addListener(async (text, suggest) => {
      console.log("[MenuService][omnibox.onInputChanged] text:", JSON.stringify(text));
      if (!text.trim()) return;

      const windowId = (await browser.windows.getCurrent()).id;
      const workspaces = await WorkspaceService.getOrderedWorkspaces(windowId);
      const suggestions = [];
      const lowerText = text.toLowerCase();

      const allTabs = await browser.tabs.query({ windowId });
      const tabMap = new Map(allTabs.map(t => [t.id, t]));
      console.log("[MenuService][omnibox.onInputChanged] windowId:", windowId,
        "workspaces:", workspaces.length, "tabs:", allTabs.length);

      for (const wsp of workspaces) {
        if (wsp.name.toLowerCase().includes(lowerText)) {
          suggestions.push({
            content: `switch:${wsp.id}`,
            description: `Switch to "${MenuService._escapeXml(wsp.name)}" (${wsp.tabs.length} tabs)`
          });
        }
        for (const tabId of wsp.tabs) {
          const tab = tabMap.get(tabId);
          if (!tab) continue;
          if (TabService._matchesQuery(tab, lowerText)) {
            const title = MenuService._escapeXml(tab.title || tab.url || "Untitled");
            suggestions.push({
              content: `tab:${wsp.id}:${tabId}`,
              description: `${title} \u2014 in "${MenuService._escapeXml(wsp.name)}"`
            });
          }
        }
      }
      const sliced = suggestions.slice(0, 6);
      console.log("[MenuService][omnibox.onInputChanged] suggestions:", sliced.length, "(raw:", suggestions.length, ")");
      suggest(sliced);
    });

    browser.omnibox.onInputEntered.addListener(async (text) => {
      console.log("[MenuService][omnibox.onInputEntered] text:", JSON.stringify(text));
      const windowId = (await browser.windows.getCurrent()).id;
      const workspaces = await WorkspaceService.getOrderedWorkspaces(windowId);
      const validIds = new Set(workspaces.map(w => w.id));

      if (text.startsWith("switch:")) {
        const wspId = text.split(":")[1];
        console.log("[MenuService][omnibox.onInputEntered] switch -> wspId:", wspId,
          "valid:", validIds.has(wspId));
        if (validIds.has(wspId)) await WorkspaceService.activateWsp(wspId, windowId);
      } else if (text.startsWith("tab:")) {
        const parts = text.split(":");
        const wspId = parts[1];
        const tabId = Number(parts[2]);
        console.log("[MenuService][omnibox.onInputEntered] tab -> wspId:", wspId, "tabId:", tabId,
          "validWsp:", validIds.has(wspId), "validTabId:", Number.isInteger(tabId));
        if (validIds.has(wspId) && Number.isInteger(tabId)) {
          await WorkspaceService.activateWsp(wspId, windowId, tabId);
        }
      } else {
        console.log("[MenuService][omnibox.onInputEntered] unrecognized input format:", JSON.stringify(text));
      }
    });
  }
}
