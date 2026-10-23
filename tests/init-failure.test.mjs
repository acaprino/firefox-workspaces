// tests/init-failure.test.mjs
// Brainer.initialize() failures and the lifecycle around them:
//  - a failed pass never leaves the extension inert for the session: the
//    state goes 'uninitialized', an "init-failure" banner says so, a retry
//    runs, and a failure after a committed restore keeps it ready (X-06);
//  - the stale-primary path arms the retry signal before it drops the
//    primary claim (X-67);
//  - onInstalled does not force 'ready' over a refused restore (X-68);
//  - an AMO update waits for a container migration and reloads once (X-99).
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B } from "./helpers/world.mjs";
import { makeStorageArea } from "./helpers/load-backend.mjs";

process.on("unhandledRejection", () => {});

const ERROR_KEY = "ld-wsp-last-restore-error";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(world, t) {
  const env = await world.boot();
  t.after(() => world.teardown());
  const send = (message) => env.browser.runtime.onMessage._listeners[0](message, {});
  return { env, send, B: env.get("Brainer") };
}

async function waitFor(pred, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
  return true;
}

// Primary window 1: A active (tabs 1, 2), B inactive (hidden 3). The first
// tabs.query({active: true}) -- the repair's _enforceActiveWorkspace --
// fails the way a tab closed by startup churn makes Firefox fail.
function failingRepairWorld() {
  const world = makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 2, url: "https://a.test/2" },
      { id: 3, url: "https://b.test/3", hidden: true },
    ],
    sessionValues: { 1: WSP_A, 2: WSP_A, 3: WSP_B },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1, 2], tabSnapshot: ["https://a.test/1", "https://a.test/2"] },
      { id: WSP_B, name: "B", tabs: [3], tabSnapshot: ["https://b.test/3"] },
    ]),
  });
  const realQuery = world.overrides.tabs.query;
  let failures = 1;
  world.overrides.tabs.query = async (q = {}) => {
    if (q.active === true && failures > 0) {
      failures--;
      throw new Error("Invalid tab ID: 2");
    }
    return realQuery(q);
  };
  return world;
}

test("X-06: a start with no normal window open is not stuck; the first window opened becomes primary", async (t) => {
  // macOS: Firefox running without windows when the extension is installed
  const world = makeWorld({ windows: [], tabs: [], storage: {} });
  const { B } = await boot(world, t);
  assert.equal(B._state, "ready", "used to stay 'initializing' for the session (getCurrent threw)");
  assert.equal(world.storage["primary-window-id"], undefined);
  assert.equal(world.storage[ERROR_KEY], undefined, "no window is not an error");

  const win = world.openWindow({ url: "https://first.test/" });
  await world.idle();
  assert.equal(world.storage["primary-window-id"], win.id);
  const ids = world.storage[`ld-wsp-window-${win.id}`];
  assert.equal(ids?.length, 1, "exactly one default workspace");
  const wsp = world.record(ids[0]);
  assert.equal(wsp.active, true);
  assert.deepEqual(wsp.tabs, [win.tabs[0].id], "its tab is filed");
  assert.equal(world.tabValue(win.tabs[0].id), wsp.id);
});

test("X-06: a failed repair surfaces an init-failure banner, refuses honestly and recovers on the retry", async (t) => {
  const world = failingRepairWorld();
  const { B, send } = await boot(world, t);

  assert.equal(B._state, "uninitialized", "used to stay 'initializing' with no banner");
  assert.equal(world.storage[ERROR_KEY]?.reason, "init-failure");
  assert.match(world.storage[ERROR_KEY].error, /Invalid tab ID/);
  const refusal = await send({ action: "activateWorkspace", wspId: WSP_B, windowId: 1 });
  assert.equal(refusal._userFacing, true);
  assert.match(refusal.message, /could not start/, "not the misleading 'still starting up'");

  assert.ok(await waitFor(() => B._state === "ready"), "the scheduled retry brings it up");
  await world.idle();
  assert.equal(world.storage[ERROR_KEY], undefined, "banner cleared once the retry got through");
  assert.equal(B._initFailure, null);
  assert.deepEqual(world.visible(1).sort(), [1, 2]);
  assert.deepEqual(world.hidden(1), [3]);

  // Tracking works again: a new tab joins the workspace on screen
  const tab = world.openTab({ url: "https://a.test/new" });
  await world.idle();
  assert.ok(world.record(WSP_A).tabs.includes(tab.id));
});

test("X-06/X-34: Dismiss on the init-failure banner retries the start at once", async (t) => {
  const world = failingRepairWorld();
  const { B, send } = await boot(world, t);
  const { when } = world.storage[ERROR_KEY];

  const reply = await send({ action: "acknowledgeLastRestoreError", when });
  assert.equal(reply.success, true);
  assert.equal(reply.resumed, true);
  assert.equal(B._state, "ready");
  assert.equal(world.storage[ERROR_KEY], undefined);
  assert.equal(B._initRetryTimer, null, "the scheduled retry is dropped");
});

test("X-06: a failure after the restore committed keeps the extension ready", async (t) => {
  // Detected restart: lastId armed, tags intact
  const storage = seedWorkspaces(1, [
    { id: WSP_A, name: "A", active: true, tabs: [51], tabSnapshot: ["https://a.test/1"] },
    { id: WSP_B, name: "B", tabs: [53], tabSnapshot: ["https://b.test/3"] },
  ]);
  delete storage["primary-window-id"];
  storage["primary-window-last-id"] = 1;
  const world = makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 3, url: "https://b.test/3", hidden: true },
    ],
    sessionValues: { 1: WSP_A, 3: WSP_B },
    storage,
    sessionAlive: false,
  });
  const realQuery = world.overrides.tabs.query;
  let failures = 1;
  world.overrides.tabs.query = async (q = {}) => {
    // _reconcileLateTabs' read, once the restore claimed the window
    if (q.pinned === false && world.storage["primary-window-id"] != null && failures > 0) {
      failures--;
      throw new Error("simulated post-commit failure");
    }
    return realQuery(q);
  };
  const { B } = await boot(world, t);

  assert.equal(failures, 0, "the failure was injected");
  assert.equal(B._state, "ready", "used to reset to 'uninitialized' with the primary already claimed");
  assert.equal(world.storage["primary-window-id"], 1);
  assert.equal(world.storage["primary-window-last-id"], undefined);
  assert.deepEqual(world.record(WSP_A).tabs, [1]);
  assert.deepEqual(world.record(WSP_B).tabs, [3]);
  assert.equal(world.storage[ERROR_KEY], undefined);
});

test("X-67: the stale-primary path arms the retry signal before it drops the primary claim", async (t) => {
  // Crash leftover: primary 7 is gone; the workspaces' tabs are in window 1
  const world = makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 3, url: "https://b.test/3", hidden: true },
    ],
    sessionValues: { 1: WSP_A, 3: WSP_B },
    storage: seedWorkspaces(7, [
      { id: WSP_A, name: "A", active: true, tabs: [91], tabSnapshot: ["https://a.test/1"] },
      { id: WSP_B, name: "B", tabs: [93], tabSnapshot: ["https://b.test/3"] },
    ]),
    sessionAlive: false,
  });
  const area = makeStorageArea(world.storage);
  const writes = [];
  const note = (op, keys) => {
    for (const k of keys) if (k.startsWith("primary-window")) writes.push(`${op} ${k}`);
  };
  world.overrides.storage.local = {
    ...area,
    set: async (obj) => { note("set", Object.keys(obj)); return area.set(obj); },
    remove: async (keys) => { note("remove", [].concat(keys)); return area.remove(keys); },
  };
  const { B } = await boot(world, t);

  assert.deepEqual(writes.slice(0, 2), ["set primary-window-last-id", "remove primary-window-id"],
    "a crash between the two writes must leave both keys set, never neither");
  assert.equal(B._state, "ready");
  assert.equal(world.storage["primary-window-id"], 1, "then restored into the live window");
  assert.deepEqual(world.record(WSP_A).tabs, [1]);
  assert.deepEqual(world.record(WSP_B).tabs, [3]);
});

test("X-68: onInstalled after a refused restore leaves the state alone", async (t) => {
  // Detected restart into a window that only shows the homepage: the
  // restore is refused (refuse-to-wipe) and waits for the user.
  const storage = seedWorkspaces(1, [
    { id: WSP_A, name: "A", active: true, tabs: [51, 52], tabSnapshot: ["https://a.test/1", "https://a.test/2"] },
    { id: WSP_B, name: "B", tabs: [53], tabSnapshot: ["https://b.test/3"] },
  ]);
  delete storage["primary-window-id"];
  storage["primary-window-last-id"] = 1;
  const world = makeWorld({ tabs: [{ id: 1, url: "about:home", active: true }], storage, sessionAlive: false });
  const { env, B, send } = await boot(world, t);
  assert.equal(world.storage[ERROR_KEY]?.reason, "refuse-to-wipe");
  assert.equal(B._state, "uninitialized");

  await env.browser.runtime.onInstalled._listeners[0]({ reason: "update" });
  assert.equal(B._state, "uninitialized", "used to be forced to 'ready' with no primary window");
  const refusal = await send({ action: "createWorkspace", windowId: 1, name: "X" });
  assert.equal(refusal._error, true, "the handler's gate stays closed");
  assert.equal(world.storage["ld-wsp-window-1"].length, 2);
  assert.equal(world.storage["primary-window-last-id"], 1);
});

test("X-99: an AMO update waits for a container migration, and reloads once", async (t) => {
  const world = makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 2, url: "https://a.test/2" },
    ],
    sessionValues: { 1: WSP_A, 2: WSP_A },
    containers: [{ cookieStoreId: "firefox-container-1", name: "Work", color: "blue", icon: "briefcase" }],
    storage: seedWorkspaces(1, [{ id: WSP_A, name: "A", active: true, tabs: [1, 2] }]),
  });
  const reloads = [];
  const updateListeners = [];
  world.overrides.runtime = {
    reload: () => { reloads.push(Date.now()); },
    onUpdateAvailable: { addListener: (fn) => updateListeners.push(fn) },
  };
  // Hold the migration at its first step (reading the tabs it will reopen),
  // before any reopen guard is taken.
  let release;
  const gate = new Promise((r) => { release = r; });
  let gated = false;
  const realGet = world.overrides.tabs.get;
  world.overrides.tabs.get = async (id) => { if (gated) await gate; return realGet(id); };
  const { env } = await boot(world, t);

  gated = true;
  const migration = env.get("WorkspaceService").setWorkspaceContainer(WSP_A, "firefox-container-1");
  await sleep(5);
  assert.equal(updateListeners.length, 1);
  updateListeners[0]({ version: "9.9.9" });
  updateListeners[0]({ version: "9.9.9" }); // Firefox may repeat it
  await sleep(50);
  assert.equal(reloads.length, 0, "not while the migration runs");

  gated = false;
  release();
  await migration;
  await world.idle();
  assert.ok(await waitFor(() => reloads.length > 0, { timeoutMs: 2000 }));
  await sleep(600);
  assert.equal(reloads.length, 1, "one reload for the pending update");
  const a = world.record(WSP_A);
  assert.equal(a.tabs.length, 2);
  for (const id of a.tabs) assert.equal(world.tab(id).cookieStoreId, "firefox-container-1");
});
