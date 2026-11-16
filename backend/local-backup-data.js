// File format shared by capture, history preview and granular restore.
class LocalBackupData {
  static FORMAT = "firefox-workspaces-backup";
  static MAX_BYTES = 8 * 1024 * 1024;

  static connection(value) {
    return value?.format === "workspaces-backup-connection" && value.version === 1
      && typeof value.profileId === "string" && UUID_RE.test(value.profileId)
      && value.host === "org.hardfox.workspaces_" + value.profileId.replaceAll("-", "") ? value : null;
  }

  static read(value) {
    const text = (v, max = 32768) => typeof v === "string" && v.length <= max;
    if (value?.format !== this.FORMAT || value.version !== 1
        || !text(value.profileId, 100) || !UUID_RE.test(value.profileId)
        || !Number.isFinite(value.createdAt) || value.createdAt < 0 || !text(value.extensionVersion, 100)
        || !Array.isArray(value.containers) || value.containers.length > 1000
        || !Array.isArray(value.workspaces) || !value.workspaces.length || value.workspaces.length > 500) return null;
    const containers = new Set(["firefox-default"]);
    for (const c of value.containers) {
      if (!c || !/^firefox-container-\d+$/.test(c.cookieStoreId) || containers.has(c.cookieStoreId)
          || ![c.name, c.icon, c.color].every(v => text(v, 500))) return null;
      containers.add(c.cookieStoreId);
    }
    const ids = new Set();
    let count = 0;
    for (const w of value.workspaces) {
      if (!w || !text(w.sourceId, 100) || !UUID_RE.test(w.sourceId) || ids.has(w.sourceId)
          || !text(w.name, 200) || !w.name || !text(w.icon, 100) || typeof w.active !== "boolean"
          || (w.color !== null && (!text(w.color, 7) || !/^#?[a-f0-9]{6}$/i.test(w.color)))
          || (w.containerId !== null && (!containers.has(w.containerId) || w.containerId === "firefox-default"))
          || !RecoveryData.readSnapshot(w.snapshot)) return null;
      ids.add(w.sourceId);
      if (!w.snapshot.tabs.every(t => text(t.url) && text(t.title) && containers.has(t.cookieStoreId))
          || !w.snapshot.groups.every(g => text(g.key, 100) && text(g.title, 500) && text(g.color, 100))) return null;
      count += w.snapshot.tabs.length;
    }
    return count > 0 && count <= 10000 ? value : null;
  }

  static restorableUrl(url) {
    // Preserve all addresses in files. Reopening privileged Firefox pages
    // must be explicit/manual: never turn javascript: or data: into execution.
    const normalized = this.restoreUrl(url);
    if (/^about:(?:blank|newtab|home)(?:[?#]|$)/i.test(normalized)) return true;
    try { return ["http:", "https:"].includes(new URL(normalized).protocol); }
    catch { return false; }
  }

  static restoreUrl(url) {
    return url === "chrome://browser/content/blanktab.html" ? "about:blank" : url;
  }

  static rows(w) {
    return { name: w.name, icon: w.icon, color: w.color, containerId: w.containerId,
      groups: w.snapshot.groups, tabs: w.snapshot.tabs.map(tab => ({ ...tab, url: this.restoreUrl(tab.url) })) };
  }
}
