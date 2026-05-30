// Bookmark export/restore for workspaces
// Exports workspace tabs as a bookmarks folder under "Other Bookmarks > Workspaces".
// Restores a workspace from a bookmarks folder.

// Control characters, bidi overrides, and zero-width chars -- same pattern as
// handler.js CONTROL_AND_BIDI_RE. Duplicated here so BookmarkService sanitizes
// names defensively regardless of call site (defense-in-depth).
const _BOOKMARK_CONTROL_RE = /[\x00-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

class BookmarkService {
  static PARENT_FOLDER_TITLE = "Workspaces";
  static MAX_RESTORE_TABS = 200;

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
      title: BookmarkService.PARENT_FOLDER_TITLE
    });
    console.log("[BookmarkService][_getOrCreateParentFolder] created new folder:", folder.id);
    return folder;
  }

  // Sanitize a bookmark folder title for use as a workspace name.
  static _sanitizeFolderTitle(title) {
    return (title || "Restored Workspace")
      .replace(_BOOKMARK_CONTROL_RE, '')
      .trim()
      .slice(0, 200) || "Restored Workspace";
  }

  // Export a workspace's tabs as bookmarks under Workspaces/{workspace name}.
  // Returns the created bookmarks folder.
  static async exportWorkspace(wspId) {
    const wsp = await WSPStorageManager.getWorkspace(wspId);
    if (!wsp) throw new Error("Workspace not found");
    console.log("[BookmarkService][exportWorkspace] wspId:", wspId,
      "name:", wsp.name, "tabs:", wsp.tabs.length);

    // Batch-fetch all tab info and pre-check for bookmarkable tabs
    const allTabs = await browser.tabs.query({ windowId: wsp.windowId });
    const tabMap = new Map(allTabs.map(t => [t.id, t]));
    const bookmarkableTabs = wsp.tabs.filter(tabId => {
      const tab = tabMap.get(tabId);
      return tab && tab.url && TabService._isUrlAllowed(tab.url);
    });
    if (bookmarkableTabs.length === 0) {
      throw new Error("No bookmarkable tabs to export");
    }

    const parent = await BookmarkService._getOrCreateParentFolder();

    // Resolve a unique folder name under the Workspaces parent
    const children = await browser.bookmarks.getChildren(parent.id);
    const existingNames = new Set(
      children.filter(c => c.type === "folder").map(c => c.title)
    );
    let folderTitle = wsp.name;
    if (existingNames.has(folderTitle)) {
      const dateSuffix = new Date().toISOString().slice(0, 10);
      let candidate = `${wsp.name} (${dateSuffix})`;
      let counter = 2;
      while (existingNames.has(candidate) && counter < 1000) {
        candidate = `${wsp.name} (${dateSuffix} #${counter})`;
        counter++;
      }
      folderTitle = candidate;
      console.log("[BookmarkService][exportWorkspace] name collision, using:", folderTitle);
    }

    const folder = await browser.bookmarks.create({
      parentId: parent.id,
      title: folderTitle
    });
    console.log("[BookmarkService][exportWorkspace] created folder:", folder.id, "title:", folderTitle);

    let exported = 0;
    for (const tabId of bookmarkableTabs) {
      const tab = tabMap.get(tabId);
      try {
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

    // Fetch bookmark counts in parallel
    return Promise.all(folders.map(async (f) => {
      const items = await browser.bookmarks.getChildren(f.id);
      return { id: f.id, title: f.title, bookmarkCount: items.filter(i => i.url).length };
    }));
  }

  // Restore a workspace from a bookmarks folder.
  // Creates a new workspace and opens all bookmarked URLs as tabs.
  static async restoreWorkspace(folderId, windowId) {
    // Validate folder exists and provide a friendly error
    let folder;
    try {
      [folder] = await browser.bookmarks.get(folderId);
    } catch {
      throw new Error("Bookmark folder not found");
    }
    if (!folder || folder.type !== "folder") {
      throw new Error("Bookmark folder not found");
    }

    // [H1] Verify the folder is a child of the Workspaces parent
    const parent = await BookmarkService._getOrCreateParentFolder();
    if (folder.parentId !== parent.id) {
      throw new Error("Folder is not a Workspaces export folder");
    }

    console.log("[BookmarkService][restoreWorkspace] folderId:", folderId,
      "title:", folder.title, "windowId:", windowId);

    const items = await browser.bookmarks.getChildren(folderId);
    // [H2] Use the allowlist URL filter instead of denylist
    const urls = items
      .filter(i => i.url && TabService._isUrlAllowed(i.url))
      .map(i => ({ url: i.url, title: i.title }));

    if (urls.length === 0) {
      throw new Error("No bookmarks to restore");
    }

    // [M2] Prevent unbounded tab creation
    if (urls.length > BookmarkService.MAX_RESTORE_TABS) {
      throw new Error(`Too many bookmarks to restore (${urls.length}, max ${BookmarkService.MAX_RESTORE_TABS})`);
    }

    console.log("[BookmarkService][restoreWorkspace] restoring", urls.length, "bookmarks as tabs");

    // [M1] Sanitize folder title before using as workspace name
    const wspData = WorkspaceService._buildDefaultWspData(windowId, []);
    wspData.name = BookmarkService._sanitizeFolderTitle(folder.title);
    wspData.active = true;

    // [M4 + Firefox reviewer] Guard _reopeningCount BEFORE createWorkspace
    // to prevent the entire workspace creation + tab creation sequence from
    // being intercepted by addTabToWorkspace.
    TabService._reopeningCount++;
    try {
      // Create the workspace (internally calls deactivateCurrentWsp)
      await WorkspaceService.createWorkspace(wspData);
      const wspId = wspData.id;

      // Create tabs for each bookmark
      const wsp = await WSPStorageManager.getWorkspace(wspId);
      const containerId = wsp.containerId || null;
      const tabIds = [];

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

      // [H3] Rollback if no tabs were created
      if (tabIds.length === 0) {
        console.warn("[BookmarkService][restoreWorkspace] all tab creations failed -- rolling back");
        await WorkspaceService.destroyWsp(wspId, windowId).catch(e =>
          console.warn("[BookmarkService][restoreWorkspace] rollback destroy failed:", e.message)
        );
        throw new Error("Failed to restore any tabs from bookmarks");
      }

      // Update workspace with created tabs
      const freshWsp = await WSPStorageManager.getWorkspace(wspId);
      freshWsp.tabs = tabIds;
      await freshWsp._saveState();
      // Keep tabSnapshot fresh for restart resilience (IC3) -- restore opens
      // the bookmarked URLs as brand-new tabs.
      TabService._scheduleSnapshotRefresh(windowId, wspId);

      // Activate the first tab
      await browser.tabs.update(tabIds[0], { active: true });

      // Hide inactive workspace tabs
      await WorkspaceService.hideInactiveWspTabs(windowId, wspId);
      WorkspaceService._updateActiveCache(windowId, tabIds, wspId);
      await MenuService.refreshTabMenu();
      await UIService.updateToolbarButton(windowId);

      console.log("[BookmarkService][restoreWorkspace] done - wspId:", wspId,
        "tabs:", tabIds.length);
      return { wspId, name: wspData.name, tabCount: tabIds.length };
    } finally {
      TabService._reopeningCount--;
    }
  }
}
