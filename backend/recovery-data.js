// Persisted recovery data has one schema owner. This module is pure: it does
// not read tabs or storage, and never treats an invalid row as a
// trustworthy container assignment.
class RecoveryData {
  static VERSION = 1;
  static _container = /^(?:firefox-default|firefox-container-\d+)$/;

  static _validRows(value) {
    if (!Array.isArray(value?.groups) || !Array.isArray(value?.tabs)) return false;
    const keys = new Set();
    for (const group of value.groups) {
      if (!group || typeof group.key !== "string" || !group.key || keys.has(group.key)
          || typeof group.title !== "string" || typeof group.color !== "string"
          || typeof group.collapsed !== "boolean") return false;
      keys.add(group.key);
    }
    return value.tabs.every(tab => {
      if (!tab || typeof tab.url !== "string" || !tab.url || typeof tab.title !== "string"
          || typeof tab.cookieStoreId !== "string" || !RecoveryData._container.test(tab.cookieStoreId)
          || (tab.groupKey !== null && !keys.has(tab.groupKey))) return false;
      return true;
    });
  }

  static readSnapshot(value) {
    return value?.version === RecoveryData.VERSION
      && Number.isFinite(value.savedAt) && value.savedAt >= 0
      && RecoveryData._validRows(value) ? value : null;
  }

  static fromWorkspace(wsp) {
    const snapshot = RecoveryData.readSnapshot(wsp.recoverySnapshot);
    const urls = Array.isArray(wsp.tabSnapshot) ? wsp.tabSnapshot : [];
    const complete = Boolean(snapshot && snapshot.tabs.length === urls.length
      && snapshot.tabs.every((tab, i) => tab.url === urls[i]));
    return {
      complete,
      savedAt: complete ? snapshot.savedAt : null,
      groups: complete ? snapshot.groups : [],
      tabs: complete ? snapshot.tabs : urls.map(url => ({ url, title: url,
        cookieStoreId: wsp.containerId || "firefox-default", groupKey: null })),
    };
  }

}
