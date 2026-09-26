// tests/write-discipline.test.mjs
// Workspace record write discipline (X-65, X-12, X-33, X-79). Every change
// to an existing ld-wsp-{id} record must be a locked fresh read-modify-write
// (WSPStorageManager.mutateWorkspace) that skips a destroyed workspace:
//  - an unlocked full-record save from a copy read before an await reverts
//    whatever a locked writer landed in between (X-12, X-65);
//  - a writer without the existence check writes a destroyed workspace back
//    as a zombie record (X-33).
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";
import { makeWorld, seedWorkspaces, wspRecord, WSP_A, WSP_B, WSP_C } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

const key = (id) => `ld-wsp-${id}`;
const sorted = (list) => [...list].sort((a, b) => a - b);
const RECORD_KEY_RE = /^ld-wsp-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

test("mutateWorkspace: saves the fresh record, `false` skips the save, a missing record is never recreated", async () => {
  const { get, settle, storageData, browser } = loadBackend({
    storageData: { ...wspRecord(WSP_A, { name: "A", tabs: [1] }) },
  });
  await settle();
  const S = get("WSPStorageManager");

  const saved = await S.mutateWorkspace(WSP_A, (w) => { w.tabs.push(2); });
  assert.deepEqual(storageData[key(WSP_A)].tabs, [1, 2]);
  assert.deepEqual([...saved.tabs], [1, 2], "resolves to the saved record");

  const sets = [];
  const origSet = browser.storage.local.set;
  browser.storage.local.set = async (obj) => { sets.push(Object.keys(obj)); return origSet(obj); };
  const kept = await S.mutateWorkspace(WSP_A, () => false);
  assert.ok(kept, "an existing record resolves even when the save is skipped");
  assert.deepEqual(sets, [], "returning false writes nothing");

  const missing = await S.mutateWorkspace(WSP_B, (w) => { w.tabs.push(9); });
  assert.equal(missing, null);
  assert.ok(!(key(WSP_B) in storageData), "no zombie record for a missing workspace");
});

// Storage seed wrapped so every write of a workspace record checks that
// the writer holds that workspace's lock.
function lockCheckedStorage(seed, violations) {
  let world = null;
  let mutex = null;
  const storage = new Proxy(seed, {
    set(target, k, value) {
      const m = RECORD_KEY_RE.exec(k);
      if (m && world?.env) {
        mutex ??= world.env.get("_storageMutex");
        if (!mutex._locks.has(`wsp-${m[1]}`)) {
          violations.push(`unlocked write of ${k}\n${new Error().stack}`);
        }
      }
      target[k] = value;
      return true;
    },
  });
  return { storage, attach: (w) => { world = w; } };
}

test("every workspace record write holds that workspace's lock (restore, activation, repair, bookmark restore, edits)", async (t) => {
  const violations = [];
  // Restart: the workspaces were stored under old window 7; window 1 comes
  // back with the session-tagged tabs. C is empty and bound to a deleted
  // container, so activating it runs the fallback-tab container clear.
  const seed = seedWorkspaces(7, [
    { id: WSP_A, name: "A", active: true, tabs: [51, 52], tabSnapshot: ["https://a.test/1", "https://a.test/2"] },
    { id: WSP_B, name: "B", tabs: [53], tabSnapshot: ["https://b.test/1"] },
    { id: WSP_C, name: "C", tabs: [], containerId: "firefox-container-9" },
  ]);
  delete seed["primary-window-id"];
  seed["primary-window-last-id"] = 7;
  const { storage, attach } = lockCheckedStorage(seed, violations);
  const world = makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 2, url: "https://a.test/2" },
      { id: 3, url: "https://b.test/1" },
    ],
    sessionValues: { 1: WSP_A, 2: WSP_A, 3: WSP_B },
    containers: [{ cookieStoreId: "firefox-container-1", name: "Work" }],
    storage,
    sessionAlive: false,
    autoEvents: false,
  });
  attach(world);
  world.overrides.bookmarks = {
    search: async () => [{ id: "parent", type: "folder", parentId: "unfiled_____", title: "Workspaces" }],
    get: async (id) => [{ id, type: "folder", parentId: "parent", title: "Saved" }],
    getChildren: async (id) => (id === "saved"
      ? [{ url: "https://saved.test/1", title: "s1" }, { url: "https://saved.test/2", title: "s2" }]
      : []),
  };
  const env = await world.boot({ settleMs: 700 });
  t.after(() => world.teardown());
  const Brainer = env.get("Brainer");
  const WorkspaceService = env.get("WorkspaceService");
  const TabService = env.get("TabService");
  assert.equal(Brainer._state, "ready", "restart restore completed");
  assert.equal(world.record(WSP_A).windowId, 1);

  // Switch to the empty, container-bound workspace (fallback tab path).
  await WorkspaceService.activateWsp(WSP_C, 1);
  assert.equal(world.record(WSP_C).containerId, null, "stale container cleared");

  // Corrupt the stored arrays the way an undetected restart does, then repair.
  const a = world.storage[key(WSP_A)];
  a.tabs.push(999, 3);
  world.storage[key(WSP_B)].tabs = [];
  await Brainer._repairTabAssignments(1, true);
  assert.deepEqual(world.record(WSP_B).tabs, [3], "repair re-filed tab 3 under B");

  await env.get("BookmarkService").restoreWorkspace("saved", 1);
  await WorkspaceService.renameWorkspace(WSP_B, { name: "B2" });
  await WorkspaceService.setWorkspaceContainer(WSP_A, "firefox-container-1");
  const extra = world.openTab({ url: "https://late.test/", active: false });
  await TabService.addTabToWorkspace(extra);
  world.closeTab(extra.id);
  await TabService.removeTabFromWorkspace(1, extra.id);

  assert.deepEqual(violations, [], violations.join("\n\n"));
});

test("a locked write that lands during an activation survives it (rename, late tab filed, tab closed)", async (t) => {
  const world = makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 2, url: "https://a.test/2" },
      { id: 3, url: "https://b.test/1", hidden: true },
      { id: 5, url: "https://b.test/2", hidden: true },
    ],
    sessionValues: { 1: WSP_A, 2: WSP_A, 3: WSP_B, 5: WSP_B },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1, 2] },
      { id: WSP_B, name: "B", tabs: [3, 5] },
    ]),
    autoEvents: false,
  });
  const env = await world.boot();
  t.after(() => world.teardown());
  const Brainer = env.get("Brainer");
  const TabService = env.get("TabService");
  const tabs = env.browser.tabs;

  // Right after the activation has shown B's tabs (no lock held), three
  // locked writers run to completion: a rename, a tab close, and a late
  // session-restored tab that _reconcileLateTabs files into B.
  let late = null;
  let fired = false;
  const realShow = tabs.show;
  tabs.show = async (ids) => {
    const result = await realShow(ids);
    if (!fired) {
      fired = true;
      await env.get("Workspace").rename(WSP_B, { name: "Renamed" });
      world.closeTab(5);
      await TabService.removeTabFromWorkspace(1, 5);
      late = world.openTab({ url: "https://b.test/late", active: false });
      await env.browser.sessions.setTabValue(late.id, "wspId", WSP_B);
      await Brainer._reconcileLateTabs(1);
    }
    return result;
  };

  await env.get("WorkspaceService").activateWsp(WSP_B, 1);
  const b = world.record(WSP_B);
  assert.equal(b.active, true);
  assert.equal(b.name, "Renamed", "rename kept");
  assert.deepEqual(sorted(b.tabs), [3, late.id], "late tab kept, closed tab 5 not resurrected");
  assert.equal(world.tab(late.id).hidden, false, "the tab filed during the activation is shown");
  assert.deepEqual(sorted(world.hidden(1)), [1, 2], "A's tabs hidden");
  assert.ok(env.get("WorkspaceService").isTabInActiveWsp(1, late.id), "active cache includes the late tab");
});

test("the fallback-tab container clear writes only containerId (a rename during it survives)", async (t) => {
  const world = makeWorld({
    tabs: [{ id: 1, url: "https://a.test/1", active: true }],
    sessionValues: { 1: WSP_A },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1] },
      { id: WSP_C, name: "C", tabs: [], containerId: "firefox-container-9" },
    ]),
    autoEvents: false,
  });
  const env = await world.boot();
  t.after(() => world.teardown());
  // The container lookup is the await during which the rename lands.
  const realGet = env.browser.contextualIdentities.get;
  env.browser.contextualIdentities.get = async (id) => {
    await env.get("Workspace").rename(WSP_C, { name: "Renamed" });
    return realGet(id);
  };
  await env.get("WorkspaceService").activateWsp(WSP_C, 1);
  const c = world.record(WSP_C);
  assert.equal(c.name, "Renamed");
  assert.equal(c.containerId, null);
  assert.equal(c.active, true);
  assert.equal(c.tabs.length, 1, "fallback tab filed");
});

test("the repair waits for an in-flight snapshot refresh instead of being overwritten by it", async () => {
  const liveTabs = [
    { id: 10, windowId: 1, url: "https://a1/", pinned: false },
    { id: 20, windowId: 1, url: "https://b1-navigated/", pinned: false },
  ];
  const sv = new Map([[10, WSP_A], [20, WSP_B]]);
  let slow = false;
  const storageData = {
    "primary-window-id": 1,
    "ld-wsp-window-1": [WSP_A, WSP_B],
    ...wspRecord(WSP_A, { name: "A", tabs: [10], active: true, tabSnapshot: ["https://a1/"] }),
    ...wspRecord(WSP_B, { name: "B", tabs: [20], tabSnapshot: ["https://b1/"] }),
  };
  const env = loadBackend({
    storageData, overrides: {
      tabs: {
        query: async (q = {}) => {
          if (slow) await new Promise(r => setTimeout(r, 30));
          return liveTabs.filter(x => (q.windowId == null || x.windowId === q.windowId)
            && (q.pinned == null || x.pinned === q.pinned));
        },
        get: async (id) => {
          const x = liveTabs.find(y => y.id === id);
          if (!x) throw new Error("No tab");
          return x;
        },
      },
      sessions: {
        getTabValue: async (id) => sv.get(id),
        setTabValue: async (id, k, v) => { sv.set(id, v); },
        getRecentlyClosed: async () => [],
      },
    },
  });
  await env.settle(100);
  const TabService = env.get("TabService");
  TabService._SNAPSHOT_DEBOUNCE_MS = 0;
  // Tab 20 really belongs to A (the repair must move it), while a snapshot
  // refresh for B holds B's lock and awaits a slow tab query.
  sv.set(20, WSP_A);
  slow = true;
  TabService._scheduleSnapshotRefresh(1, WSP_B);
  await new Promise(r => setTimeout(r, 5));
  slow = false;
  assert.equal(await env.get("Brainer")._reconcileFromSessionValues(1, true), true);
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(sorted(storageData[key(WSP_A)].tabs), [10, 20]);
  assert.deepEqual(storageData[key(WSP_B)].tabs, [], "tab 20 is filed under A only");
});

test("a repair holds back pending snapshot refreshes and re-arms them afterwards", async (t) => {
  const world = makeWorld({
    tabs: [{ id: 1, url: "https://a.test/1", active: true }, { id: 3, url: "https://b.test/1", hidden: true }],
    sessionValues: { 1: WSP_A, 3: WSP_B },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1] },
      { id: WSP_B, name: "B", tabs: [3] },
    ]),
    autoEvents: false,
  });
  const env = await world.boot();
  t.after(() => world.teardown());
  const Brainer = env.get("Brainer");
  const TabService = env.get("TabService");
  TabService._scheduleSnapshotRefresh(1, WSP_B);
  let pendingDuringCheck = null;
  const realDetect = Brainer._detectSessionLoss;
  Brainer._detectSessionLoss = async (windowId) => {
    pendingDuringCheck = TabService._snapshotTimers.size;
    return realDetect.call(Brainer, windowId);
  };
  await Brainer._repairTabAssignments(1, true);
  assert.equal(pendingDuringCheck, 0, "no refresh can fire while the repair reads the snapshots");
  assert.ok(TabService._snapshotTimers.has(`1:${WSP_B}`), "re-armed after the repair");
});

test("a tab close queued behind a destroy does not write the destroyed record back", async () => {
  const { get, settle, storageData } = loadBackend({
    storageData: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1] },
      { id: WSP_B, name: "B", tabs: [3] },
    ]),
  });
  await settle();
  // Boot's stale-id cleanup emptied the arrays (this stub has no live tabs).
  storageData[key(WSP_B)].tabs = [3];
  const S = get("WSPStorageManager");
  const TabService = get("TabService");
  let pending;
  // Hold B's lock the way destroyWsp does: the close reads the window list
  // (B still listed), then queues on the lock while B is deleted.
  await S.withWorkspaceLock(WSP_B, async () => {
    pending = TabService.removeTabFromWorkspace(1, 3);
    await settle(5);
    await S.removeWsp(WSP_B, 1);
    await S.deleteWspState(WSP_B);
  });
  await pending;
  assert.ok(!(key(WSP_B) in storageData), "no zombie ld-wsp record");
});

test("rename or container change of a deleted workspace is refused with a user-facing error, no zombie", async () => {
  const { get, settle, storageData, browser } = loadBackend({
    storageData: seedWorkspaces(1, [{ id: WSP_A, name: "A", active: true, tabs: [] }]),
  });
  await settle();
  assert.equal(get("Brainer")._state, "ready");
  const send = (message) => browser.runtime.onMessage._listeners[0](message, {});

  const renamed = await send({ action: "renameWorkspace", wspId: WSP_B, wspName: "x" });
  assert.equal(renamed._error, true);
  assert.equal(renamed._userFacing, true);
  assert.match(renamed.message, /^Workspace not found/);

  const bound = await send({ action: "setWorkspaceContainer", wspId: WSP_B, containerId: "firefox-container-1" });
  assert.equal(bound._userFacing, true);
  assert.match(bound.message, /^Workspace not found/);
  assert.ok(!(key(WSP_B) in storageData), "no zombie ld-wsp record");

  const ok = await send({ action: "renameWorkspace", wspId: WSP_A, wspName: "A2" });
  assert.deepEqual({ ...ok }, { success: true });
  assert.equal(storageData[key(WSP_A)].name, "A2");
});

test("a zombie record (no windowId) does not keep a session tag alive on first start", async (t) => {
  const world = makeWorld({
    tabs: [{ id: 1, url: "https://a.test/1", active: true }],
    sessionValues: { 1: WSP_C },
    storage: { [key(WSP_C)]: { id: WSP_C, name: "x", tabs: [] } },
  });
  const env = await world.boot();
  t.after(() => world.teardown());
  const ids = world.storage["ld-wsp-window-1"];
  assert.equal(ids.length, 1, "default workspace created");
  assert.equal(world.tabValue(1), ids[0], "tab re-tagged to the default workspace");
  assert.equal(env.get("Brainer")._state, "ready");
});

test("a settled tab click that changes nothing does not rewrite the record, and reads only the active one", async (t) => {
  const world = makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 2, url: "https://a.test/2" },
      { id: 3, url: "https://b.test/1", hidden: true },
    ],
    sessionValues: { 1: WSP_A, 2: WSP_A, 3: WSP_B },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1, 2], lastActiveTabId: 1, lastActiveTabUrl: "https://a.test/1" },
      { id: WSP_B, name: "B", tabs: [3] },
    ]),
    autoEvents: false,
  });
  const env = await world.boot();
  t.after(() => world.teardown());
  const WorkspaceService = env.get("WorkspaceService");
  WorkspaceService._updateActiveCache(1, [1, 2], WSP_A, null);
  const local = env.browser.storage.local;
  const reads = [];
  const writes = [];
  const realGet = local.get;
  const realSet = local.set;
  local.get = async (keys) => { reads.push(...[].concat(keys)); return realGet(keys); };
  local.set = async (obj) => { writes.push(...Object.keys(obj)); return realSet(obj); };

  WorkspaceService.updateLastActiveTab(1, 1);
  await world.idle(); // the eager tabs.get for the URL
  await WorkspaceService.flushLastActiveTab();
  assert.deepEqual(writes, [], "same tab, same URL: no write");
  assert.ok(!reads.includes("ld-wsp-window-1") && !reads.includes(key(WSP_B)),
    `warm cache: only the active record is read, got ${JSON.stringify(reads)}`);

  WorkspaceService.updateLastActiveTab(1, 2);
  await world.idle();
  await WorkspaceService.flushLastActiveTab();
  assert.deepEqual(writes, [key(WSP_A)]);
  assert.equal(world.record(WSP_A).lastActiveTabId, 2);
  assert.equal(world.record(WSP_A).lastActiveTabUrl, "https://a.test/2");
});
