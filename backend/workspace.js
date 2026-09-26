class Workspace {
  constructor(id, state) {
    this.id = id;
    this.name = state.name || 'Unnamed Workspace';
    this.icon = state.icon || "";
    this.active = Boolean(state.active);
    this.tabs = Array.isArray(state.tabs) ? state.tabs : [];
    this.windowId = state.windowId;
    this.groups = Array.isArray(state.groups) ? state.groups : [];
    this.lastActiveTabId = state.lastActiveTabId ?? null;
    this.lastActiveTabUrl = state.lastActiveTabUrl ?? null;
    this.containerId = state.containerId ?? null;
    this.color = state.color ?? null;
    this.tabSnapshot = Array.isArray(state.tabSnapshot) ? state.tabSnapshot : [];
  }

  static async create(id, state) {
    const wspId = id ?? crypto.randomUUID();
    console.log("[Workspace][create] wspId:", wspId, "name:", state.name,
      "windowId:", state.windowId, "tabs:", state.tabs?.length ?? 0,
      "active:", state.active, "containerId:", state.containerId || null);
    const wsp = new Workspace(wspId, state);
    await WSPStorageManager.addWsp(wspId, state.windowId);
    // Whole-record write under the workspace lock: restore re-creates
    // records under reused ids, and a locked writer holding a pre-restore
    // copy (e.g. a snapshot refresh) must not interleave with it.
    await WSPStorageManager.withWorkspaceLock(wspId, () => wsp._saveState());
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

    // Critical ordering: removeWsp (window list) BEFORE tabs.remove.
    // tabs.remove triggers onTabRemoved -> removeTabFromWorkspace which
    // iterates workspaces from the window list via getWorkspaces(windowId).
    // Removing from the window list first ensures that iteration no longer
    // sees this wspId, so removeTabFromWorkspace becomes a no-op and cannot
    // re-create zombie state for the workspace we are about to delete.
    // deleteWspState and clearClosedTabs can come in any order after.
    await WSPStorageManager.removeWsp(this.id, this.windowId);
    await WSPStorageManager.deleteWspState(this.id);
    await WSPStorageManager.clearClosedTabs(this.id);

    if (this.tabs.length > 0) {
      try {
        await browser.tabs.remove(this.tabs);
        console.log("[Workspace][destroy] removed", this.tabs.length, "tabs");
      } catch (e) {
        // Tabs may have closed between _filterValidTabs and remove (TOCTOU),
        // OR tabs.remove genuinely failed. In the latter case, we have an
        // orphan situation: state is already deleted but the tabs are still
        // open with session values pointing to a nonexistent wspId. Best-
        // effort recovery: clear each tab's session value so future restart
        // logic doesn't try to route it to the deleted workspace.
        console.warn("[Workspace][destroy] tabs.remove failed:", e.message);
        for (const tabId of this.tabs) {
          try {
            await browser.sessions.removeTabValue(tabId, "wspId");
          } catch { /* tab already gone — fine */ }
        }
      }
    }
    console.log("[Workspace][destroy] done — id:", this.id);
  }

  // `allTabsHint`: optional pre-fetched tabs.query({windowId}) result. The
  // activation cascade used to issue up to six full-window queries; callers
  // that already hold the list pass it here to avoid three of them.
  async activate(activeTabId = null, allTabsHint = null) {
    console.log("[Workspace][activate] id:", this.id, "name:", this.name,
      "tabs:", this.tabs.length, "groups:", this.groups.length,
      "activeTabId param:", activeTabId, "lastActiveTabId:", this.lastActiveTabId);
    const storedTabs = this.tabs;
    this.tabs = await Workspace._filterValidTabs(this.tabs, this.windowId,
      allTabsHint ? new Set(allTabsHint.map(t => t.id)) : null);
    console.log("[Workspace][activate] valid tabs:", this.tabs.length);
    // Exactly the ids found closed here; the final save drops only these
    // from the fresh record (a tab filed meanwhile is not in allTabsHint).
    const validNow = new Set(this.tabs);
    const staleIds = new Set(storedTabs.filter(id => !validNow.has(id)));
    let fallbackTabId = null;

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
    const pinnedTabIds = (allTabsHint
      ? allTabsHint.filter(t => t.pinned)
      : await browser.tabs.query({pinned: true, windowId: this.windowId})).map(tab => tab.id);
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
      console.log("[Workspace][activate] no tabs at all -- creating fallback tab");
      // Guard against onCreated racing with the manual tabs.push below:
      // the reopen guard tells addTabToWorkspace to skip this tab.
      await TabService.withReopenGuard(async () => {
        const fallbackTab = await this._createTabFallback();
        fallbackTabId = fallbackTab.id;
        this.tabs.push(fallbackTab.id);
        await TabService.setTabSessionValue(fallbackTab.id, this.id);
      });
    }
    const shown = new Set(this.tabs);

    // Live tab map for the URL snapshot (restart resilience)
    let tabMap = null;
    try {
      const allTabs = allTabsHint
        ? allTabsHint.filter(t => !t.pinned)
        : await browser.tabs.query({windowId: this.windowId, pinned: false});
      tabMap = new Map(allTabs.map(t => [t.id, t]));
    } catch (e) { console.debug("[Workspace][activate] snapshot query failed:", e.message); }

    // Persist field by field onto the fresh record under the workspace lock.
    // Saving `this` whole reverted every locked write that landed during the
    // awaits above: a tab filed or moved into this workspace, a rename, a
    // container change, a tab closed mid-activation.
    const saved = await WSPStorageManager.mutateWorkspace(this.id, (fresh) => {
      fresh.tabs = fresh.tabs.filter(id => !staleIds.has(id));
      if (fallbackTabId != null && !fresh.tabs.includes(fallbackTabId)) fresh.tabs.push(fallbackTabId);
      const member = new Set(fresh.tabs);
      for (const group of fresh.groups) group.tabs = group.tabs.filter(id => member.has(id));
      if (tabMap) {
        fresh.tabSnapshot = fresh.tabs
          .map(id => tabMap.get(id))
          .filter(t => t && t.url)
          .map(t => t.url);
        console.log("[Workspace][activate] snapshot saved:", fresh.tabSnapshot.length, "URLs");
      }
      fresh.active = true;
    });
    if (!saved) {
      console.warn("[Workspace][activate] id:", this.id, "destroyed mid-activation -- nothing saved");
      return false;
    }
    // Callers read the result (active cache, container, toolbar).
    Object.assign(this, saved);

    // Tabs filed here during the activation were hidden as another
    // workspace's tabs; this workspace is active now, so show them.
    const late = this.tabs.filter(id => !shown.has(id));
    if (late.length > 0) {
      console.log("[Workspace][activate] showing", late.length, "tab(s) filed during activation:", late);
      await Promise.all(late.map(id => browser.tabs.show(id).catch(() => {})));
    }
    console.log("[Workspace][activate] done — id:", this.id);
    return true;
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
    // Persist only the groups field onto a fresh record under the workspace
    // lock: saving `this` whole would clobber any tabs[] change a concurrent
    // locked writer landed since we were constructed.
    await WSPStorageManager.mutateWorkspace(this.id, (fresh) => {
      fresh.groups = this.groups;
    });
  }

  static async rename(wspId, { name, icon, color } = {}) {
    console.log("[Workspace][rename] wspId:", wspId,
      "name:", name, "icon:", icon, "color:", color);
    // Locked read-modify-write so a concurrent tab add/remove (which also
    // rewrites the record) cannot be lost. A workspace destroyed while the
    // rename dialog was open is reported, not resurrected as a zombie record.
    const saved = await WSPStorageManager.mutateWorkspace(wspId, (fresh) => {
      const oldName = fresh.name;
      const oldIcon = fresh.icon;
      const oldColor = fresh.color;
      // Same normalization as the constructor
      if (name !== undefined) fresh.name = name || 'Unnamed Workspace';
      if (icon !== undefined) fresh.icon = icon || "";
      if (color !== undefined) fresh.color = color ?? null;
      console.log("[Workspace][rename] changes -- name:", oldName, "->", fresh.name,
        "| icon:", oldIcon, "->", fresh.icon, "| color:", oldColor, "->", fresh.color);
    });
    if (!saved) throw new Error(Workspace.NOT_FOUND_MESSAGE);
    console.log("[Workspace][rename] done — wspId:", wspId);
  }

  // User-facing refusal for edits aimed at a workspace that no longer exists
  // (handler.js surfaces errors starting with "Workspace not found").
  static NOT_FOUND_MESSAGE = "Workspace not found - it was deleted in the meantime.";

  // Create a new tab for this workspace, falling back to no container if the
  // stored containerId is stale (container was deleted by the user or by Firefox).
  async _createTabFallback() {
    console.log("[Workspace][_createTabFallback] id:", this.id,
      "containerId:", this.containerId || null);
    const baseOpts = { active: true, windowId: this.windowId };
    if (this.containerId) {
      if (!await TabService._verifyContainer(this.containerId)) {
        console.warn("[Workspaces] _createTabFallback: container %s not found, clearing", this.containerId);
        await this._clearStaleContainer();
      } else {
        try {
          console.log("[Workspace][_createTabFallback] creating tab in container:", this.containerId);
          return await browser.tabs.create({ ...baseOpts, cookieStoreId: this.containerId });
        } catch (e) {
          console.warn("[Workspaces] _createTabFallback: tabs.create failed:", this.containerId, e.message);
          await this._clearStaleContainer();
        }
      }
    }
    console.log("[Workspace][_createTabFallback] creating plain tab (no container)");
    return await browser.tabs.create(baseOpts);
  }

  // Drop an unusable container binding. Only the containerId field, and only
  // if the fresh record still names the stale container: a full save of
  // `this` used to revert concurrent locked writes, and a concurrent
  // setWorkspaceContainer to a working container must survive.
  async _clearStaleContainer() {
    const stale = this.containerId;
    this.containerId = null;
    await WSPStorageManager.mutateWorkspace(this.id, (fresh) => {
      if (fresh.containerId !== stale) return false;
      fresh.containerId = null;
    });
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
      lastActiveTabUrl: this.lastActiveTabUrl,
      containerId: this.containerId,
      color: this.color,
      tabSnapshot: this.tabSnapshot
    });
  }
}
