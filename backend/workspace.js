class Workspace {
  constructor(id, state) {
    this.id = id;
    this.name = state.name || 'Unnamed Workspace';
    this.icon = state.icon || "";
    this.active = Boolean(state.active);
    this.tabs = Array.isArray(state.tabs) ? state.tabs : [];
    this.windowId = state.windowId;
    // Entries without a key come from older versions. They listed tab ids,
    // which name other tabs after a restart: building a group from them
    // grouped and moved the wrong tabs.
    this.groups = Array.isArray(state.groups) ? state.groups.filter(group => group?.key) : [];
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
    // Tombstone first: a background that dies before tabs.remove below
    // leaves hidden tabs tagged with this id and no record, which the next
    // init used to adopt into the active workspace -- tabs the user deleted
    // coming back (X-96). The tombstone lets init finish the close instead.
    await WSPStorageManager.addPendingDestroy(this.id);
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
    await WSPStorageManager.removePendingDestroy(this.id);
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

    if (this.tabs.length > 0) {
      if (this.groups.length > 0) await this._rebuildGroups(allTabsHint);

      // show tabs (tolerates a tab closing meanwhile, X-104)
      console.log("[Workspace][activate] showing", this.tabs.length, "tabs");
      await TabService.showTabs(this.tabs);
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
      // A tab that closed since the query must not abort the activation
      // (X-29): fall back to another tab of this workspace.
      for (const id of [tabToFocus, ...this.tabs.filter(t => t !== tabToFocus)]) {
        try {
          await browser.tabs.update(id, {active: true});
          break;
        } catch (e) {
          console.debug("[Workspace][activate] could not select tab", id, ":", e.message);
        }
      }
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
      await TabService.showTabs(late);
    }
    console.log("[Workspace][activate] done — id:", this.id);
    return true;
  }

  // Build back the native groups taken apart when this workspace was hidden.
  // A group's tabs are the ones carrying its key (TabService.getGroupTags).
  // A group with a tab already in a native group is left alone: Firefox
  // restored it with the session, or it never went away. tabs.group always
  // makes a new group and pulls the listed tabs out of any other, so building
  // on top of a restored group split it, one more at every restart.
  async _rebuildGroups(allTabsHint) {
    const live = new Map((allTabsHint ?? await browser.tabs.query({windowId: this.windowId}))
      .map(tab => [tab.id, tab]));
    const keys = await TabService.getGroupTags(this.tabs);
    console.log("[Workspace][_rebuildGroups] id:", this.id, "groups:", this.groups.length,
      "tabs with a key:", keys.size);
    for (const group of this.groups) {
      const members = this.tabs
        .filter(id => keys.get(id) === group.key && live.has(id) && !TabService.wasRemoved(id))
        .sort((a, b) => live.get(a).index - live.get(b).index);
      if (members.length === 0 || members.some(id => live.get(id).groupId !== -1)) continue;
      console.log("[Workspace][_rebuildGroups] grouping", members.length, "tabs for group:", group.title);
      // A failure must not abort the activation (X-104, X-29). The group is not
      // lost: its tabs keep their key, and the next activation tries again.
      try {
        const groupId = await this._groupTabs(members);
        await browser.tabGroups.update(groupId, {
          title: group.title,
          color: group.color,
          collapsed: group.collapsed
        });
      } catch (e) {
        console.debug("[Workspace][_rebuildGroups] could not regroup", group.title, ":", e.message);
      }
    }
  }

  // tabs.group checks every id first, so one tab closing right now rejects the
  // call: once more without the tabs that no longer answer. The window is
  // explicit because the default is the window in front, and the tabs would
  // move there.
  async _groupTabs(tabIds) {
    const createProperties = {windowId: this.windowId};
    try {
      return await browser.tabs.group({tabIds, createProperties});
    } catch (e) {
      const answers = await Promise.all(tabIds.map(id => browser.tabs.get(id).then(() => id, () => null)));
      const alive = answers.filter(id => id != null);
      if (alive.length === 0 || alive.length === tabIds.length) throw e;
      return browser.tabs.group({tabIds: alive, createProperties});
    }
  }

  // Record this workspace's native groups: title, color and state in `groups`,
  // membership as a session value per tab, which survives a restart where a
  // tab id does not (TabService.getGroupTags). A native group keeps a key its
  // tabs already carry when no other group took it, else gets a new one.
  // A group not native right now stays as long as tabs carry its key: its
  // workspace is off screen, or its rebuild failed. This pass cannot tell those
  // from a group the user took apart: a tab that leaves a group drops its key
  // itself (tabs.onUpdated in Brainer). When the group is native, it says who
  // is in it, and a tab carrying its key from outside left unseen.
  // `tabs: []` in an entry is for an older build running on this data (AMO
  // rollback, see SCHEMA_VERSION): it filters that list and finds nothing.
  // Under the workspace lock from the first read on: two passes side by side
  // would give one group two keys, and the tabs and the record would disagree.
  async updateTabGroups() {
    const saved = await WSPStorageManager.mutateWorkspace(this.id, async (fresh) => {
      const member = new Set(fresh.tabs);
      const own = (await browser.tabs.query({windowId: fresh.windowId})).filter(tab => member.has(tab.id));
      const nativeGroups = await browser.tabGroups.query({windowId: fresh.windowId});
      const carried = await TabService.getGroupTags(own.map(tab => tab.id));

      const taken = new Set();
      const groups = [];
      const retagged = [];
      for (const native of nativeGroups) {
        const tabs = own.filter(tab => tab.groupId === native.id);
        if (tabs.length === 0) continue;
        const key = tabs.map(tab => carried.get(tab.id)).find(k => k && !taken.has(k)) ?? crypto.randomUUID();
        taken.add(key);
        for (const tab of tabs) {
          if (carried.get(tab.id) === key) continue;
          carried.set(tab.id, key);
          retagged.push(TabService.setGroupTag(tab.id, key));
        }
        groups.push({ key, title: native.title, color: native.color, collapsed: native.collapsed, tabs: [] });
      }
      const nativeIds = new Set(nativeGroups.map(native => native.id));
      for (const tab of own) {
        if (nativeIds.has(tab.groupId) || !taken.has(carried.get(tab.id))) continue;
        carried.delete(tab.id);
        retagged.push(TabService.clearGroupTag(tab.id));
      }
      await Promise.all(retagged);
      const stillCarried = new Set(carried.values());
      groups.push(...fresh.groups.filter(group => !taken.has(group.key) && stillCarried.has(group.key)));
      console.log("[Workspace][updateTabGroups] id:", this.id, "found", groups.length, "groups with tabs");
      if (JSON.stringify(groups) === JSON.stringify(fresh.groups)) return false;
      fresh.groups = groups;
    });
    if (saved) this.groups = saved.groups;
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
