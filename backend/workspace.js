class Workspace {
  constructor(id, state) {
    this.id = id;
    this.name = state.name || 'Unnamed Workspace';
    this.icon = state.icon || "";
    this.active = Boolean(state.active);
    this.tabs = Array.isArray(state.tabs) ? state.tabs : [];
    this.windowId = state.windowId;
    this.groups = Array.isArray(state.groups) ? state.groups : [];
    this.lastActiveTabId = state.lastActiveTabId || null;
    this.containerId = state.containerId || null;
    this.color = state.color || null;
    this.tabSnapshot = Array.isArray(state.tabSnapshot) ? state.tabSnapshot : [];
  }

  static async create(id, state) {
    const wspId = id || crypto.randomUUID();
    console.log("[Workspace][create] wspId:", wspId, "name:", state.name,
      "windowId:", state.windowId, "tabs:", state.tabs?.length ?? 0,
      "active:", state.active, "containerId:", state.containerId || null);
    const wsp = new Workspace(wspId, state);
    await WSPStorageManager.addWsp(wspId, state.windowId);
    await wsp._saveState();
    console.log("[Workspace][create] done — wspId:", wspId);
    return wsp;
  }

  // Filter tab IDs to only those that actually exist in the given window.
  // Pass openTabIds Set to avoid redundant browser.tabs.query calls.
  static async _filterValidTabs(tabIds, windowId, openTabIds = null) {
    if (!openTabIds) {
      const openTabs = await browser.tabs.query({ windowId });
      openTabIds = new Set(openTabs.map(tab => tab.id));
    }
    const valid = tabIds.filter(tabId => openTabIds.has(tabId));
    if (valid.length !== tabIds.length) {
      console.log("[Workspace][_filterValidTabs] windowId:", windowId,
        "input:", tabIds.length, "valid:", valid.length,
        "stale:", tabIds.filter(id => !openTabIds.has(id)));
    }
    return valid;
  }

  async destroy() {
    console.log("[Workspace][destroy] id:", this.id, "name:", this.name,
      "tabs:", this.tabs.length, "windowId:", this.windowId);
    this.tabs = await Workspace._filterValidTabs(this.tabs, this.windowId);
    console.log("[Workspace][destroy] valid tabs to remove:", this.tabs.length);

    if (this.tabs.length > 0) {
      await browser.tabs.remove(this.tabs);
      console.log("[Workspace][destroy] removed", this.tabs.length, "tabs");
    }
    await WSPStorageManager.deleteWspState(this.id);
    await WSPStorageManager.removeWsp(this.id, this.windowId);
    // Clean up closed tabs for this workspace
    await WSPStorageManager.clearClosedTabs(this.id);
    console.log("[Workspace][destroy] done — id:", this.id);
  }

  async activate(activeTabId = null) {
    console.log("[Workspace][activate] id:", this.id, "name:", this.name,
      "tabs:", this.tabs.length, "groups:", this.groups.length,
      "activeTabId param:", activeTabId, "lastActiveTabId:", this.lastActiveTabId);
    this.tabs = await Workspace._filterValidTabs(this.tabs, this.windowId);
    console.log("[Workspace][activate] valid tabs:", this.tabs.length);

    // reconstruct groups
    if (this.tabs.length > 0) {
      const validTabSet = new Set(this.tabs);
      console.log("[Workspace][activate] reconstructing", this.groups.length, "tab groups");
      for (const group of this.groups) {
        group.tabs = group.tabs.filter(tabId => validTabSet.has(tabId));
        if (group.tabs.length > 0) {
          console.log("[Workspace][activate] grouping", group.tabs.length, "tabs for group:", group.title);
          const groupId = await browser.tabs.group({tabIds: group.tabs});
          await browser.tabGroups.update(groupId, {
            title: group.title,
            color: group.color,
            collapsed: group.collapsed
          });
        }
      }

      // show tabs
      console.log("[Workspace][activate] showing", this.tabs.length, "tabs");
      await browser.tabs.show(this.tabs);
    } else {
      console.log("[Workspace][activate] no tabs to show");
    }

    // set active tab
    const pinnedTabIds = (await browser.tabs.query({pinned: true, windowId: this.windowId})).map(tab => tab.id);
    const tabIdToActivate = activeTabId || this.lastActiveTabId;
    const isValid = this.tabs.includes(tabIdToActivate) || pinnedTabIds.includes(tabIdToActivate);
    console.log("[Workspace][activate] tabIdToActivate:", tabIdToActivate,
      "isValid:", isValid, "pinnedTabIds:", pinnedTabIds.length);

    if (isValid || this.tabs.length > 0) {
      const tabToFocus = isValid ? tabIdToActivate : this.tabs[0];
      console.log("[Workspace][activate] activating tab:", tabToFocus,
        isValid ? "(lastActive/requested)" : "(fallback: first tab)");
      await browser.tabs.update(tabToFocus, {active: true});
    } else {
      console.log("[Workspace][activate] no tabs at all — creating fallback tab");
      await this._createTabFallback();
    }

    // Save tab URL snapshot for restart resilience
    try {
      const allTabs = await browser.tabs.query({windowId: this.windowId, pinned: false});
      const tabMap = new Map(allTabs.map(t => [t.id, t]));
      this.tabSnapshot = this.tabs
        .map(id => tabMap.get(id))
        .filter(t => t && t.url)
        .map(t => t.url);
      console.log("[Workspace][activate] snapshot saved:", this.tabSnapshot.length, "URLs");
    } catch (e) { /* non-critical — snapshot is a resilience measure */ }

    this.active = true;
    await this._saveState();
    console.log("[Workspace][activate] done — id:", this.id);
  }

  async hideTabs() {
    console.log("[Workspace][hideTabs] id:", this.id, "name:", this.name,
      "tabs:", this.tabs.length, "windowId:", this.windowId);
    this.active = false;

    this.tabs = await Workspace._filterValidTabs(this.tabs, this.windowId);
    console.log("[Workspace][hideTabs] valid tabs to hide:", this.tabs.length);

    // hide
    if (this.tabs.length > 0) {
      await browser.tabs.hide(this.tabs);
      await browser.tabs.ungroup(this.tabs);
      console.log("[Workspace][hideTabs] hidden and ungrouped", this.tabs.length, "tabs");
    }
    await this._saveState();
    console.log("[Workspace][hideTabs] done — id:", this.id);
  }

  async updateTabGroups() {
    const groups = await browser.tabGroups.query({windowId: this.windowId});
    const tabs = await browser.tabs.query({windowId: this.windowId});

    this.groups = groups.map(group => {
      const tabIds = tabs
        .filter(tab => tab.groupId === group.id && this.tabs.includes(tab.id))
        .map(tab => tab.id);

      return {
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
        tabs: tabIds
      };
    }).filter(group => group.tabs.length > 0);

    console.log("[Workspace][updateTabGroups] id:", this.id,
      "found", this.groups.length, "groups with tabs");
    await this._saveState();
  }

  static async rename(wspId, { name, icon, color } = {}) {
    console.log("[Workspace][rename] wspId:", wspId,
      "name:", name, "icon:", icon, "color:", color);
    const state = await WSPStorageManager.getWspState(wspId);
    const oldName = state.name;
    const oldIcon = state.icon;
    const oldColor = state.color;
    if (name !== undefined) state.name = name;
    if (icon !== undefined) state.icon = icon;
    if (color !== undefined) state.color = color;
    console.log("[Workspace][rename] changes — name:", oldName, "->", state.name,
      "| icon:", oldIcon, "->", state.icon, "| color:", oldColor, "->", state.color);
    // Re-construct through Workspace to apply constructor normalization
    const wsp = new Workspace(wspId, state);
    await wsp._saveState();
    console.log("[Workspace][rename] done — wspId:", wspId);
  }

  // Create a new tab for this workspace, falling back to no container if the
  // stored containerId is stale (container was deleted by the user or by Firefox).
  async _createTabFallback() {
    console.log("[Workspace][_createTabFallback] id:", this.id,
      "containerId:", this.containerId || null);
    const baseOpts = { active: true, windowId: this.windowId };
    if (this.containerId) {
      if (!await TabService._verifyContainer(this.containerId)) {
        console.warn("[Workspaces] _createTabFallback: container %s not found, clearing", this.containerId);
        this.containerId = null;
        await this._saveState();
      } else {
        try {
          console.log("[Workspace][_createTabFallback] creating tab in container:", this.containerId);
          return await browser.tabs.create({ ...baseOpts, cookieStoreId: this.containerId });
        } catch (e) {
          console.warn("[Workspaces] _createTabFallback: tabs.create failed:", this.containerId, e.message);
          this.containerId = null;
          await this._saveState();
        }
      }
    }
    console.log("[Workspace][_createTabFallback] creating plain tab (no container)");
    return await browser.tabs.create(baseOpts);
  }

  async _saveState() {
    await WSPStorageManager.saveWspState(this.id, {
      id: this.id,
      name: this.name,
      icon: this.icon,
      active: this.active,
      tabs: this.tabs,
      groups: this.groups,
      windowId: this.windowId,
      lastActiveTabId: this.lastActiveTabId,
      containerId: this.containerId,
      color: this.color,
      tabSnapshot: this.tabSnapshot
    });
  }
}
