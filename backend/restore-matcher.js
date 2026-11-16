// Pure assignment planning shared by restart restore and live repair.
class RestoreMatcher {
  // Session tags are authoritative. Reserve their snapshot rows before URL
  // fallback, so an untagged duplicate cannot reuse a tagged tab's place.
  static match(workspaces, tabs, sessionOf) {
    const available = new Map(workspaces.map(workspace => {
      const snapshot = RecoveryData.fromWorkspace(workspace);
      return [workspace.id, snapshot.tabs.map(tab => ({
        url: tab.url,
        cookieStoreId: snapshot.complete ? tab.cookieStoreId : null,
      }))];
    }));
    const containerOf = tab => tab.cookieStoreId || "firefox-default";
    for (const tab of tabs) {
      const rows = available.get(sessionOf.get(tab.id));
      if (!rows) continue;
      let index = rows.findIndex(row => row.url === tab.url && row.cookieStoreId === containerOf(tab));
      if (index < 0) index = rows.findIndex(row => row.url === tab.url);
      if (index >= 0) rows.splice(index, 1);
    }

    const matched = new Map();
    for (const tab of tabs) {
      if (available.has(sessionOf.get(tab.id)) || !tab.url) continue;
      // Prefer an exact identity over a legacy URL-only row. A complete
      // snapshot's different container is evidence against a match.
      let match = null;
      for (const exact of [true, false]) {
        for (const [workspaceId, rows] of available) {
          const index = rows.findIndex(row => row.url === tab.url &&
            (exact ? row.cookieStoreId === containerOf(tab) : row.cookieStoreId === null));
          if (index >= 0) { match = { workspaceId, rows, index }; break; }
        }
        if (match) break;
      }
      if (match) {
        match.rows.splice(match.index, 1);
        matched.set(tab.id, match.workspaceId);
      }
    }
    return matched;
  }
}
