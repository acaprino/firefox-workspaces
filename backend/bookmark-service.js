// Bookmark export/restore for workspaces
// Exports workspace tabs as a bookmarks folder under "Other Bookmarks > Workspaces".
// Restores a workspace from a bookmarks folder.
class BookmarkService {
  static PARENT_FOLDER_TITLE = "Workspaces";

  // Find or create the "Workspaces" parent folder under Other Bookmarks (unfiled).
  static async _getOrCreateParentFolder() {
    const results = await browser.bookmarks.search({ title: BookmarkService.PARENT_FOLDER_TITLE });
    // Look for an existing folder directly under "unfiled_____" (Other Bookmarks root).
    const existing = results.find(
      b => b.type === "folder" && b.parentId === "unfiled_____"
    );
    if (existing) {
      console.log("[BookmarkService][_getOrCreateParentFolder] found existing folder:", existing.id);
      return existing;
    }
    const folder = await browser.bookmarks.create({
      parentId: "unfiled_____",
      title: BookmarkService.PARENT_FOLDER_TITLE,
      type: "folder"
    });
    console.log("[BookmarkService][_getOrCreateParentFolder] created new folder:", folder.id);
    return folder;
  }

  // Export a workspace's tabs as bookmarks under Workspaces/{workspace name}.
  // Returns the created bookmarks folder.
  static async exportWorkspace(wspId) {
    const wsp = await WSPStorageManager.getWorkspace(wspId);
    if (!wsp) throw new Error("Workspace not found");
    console.log("[BookmarkService][exportWorkspace] wspId:", wspId,
      "name:", wsp.name, "tabs:", wsp.tabs.length);

    const parent = await BookmarkService._getOrCreateParentFolder();

    // Check if a subfolder with the same name already exists
    let folderTitle = wsp.name;
    const children = await browser.bookmarks.getChildren(parent.id);
    const nameExists = children.some(
      c => c.type === "folder" && c.title === folderTitle
    );
    if (nameExists) {
      const now = new Date();
      const dateSuffix = now.toISOString().slice(0, 10);
      folderTitle = `${wsp.name} (${dateSuffix})`;
      console.log("[BookmarkService][exportWorkspace] name collision, using:", folderTitle);
    }

    const folder = await browser.bookmarks.create({
      parentId: parent.id,
      title: folderTitle,
      type: "folder"
    });
    console.log("[BookmarkService][exportWorkspace] created folder:", folder.id, "title:", folderTitle);

    // Get live tab info for URLs and titles
    let exported = 0;
    for (const tabId of wsp.tabs) {
      try {
        const tab = await browser.tabs.get(tabId);
        // Skip about: and other non-bookmarkable URLs
        if (!tab.url || tab.url.startsWith("about:") || tab.url.startsWith("moz-extension:")) {
          console.debug("[BookmarkService][exportWorkspace] skipping non-bookmarkable tab:", tab.url);
          continue;
        }
        await browser.bookmarks.create({
          parentId: folder.id,
          title: tab.title || tab.url,
          url: tab.url
        });
        exported++;
      } catch (e) {
        console.debug("[BookmarkService][exportWorkspace] failed to export tab:", tabId, e.message);
      }
    }
    console.log("[BookmarkService][exportWorkspace] exported", exported, "of", wsp.tabs.length, "tabs");
    return { folderId: folder.id, folderTitle, exported, total: wsp.tabs.length };
  }

  // List bookmark folders under "Workspaces" parent that can be restored.
  static async getExportedWorkspaces() {
    const results = await browser.bookmarks.search({ title: BookmarkService.PARENT_FOLDER_TITLE });
    const parent = results.find(
      b => b.type === "folder" && b.parentId === "unfiled_____"
    );
    if (!parent) {
      console.log("[BookmarkService][getExportedWorkspaces] no Workspaces folder found");
      return [];
    }
    const children = await browser.bookmarks.getChildren(parent.id);
    const folders = children.filter(c => c.type === "folder");
    console.log("[BookmarkService][getExportedWorkspaces] found", folders.length, "folders");

    // For each folder, count bookmarks
    const result = [];
    for (const f of folders) {
      const items = await browser.bookmarks.getChildren(f.id);
      const bookmarkCount = items.filter(i => i.url).length;
      result.push({
        id: f.id,
        title: f.title,
        bookmarkCount
      });
    }
    return result;
  }

  // Restore a workspace from a bookmarks folder.
  // Creates a new workspace and opens all bookmarked URLs as tabs.
  static async restoreWorkspace(folderId, windowId) {
    const [folder] = await browser.bookmarks.get(folderId);
    if (!folder || folder.type !== "folder") {
      throw new Error("Bookmark folder not found");
    }
    console.log("[BookmarkService][restoreWorkspace] folderId:", folderId,
      "title:", folder.title, "windowId:", windowId);

    const items = await browser.bookmarks.getChildren(folderId);
    const urls = items
      .filter(i => i.url && !i.url.startsWith("about:") && !i.url.startsWith("moz-extension:"))
      .map(i => ({ url: i.url, title: i.title }));

    if (urls.length === 0) {
      throw new Error("No bookmarks to restore");
    }

    console.log("[BookmarkService][restoreWorkspace] restoring", urls.length, "bookmarks as tabs");

    // Build workspace data (createWorkspace handles deactivation internally)
    const wspData = WorkspaceService._buildDefaultWspData(windowId, []);
    wspData.name = folder.title;
    wspData.active = true;

    // Create the workspace
    await WorkspaceService.createWorkspace(wspData);
    const wspId = wspData.id;

    // Create tabs for each bookmark
    const wsp = await WSPStorageManager.getWorkspace(wspId);
    const containerId = wsp.containerId || null;
    const tabIds = [];

    TabService._reopeningCount++;
    try {
      for (const item of urls) {
        const createOpts = { url: item.url, windowId, active: false };
        if (containerId) createOpts.cookieStoreId = containerId;
        try {
          const tab = await browser.tabs.create(createOpts);
          tabIds.push(tab.id);
          await TabService.setTabSessionValue(tab.id, wspId);
        } catch (e) {
          console.debug("[BookmarkService][restoreWorkspace] failed to create tab for:", item.url, e.message);
        }
      }
    } finally {
      TabService._reopeningCount--;
    }

    // Update workspace with created tabs
    const freshWsp = await WSPStorageManager.getWorkspace(wspId);
    freshWsp.tabs = tabIds;
    await freshWsp._saveState();

    // Activate the first tab
    if (tabIds.length > 0) {
      await browser.tabs.update(tabIds[0], { active: true });
    }

    // Hide inactive workspace tabs
    await WorkspaceService.hideInactiveWspTabs(windowId, wspId);
    WorkspaceService._updateActiveCache(windowId, tabIds);
    await MenuService.refreshTabMenu();
    await UIService.updateToolbarButton(windowId);

    console.log("[BookmarkService][restoreWorkspace] done - wspId:", wspId,
      "tabs:", tabIds.length);
    return { wspId, name: folder.title, tabCount: tabIds.length };
  }
}
