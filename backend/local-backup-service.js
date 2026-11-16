// JSON files are the sole version-history store. storage.local contains only
// connection/settings and the last operation's status, never archive copies.
class LocalBackupService {
  static KEY = "ld-wsp-local-backup";
  static STATUS_KEY = "ld-wsp-local-backup-status";
  static ALARM = "workspaces-file-backup";
  static CHANGE_ALARM = "workspaces-file-backup-change";
  static _mutex = new AsyncMutex();
  static _started = false;
  static _verifiedHost = null;

  static async settings() {
    return (await browser.storage.local.get(this.KEY))[this.KEY] || null;
  }

  static async status() {
    const config = await this.settings();
    const status = (await browser.storage.local.get(this.STATUS_KEY))[this.STATUS_KEY] || {};
    return { ...status, enabled: config?.enabled !== false, connected: Boolean(LocalBackupData.connection(config)), limit: config?.limit || 50 };
  }

  // Called under the operation mutex so discovery cannot undo an explicit pause.
  static async _connectDefault({ resume = false, connectPaused = false } = {}) {
    const existing = await this.settings();
    if (existing?.enabled === false && !resume && !connectPaused) return existing;
    if (LocalBackupData.connection(existing) && existing.host === this._verifiedHost) return existing;
    const reply = await this._native({ host: "org.hardfox.workspaces" },
      { operation: "discover", origin: browser.runtime.getURL("") });
    const settings = { ...reply.connection, enabled: resume || existing?.enabled !== false, limit: existing?.limit || 50 };
    const previous = existing?.host === settings.host
      ? (await browser.storage.local.get(this.STATUS_KEY))[this.STATUS_KEY] || {} : {};
    await browser.storage.local.set({ [this.KEY]: settings,
      [this.STATUS_KEY]: { ...previous, directory: reply.directory, error: null } });
    this._verifiedHost = settings.host;
    return settings;
  }

  static async configure(connection, limit = 50) {
    if (!LocalBackupData.connection(connection) || !Number.isInteger(limit) || limit < 2 || limit > 200) {
      throw new Error("Invalid connection file or version limit (2..200)");
    }
    await this._mutex.run("operation", async () => {
      const reply = await this._native(connection, { operation: "status" });
      await browser.storage.local.set({ [this.KEY]: { ...connection, enabled: true, limit },
        [this.STATUS_KEY]: { directory: reply.directory, error: null } });
    });
    await this.start();
    return this.status();
  }

  static async setLimit(limit) {
    if (!Number.isInteger(limit) || limit < 2 || limit > 200) throw new Error("Version limit must be 2..200");
    return this._mutex.run("operation", async () => {
      const settings = await this.settings() || { enabled: true };
      await browser.storage.local.set({ [this.KEY]: { ...settings, limit } });
      return this.status();
    });
  }

  static async resume() {
    await this._mutex.run("operation", async () => {
      const settings = await this._connectDefault({ resume: true });
      const reply = await this._native(settings, { operation: "status" });
      const previous = (await browser.storage.local.get(this.STATUS_KEY))[this.STATUS_KEY] || {};
      await browser.storage.local.set({ [this.KEY]: { ...settings, enabled: true },
        [this.STATUS_KEY]: { ...previous, directory: reply.directory, error: null } });
    });
    await this.start();
    return this.status();
  }

  static async disable() {
    return this._mutex.run("operation", async () => {
      const settings = await this.settings();
      await browser.storage.local.set({ [this.KEY]: { ...settings, enabled: false } });
      await browser.alarms.clear(this.ALARM);
      await browser.alarms.clear(this.CHANGE_ALARM);
      return this.status();
    });
  }

  static async start() {
    if (!this._started) {
      this._started = true;
      browser.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === this.ALARM || alarm.name === this.CHANGE_ALARM) void this.run();
      });
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && Object.keys(changes).some(key =>
          /^ld-wsp-(?:[0-9a-f-]{36}|window-\d+|order-\d+)$/.test(key))) void this.schedule();
      });
    }
    await this._mutex.run("operation", async () => {
      if ((await this.settings())?.enabled !== false) {
        await browser.alarms.create(this.ALARM, { delayInMinutes: 0.1, periodInMinutes: 5 });
        try { await this._connectDefault(); }
        catch (e) {
          const previous = (await browser.storage.local.get(this.STATUS_KEY))[this.STATUS_KEY] || {};
          await browser.storage.local.set({ [this.STATUS_KEY]: { ...previous, error: e.message } });
        }
      }
    });
  }

  static async schedule() {
    try {
      if ((await this.settings())?.enabled) {
        await browser.alarms.create(this.CHANGE_ALARM, { delayInMinutes: 0.1 });
      }
    } catch (e) { console.warn("[LocalBackup] scheduling failed:", e.message); }
  }

  static _native(connection, message) {
    return new Promise((resolve, reject) => {
      let port;
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        port?.disconnect();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error("Backup helper did not respond within 15 seconds")), 15000);
      try {
        port = browser.runtime.connectNative(connection.host);
        port.onMessage.addListener(reply => {
          if (reply?.ok !== true || (message.operation === "discover"
            ? !LocalBackupData.connection(reply.connection) || reply.profileId !== reply.connection.profileId
            : reply.profileId !== connection.profileId)) {
            finish(new Error(reply?.error || "Backup helper returned an invalid response"));
          } else finish(null, reply);
        });
        port.onDisconnect.addListener(() => finish(new Error("Backup helper is unavailable. Check its installation.")));
        port.postMessage({ ...message, profileId: connection.profileId });
      } catch { finish(new Error("Backup helper is unavailable. Check its installation.")); }
    });
  }

  static async _ready() {
    if (Brainer._state !== "ready" || Brainer._refuseToWipeActive || Brainer._pendingRestore
        || await WSPStorageManager.getLastRestoreError()
        || await WSPStorageManager.getPrimaryWindowLastId()) {
      throw new Error("Backup paused: session recovery is incomplete. Previous JSON files are preserved.");
    }
  }

  static async capture(profileId) {
    return WorkspaceService._onActivationChain(async () => {
      await this._ready();
      const windowId = await WSPStorageManager.getPrimaryWindowId();
      const window = await browser.windows.get(windowId);
      if (window.incognito || (window.type && window.type !== "normal")) throw new Error("No normal workspace window");
      let workspaces = await WorkspaceService.getOrderedWorkspaces(windowId);
      for (const wsp of workspaces) await wsp.updateTabGroups();
      workspaces = await WorkspaceService.getOrderedWorkspaces(windowId);
      const before = JSON.stringify(workspaces);
      const tabs = await browser.tabs.query({ windowId, pinned: false });
      const tabState = values => JSON.stringify(values.map(t => [t.id, t.url, t.title, t.cookieStoreId, t.groupId, t.index]));
      const tabMap = new Map(tabs.map(tab => [tab.id, tab]));
      const seen = new Set();
      const rows = [];
      for (const wsp of workspaces) {
        const own = [];
        for (const id of wsp.tabs) {
          const tab = tabMap.get(id);
          if (!tab || !tab.url || tab.incognito || seen.has(id)
              || await browser.sessions.getTabValue(id, "wspId") !== wsp.id) {
            throw new Error("Backup paused: tab ownership is changing");
          }
          seen.add(id);
          own.push(tab);
        }
        rows.push({ sourceId: wsp.id, name: wsp.name, icon: wsp.icon, color: wsp.color,
          containerId: wsp.containerId, active: wsp.active, snapshot: await SnapshotService.capture(own, wsp.groups) });
      }
      if (seen.size !== tabs.length || !tabs.some(t => !Brainer._PLACEHOLDER_URL_RE.test(t.url))) {
        throw new Error("Backup paused: session is empty or still loading");
      }
      const archive = await this._archive(profileId, rows);
      if (before !== JSON.stringify(await WorkspaceService.getOrderedWorkspaces(windowId))
          || tabState(tabs) !== tabState(await browser.tabs.query({ windowId, pinned: false }))) {
        throw new Error("Backup paused: tabs changed during capture; it will retry automatically");
      }
      await this._ready();
      return archive;
    });
  }

  static async _archive(profileId, workspaces) {
    const containers = (await browser.contextualIdentities.query({})).map(({ cookieStoreId, name, icon, color }) =>
      ({ cookieStoreId, name, icon, color }));
    const archive = { format: LocalBackupData.FORMAT, version: 1, profileId, createdAt: Date.now(),
      extensionVersion: browser.runtime.getManifest().version, containers, workspaces };
    if (!LocalBackupData.read(archive) || new TextEncoder().encode(JSON.stringify(archive)).length > LocalBackupData.MAX_BYTES) {
      throw new Error("Backup data is incomplete or exceeds 8 MiB");
    }
    return archive;
  }

  static async _write(settings, archive, emergency = false) {
    const reply = await this._native(settings, { operation: "backup", archive, limit: settings.limit || 50, emergency });
    if (typeof reply.filename !== "string" || !Number.isFinite(reply.savedAt)) throw new Error("Backup helper did not confirm the saved file");
    const status = { ok: true, directory: reply.directory, filename: reply.filename, savedAt: reply.savedAt,
      checkedAt: Date.now(), unchanged: Boolean(reply.unchanged), error: null, warning: reply.retentionWarning || null };
    await browser.storage.local.set({ [this.STATUS_KEY]: status });
    return status;
  }

  static async run({ manual = false } = {}) {
    return this._mutex.run("operation", async () => {
      try {
        const settings = await this._connectDefault({ connectPaused: manual });
        if (!settings || (!settings.enabled && !manual)) return { ok: false, disabled: true };
        return await this._write(settings, await this.capture(settings.profileId));
      } catch (e) {
        const previous = (await browser.storage.local.get(this.STATUS_KEY))[this.STATUS_KEY] || {};
        const result = { ...previous, ok: false, error: e.message, checkedAt: Date.now() };
        await browser.storage.local.set({ [this.STATUS_KEY]: result });
        return result;
      }
    }).catch(e => ({ ok: false, error: e.message }));
  }

  // Emergency preservation reads the last complete snapshots, never live
  // placeholder tabs. A missing helper must retain the original records.
  static async exportSnapshots(workspaces) {
    return this._mutex.run("operation", async () => {
      const settings = await this._connectDefault();
      if (!settings?.enabled) throw new Error("Connect the JSON backup folder before giving up recovery");
      const rows = workspaces.map(w => {
        const snapshot = RecoveryData.fromWorkspace(w);
        if (!snapshot.complete) throw new Error("A complete recovery snapshot is unavailable; old workspaces were kept");
        return { sourceId: w.id, name: w.name, icon: w.icon || "", color: w.color || null,
          containerId: w.containerId || null, active: Boolean(w.active),
          snapshot: { version: 1, savedAt: snapshot.savedAt, tabs: snapshot.tabs, groups: snapshot.groups } };
      });
      const archive = await this._archive(settings.profileId, rows);
      const result = await this._write(settings, archive, true);
      return { folders: result.unchanged ? 0 : rows.length,
        urls: result.unchanged ? 0 : rows.reduce((n, w) => n + w.snapshot.tabs.length, 0),
        deduped: result.unchanged, complete: true };
    });
  }

  static async list() {
    const settings = await this._mutex.run("operation", () => this._connectDefault({ connectPaused: true }));
    if (!LocalBackupData.connection(settings)) return [];
    const reply = await this._native(settings, { operation: "list" });
    if (!Array.isArray(reply.files) || reply.files.length > 200) throw new Error("Invalid backup history response");
    return reply.files;
  }

  static async read(filename) {
    const settings = await this._mutex.run("operation", () => this._connectDefault({ connectPaused: true }));
    if (!settings) throw new Error("Connect the JSON backup folder first");
    let text = "", offset = 0;
    for (;;) {
      const reply = await this._native(settings, { operation: "read", filename, offset });
      if (typeof reply.text !== "string" || reply.text.length > 65536
          || reply.nextOffset !== offset + reply.text.length || (!reply.done && !reply.text.length)) throw new Error("Invalid backup file response");
      text += reply.text;
      offset = reply.nextOffset;
      if (offset > LocalBackupData.MAX_BYTES) throw new Error("Backup exceeds 8 MiB");
      if (reply.done) break;
    }
    const archive = JSON.parse(text);
    if (!LocalBackupData.read(archive) || archive.profileId !== settings.profileId) throw new Error("Invalid backup file or profile");
    return archive;
  }

  static async _preflight(archive, workspaces, windowId) {
    if (!LocalBackupData.read(archive)) throw new Error("Invalid JSON backup");
    if (Brainer._state !== "ready") throw new Error("Wait until session recovery has finished before restoring");
    if (windowId !== await WSPStorageManager.getPrimaryWindowId()) throw new Error("Restore in the primary workspace window");
    const win = await browser.windows.get(windowId);
    if (win.incognito) throw new Error("Private windows cannot restore these backups");
    const containers = new Map(archive.containers.map(c => [c.cookieStoreId, c]));
    const needed = new Set();
    let count = 0;
    for (const w of workspaces) {
      if (w.containerId) needed.add(w.containerId);
      for (const row of w.snapshot.tabs) {
        if (!LocalBackupData.restorableUrl(row.url)) throw new Error("This selection contains a protected URL that Firefox cannot reopen. Select individual web tabs instead.");
        if (row.cookieStoreId !== "firefox-default") needed.add(row.cookieStoreId);
        count++;
      }
    }
    if (count > 1000) throw new Error("Restore at most 1000 tabs at once; select individual workspaces");
    for (const id of needed) {
      let live;
      try { live = await browser.contextualIdentities.get(id); } catch { /* handled below */ }
      const saved = containers.get(id);
      if (!live || !saved || ["name", "color", "icon"].some(key => live[key] !== saved[key])) {
        throw new Error(`Original container ${id} is missing or has changed. No tabs were opened.`);
      }
    }
  }

  static async restore(archive, index, windowId) {
    if (!LocalBackupData.read(archive) || !Number.isInteger(index) || !archive.workspaces[index]) throw new Error("Invalid workspace selection");
    const wsp = archive.workspaces[index];
    await this._preflight(archive, [wsp], windowId);
    return this._reportRestore(await WorkspaceRestoreService.restore(LocalBackupData.rows(wsp), windowId));
  }

  static async _reportRestore(result) {
    if (result.complete === false && !await WSPStorageManager.getLastRestoreError()) {
      await WSPStorageManager.setLastRestoreError({ reason: "manual-restore-incomplete", when: Date.now() });
      await UIService.refreshWarnBadge();
    }
    return result;
  }

  static async restoreAll(archive, windowId) {
    if (!LocalBackupData.read(archive)) throw new Error("Invalid JSON backup");
    await this._preflight(archive, archive.workspaces, windowId);
    const results = [];
    for (const wsp of archive.workspaces) {
      try { results.push(await WorkspaceRestoreService.restore(LocalBackupData.rows(wsp), windowId)); }
      catch (e) { return this._reportRestore({ results, error: e.message, complete: false }); }
    }
    return this._reportRestore({ results, complete: results.every(r => r.complete !== false && r.tabCount === r.requested) });
  }

  static async restoreTab(archive, workspaceIndex, tabIndex, windowId) {
    if (!LocalBackupData.read(archive) || !Number.isInteger(workspaceIndex) || !Number.isInteger(tabIndex)) throw new Error("Invalid tab selection");
    const source = archive.workspaces[workspaceIndex];
    const row = source?.snapshot.tabs[tabIndex];
    if (!row) throw new Error("Tab not found in this backup");
    await this._preflight(archive, [{ ...source, containerId: null,
      snapshot: { ...source.snapshot, tabs: [row] } }], windowId);
    const result = await WorkspaceService._onActivationChain(() => TabService.withReopenGuard(async () => {
      const target = await WorkspaceService.getActiveWsp(windowId);
      if (!target || (target.containerId && target.containerId !== row.cookieStoreId)) {
        throw new Error("The active workspace uses a different container. Switch to an unbound workspace before restoring this tab.");
      }
      const group = source.snapshot.groups.find(g => g.key === row.groupKey);
      const groupKey = group ? crypto.randomUUID() : null;
      const tab = await browser.tabs.create({ windowId, url: LocalBackupData.restoreUrl(row.url), cookieStoreId: row.cookieStoreId, active: false });
      let error = null;
      try {
        await TabService.setTabSessionValue(tab.id, target.id, { strict: true });
        if (groupKey) await TabService.setGroupTag(tab.id, groupKey, { strict: true });
      } catch {
        error = "The tab was opened, but its recovery metadata could not be saved. Review it before retrying.";
      }
      const saved = await WSPStorageManager.mutateWorkspace(target.id, fresh => {
        if (!fresh.tabs.includes(tab.id)) fresh.tabs.push(tab.id);
        if (groupKey) fresh.groups.push({ ...group, key: groupKey, tabs: [] });
      });
      if (!saved) throw new Error("The tab was opened, but its destination workspace was removed");
      if (!await saved._rebuildGroups()) error ||= "The tab was opened, but its group could not be restored. Review it before retrying.";
      WorkspaceService._updateActiveCache(windowId, saved.tabs, saved.id, saved.containerId);
      SnapshotService.schedule(windowId, target.id);
      await browser.tabs.update(tab.id, { active: true });
      return { tabId: tab.id, wspId: target.id, tabCount: 1, complete: !error, error };
    }));
    return this._reportRestore(result);
  }
}
