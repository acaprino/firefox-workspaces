// Simple async mutex to serialize read-modify-write operations per key
class AsyncMutex {
  constructor() {
    this._locks = new Map();
  }

  async acquire(key) {
    while (this._locks.has(key)) {
      await this._locks.get(key);
    }
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    this._locks.set(key, promise);
    return release;
  }

  release(key, releaseFn) {
    this._locks.delete(key);
    releaseFn();
  }

  async run(key, fn) {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      this.release(key, release);
    }
  }
}

const _storageMutex = new AsyncMutex();

// Shared UUID regex - used by restore, tab assignment, and session-value validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STORAGE_KEYS = {
  wspState: (id) => `ld-wsp-${id}`,
  windowWsps: (id) => `ld-wsp-window-${id}`,
  wspOrder: (id) => `ld-wsp-order-${id}`,
  closedTabs: (id) => `ld-wsp-closed-${id}`,
  primaryWindow: 'primary-window-id',
  primaryWindowLast: 'primary-window-last-id',
  schemaVersion: 'ld-wsp-schema-version',
};

class WSPStorageManager {
  static SCHEMA_VERSION = 2;

  static async ensureSchemaVersion() {
    const key = STORAGE_KEYS.schemaVersion;
    const result = await browser.storage.local.get(key);
    const current = result[key] || 1;
    if (current < WSPStorageManager.SCHEMA_VERSION) {
      // Future migrations go here (e.g., if current === 1 then migrate v1 -> v2)
      await browser.storage.local.set({ [key]: WSPStorageManager.SCHEMA_VERSION });
    }
  }

  static async getWspState(wspId) {
    const key = STORAGE_KEYS.wspState(wspId);
    const results = await browser.storage.local.get(key);
    return results[key] || {};
  }

  static async saveWspState(wspId, state) {
    const key = STORAGE_KEYS.wspState(wspId);
    await browser.storage.local.set({ [key]: state });
  }

  static async deleteWspState(wspId) {
    const key = STORAGE_KEYS.wspState(wspId);
    await browser.storage.local.remove(key);
  }

  static async getWorkspaces(windowId) {
    const key = STORAGE_KEYS.windowWsps(windowId);
    const results = await browser.storage.local.get(key);
    const wspIds = results[key] || [];

    // Batch-read all workspace states in one call
    const keys = wspIds.map(id => STORAGE_KEYS.wspState(id));
    const allStates = keys.length > 0 ? await browser.storage.local.get(keys) : {};

    return wspIds.map(wspId => {
      const state = allStates[STORAGE_KEYS.wspState(wspId)] || {};
      return new Workspace(wspId, state);
    });
  }

  static async getWorkspace(wspId) {
    const state = await WSPStorageManager.getWspState(wspId);
    return new Workspace(wspId, state);
  }

  static async getNumWorkspaces(windowId) {
    const key = STORAGE_KEYS.windowWsps(windowId);
    const results = await browser.storage.local.get(key);
    return (results[key] || []).length;
  }

  static async addWsp(wspId, windowId) {
    return _storageMutex.run(`window-${windowId}`, async () => {
      const key = STORAGE_KEYS.windowWsps(windowId);
      const results = await browser.storage.local.get(key);
      const wspIds = results[key] || [];
      if (!wspIds.includes(wspId)) {
        wspIds.push(wspId);
        await browser.storage.local.set({ [key]: wspIds });
      }
    });
  }

  static async removeWsp(wspId, windowId) {
    return _storageMutex.run(`window-${windowId}`, async () => {
      const key = STORAGE_KEYS.windowWsps(windowId);
      const results = await browser.storage.local.get(key);
      const wspIds = results[key] || [];

      const idx = wspIds.indexOf(wspId);
      if (idx >= 0) {
        wspIds.splice(idx, 1);
      }

      await browser.storage.local.set({ [key]: wspIds });
    });
  }

  // delete data (window id and associated tabs) associated to window
  static async destroyWindow(windowId) {
    const key = STORAGE_KEYS.windowWsps(windowId);
    const results = await browser.storage.local.get(key);
    const wspIds = results[key] || [];

    // 1. delete window-id: [array of associated workspaces ids] from local storage
    await browser.storage.local.remove(key);

    // 2. delete all workspace-ids: [array of tabs] associated with that window from local storage
    await Promise.all(wspIds.map(WSPStorageManager.deleteWspState));

    // 3. clean up closed-tab entries for each workspace
    await Promise.all(wspIds.map(id => WSPStorageManager.clearClosedTabs(id)));

    // 4. clean up workspace order for this window
    await browser.storage.local.remove(STORAGE_KEYS.wspOrder(windowId));
  }

  static async getPrimaryWindowId() {
    const key = STORAGE_KEYS.primaryWindow;
    const result = await browser.storage.local.get(key);
    return result[key];
  }

  static async setPrimaryWindowId(windowId) {
    const key = STORAGE_KEYS.primaryWindow;
    await browser.storage.local.set({[key]: windowId});
  }

  static async removePrimaryWindowId() {
    await browser.storage.local.remove(STORAGE_KEYS.primaryWindow);
  }

  static async getPrimaryWindowLastId() {
    const key = STORAGE_KEYS.primaryWindowLast;
    const result = await browser.storage.local.get(key);
    return result[key];
  }

  static async setPrimaryWindowLastId(windowId) {
    const key = STORAGE_KEYS.primaryWindowLast;
    await browser.storage.local.set({[key]: windowId});
  }

  static async removePrimaryWindowLastId() {
    await browser.storage.local.remove(STORAGE_KEYS.primaryWindowLast);
  }

  // ── Closed Tabs (Tier 2) ──

  static async saveClosedTab(wspId, tabInfo) {
    return _storageMutex.run(`closed-${wspId}`, async () => {
      const key = STORAGE_KEYS.closedTabs(wspId);
      const results = await browser.storage.local.get(key);
      const closedTabs = results[key] || [];
      closedTabs.unshift(tabInfo);
      // Keep max 25 closed tabs per workspace
      if (closedTabs.length > 25) closedTabs.length = 25;
      await browser.storage.local.set({[key]: closedTabs});
    });
  }

  static async getClosedTabs(wspId) {
    const key = STORAGE_KEYS.closedTabs(wspId);
    const results = await browser.storage.local.get(key);
    return results[key] || [];
  }

  static async clearClosedTabs(wspId) {
    const key = STORAGE_KEYS.closedTabs(wspId);
    await browser.storage.local.remove(key);
  }

  static async removeClosedTab(wspId, index) {
    const key = STORAGE_KEYS.closedTabs(wspId);
    const results = await browser.storage.local.get(key);
    const closedTabs = results[key] || [];
    if (index >= 0 && index < closedTabs.length) {
      closedTabs.splice(index, 1);
      await browser.storage.local.set({[key]: closedTabs});
    }
  }

  // Per-workspace mutex for read-modify-write cycles.
  // Prevents addTabToWorkspace and removeTabFromWorkspace from overwriting
  // each other's changes when they interleave at await points.
  static async withWorkspaceLock(wspId, fn) {
    return _storageMutex.run(`wsp-${wspId}`, fn);
  }

  // ── Workspace Order (Tier 3) ──

  static async getWorkspaceOrder(windowId) {
    const key = STORAGE_KEYS.wspOrder(windowId);
    const results = await browser.storage.local.get(key);
    return results[key] || null;
  }

  static async saveWorkspaceOrder(windowId, orderedIds) {
    const key = STORAGE_KEYS.wspOrder(windowId);
    await browser.storage.local.set({[key]: orderedIds});
  }
}
