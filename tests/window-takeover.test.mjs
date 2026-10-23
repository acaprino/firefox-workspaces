// tests/window-takeover.test.mjs
// Which window takes the workspaces over while they wait for theirs:
//  - closing the primary window while another stays open is not a browser
//    restart: a new window is claimed only when it holds the workspaces'
//    tabs, or adopts them when nothing waits in the closed window; no false
//    refuse-to-wipe, "not fully restored" warning or bookmark export (X-11);
//  - only normal windows become primary or restore targets (X-118);
//  - a take-over runs the same tail as initialize(): late tabs filed,
//    toolbar repainted (X-35).
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B } from "./helpers/world.mjs";
import { makeStorageArea } from "./helpers/load-backend.mjs";

process.on("unhandledRejection", () => {});

const ERROR_KEY = "ld-wsp-last-restore-error";
const sorted = (list) => [...list].sort((a, b) => a - b);

function recordBookmarks(world) {
  const created = [];
  world.overrides.bookmarks = {
    create: async (b) => { created.push(b); return { id: "bm-" + created.length, type: b.url ? "bookmark" : "folder", ...b }; },
  };
  return created;
}

async function boot(world, t) {
  const env = await world.boot();
  t.after(() => world.teardown());
  const send = (message) => env.browser.runtime.onMessage._listeners[0](message, {});
  return { env, send, B: env.get("Brainer") };
}

// Window 1 (primary): A active with its only tab 1; B owns hidden tabs 3, 4.
// Window 2: an unrelated window that stays open.
function closableWorld() {
  const world = makeWorld({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 3, url: "https://b.test/3", hidden: true },
      { id: 4, url: "https://b.test/4", hidden: true },
      { id: 10, windowId: 2, url: "https://other.test/", active: true },
    ],
    sessionValues: { 1: WSP_A, 3: WSP_B, 4: WSP_B },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1], tabSnapshot: ["https://a.test/1"] },
      { id: WSP_B, name: "B", tabs: [3, 4], tabSnapshot: ["https://b.test/3", "https://b.test/4"] },
    ]),
  });
  const bookmarks = recordBookmarks(world);
  return { world, bookmarks };
}

// Close window 1 with its last visible tab, then dismiss the banner that
// reports the hidden tabs that went with it.
async function closeAndDismiss(world, send) {
  world.closeTab(1);
  await world.idle();
  const { when, reason } = world.storage[ERROR_KEY];
  assert.equal(reason, "primary-window-closed");
  const reply = await send({ action: "acknowledgeLastRestoreError", when });
  assert.equal(reply.success, true);
  assert.notEqual(reply.resumed, true, "no open window holds the workspaces' tabs");
  assert.equal(world.storage[ERROR_KEY], undefined);
}

test("X-11: after the closed-window banner is dismissed, Ctrl+N does not trip refuse-to-wipe", async (t) => {
  const { world } = closableWorld();
  const { B, send } = await boot(world, t);
  await closeAndDismiss(world, send);

  world.openWindow({ url: "about:newtab" });
  await world.idle();

  assert.equal(world.storage[ERROR_KEY], undefined, "no refuse-to-wipe banner");
  assert.equal(B._refuseToWipeActive, false);
  assert.equal(world.storage["primary-window-id"], undefined);
  assert.equal(world.storage["primary-window-last-id"], 1, "the workspaces still wait for their window");
  assert.deepEqual(world.record(WSP_B).tabs, [3, 4]);
});

test("X-11: a new window with a real first tab is not taken for the closed one; reopening it restores the workspaces", async (t) => {
  const { world, bookmarks } = closableWorld();
  const { B, send } = await boot(world, t);
  await closeAndDismiss(world, send);

  world.openWindow({ url: "https://home.test/" }); // custom homepage, or a link opened in a new window
  await world.idle();

  assert.equal(world.storage["primary-window-id"], undefined, "not claimed");
  assert.deepEqual(world.record(WSP_A).tabs, [1], "membership not emptied into the new window");
  assert.deepEqual(world.record(WSP_B).tabs, [3, 4]);
  assert.equal(world.storage[ERROR_KEY], undefined, "no false 'not fully restored' warning");
  assert.equal(bookmarks.length, 0, "no bookmark export");

  // History > Recently Closed Windows: the workspaces' own window comes back
  const entry = world.closed.find((e) => e.window);
  const restored = world.restoreClosed(entry.window.sessionId).window;
  await world.idle();

  assert.equal(world.storage["primary-window-id"], restored.id);
  assert.equal(B._state, "ready");
  const a = world.record(WSP_A);
  const b = world.record(WSP_B);
  assert.equal(a.active, true);
  assert.equal(a.tabs.length, 1);
  assert.equal(b.tabs.length, 2);
  assert.deepEqual(sorted(world.visible(restored.id)), a.tabs);
  assert.deepEqual(sorted(world.hidden(restored.id)), sorted(b.tabs), "B's tabs come back hidden and managed");
});

for (const [label, url] of [["a blank window", "about:newtab"], ["a window with a real first tab", "https://new.test/"]]) {
  test(`X-11: with nothing waiting in the closed window, ${label} takes the workspaces over quietly`, async (t) => {
    // A's two tabs were on screen; B holds nothing hidden
    const world = makeWorld({
      windows: [{ id: 1, focused: true }, { id: 2 }],
      tabs: [
        { id: 1, url: "https://a.test/1", active: true },
        { id: 2, url: "https://a.test/2" },
        { id: 10, windowId: 2, url: "https://other.test/", active: true },
      ],
      sessionValues: { 1: WSP_A, 2: WSP_A },
      storage: seedWorkspaces(1, [
        { id: WSP_A, name: "A", active: true, tabs: [1, 2], tabSnapshot: ["https://a.test/1", "https://a.test/2"] },
        { id: WSP_B, name: "B", tabs: [], tabSnapshot: [] },
      ]),
    });
    const bookmarks = recordBookmarks(world);
    const { B } = await boot(world, t);

    world.closeWindow(1);
    await world.idle();
    assert.equal(world.storage[ERROR_KEY], undefined, "nothing hidden was lost: no banner");

    const win = world.openWindow({ url });
    await world.idle();

    assert.equal(world.storage["primary-window-id"], win.id, "the workspaces follow the user");
    assert.equal(B._state, "ready");
    assert.equal(world.storage["primary-window-last-id"], undefined);
    assert.equal(world.storage[ERROR_KEY], undefined, "no refuse-to-wipe, no 'not fully restored'");
    assert.equal(bookmarks.length, 0, "no bookmark export");
    const a = world.record(WSP_A);
    assert.equal(a.windowId, win.id);
    assert.equal(a.active, true);
    assert.deepEqual(a.tabs, [win.tabs[0].id]);
    assert.equal(world.tabValue(win.tabs[0].id), WSP_A);
    assert.equal(world.record(WSP_B).windowId, win.id);
    assert.deepEqual(world.storage[`ld-wsp-window-${win.id}`].sort(), [WSP_A, WSP_B].sort());
  });
}

test("X-11: after an extension reload the pending closed-window banner still keeps other windows out", async (t) => {
  // Window 1 closed with B's hidden tabs while window 2 stayed open; the
  // background restarted since (update), so only storage remembers.
  const storage = seedWorkspaces(1, [
    { id: WSP_A, name: "A", active: true, tabs: [1], tabSnapshot: ["https://a.test/1"] },
    { id: WSP_B, name: "B", tabs: [3, 4], tabSnapshot: ["https://b.test/3", "https://b.test/4"] },
  ]);
  delete storage["primary-window-id"];
  storage["primary-window-last-id"] = 1;
  storage[ERROR_KEY] = { when: 1234, reason: "primary-window-closed", windowId: 1, wspCount: 2, hiddenWspCount: 1, hiddenTabCount: 2 };
  const world = makeWorld({
    windows: [{ id: 2 }],
    tabs: [{ id: 10, windowId: 2, url: "https://other.test/", active: true }],
    storage,
    sessionAlive: false,
  });
  const bookmarks = recordBookmarks(world);
  const { B } = await boot(world, t);

  assert.equal(world.storage["primary-window-id"], undefined, "window 2 is not the workspaces' window");
  assert.equal(B._state, "uninitialized");
  assert.equal(world.storage[ERROR_KEY]?.reason, "primary-window-closed", "the banner still offers the window back");
  assert.deepEqual(world.record(WSP_B).tabs, [3, 4]);
  assert.equal(bookmarks.length, 0);
});

// Detected restart into a window that shows only the homepage: the restore
// is refused (refuse-to-wipe) and waits for the user.
function refusedStartWorld({ windows = [{ id: 1 }], tabs = [{ id: 1, url: "about:home", active: true }] } = {}) {
  const storage = seedWorkspaces(1, [
    { id: WSP_A, name: "A", active: true, tabs: [51, 52], tabSnapshot: ["https://a.test/1", "https://a.test/2"] },
    { id: WSP_B, name: "B", tabs: [53], tabSnapshot: ["https://b.test/3"] },
  ]);
  delete storage["primary-window-id"];
  storage["primary-window-last-id"] = 1;
  const world = makeWorld({ windows, tabs, storage, sessionAlive: false });
  const bookmarks = recordBookmarks(world);
  return { world, bookmarks };
}

test("X-118: a pop-out window opened after Dismiss is never claimed", async (t) => {
  const { world } = refusedStartWorld();
  const { send } = await boot(world, t);
  const { when, reason } = world.storage[ERROR_KEY];
  assert.equal(reason, "refuse-to-wipe");
  const reply = await send({ action: "acknowledgeLastRestoreError", when });
  assert.notEqual(reply.resumed, true);
  assert.equal(world.storage[ERROR_KEY], undefined, "the dismissed banner does not come back");

  // A password manager's pop-out (windows.create({type: "popup"}))
  world.openWindow({ type: "popup", url: "moz-extension://pwmgr/popup/index.html#/tabs" });
  await world.idle();

  assert.equal(world.storage["primary-window-id"], undefined, "the popup did not become primary");
  assert.equal(world.record(WSP_A).windowId, 1);
  assert.deepEqual(world.record(WSP_A).tabSnapshot, ["https://a.test/1", "https://a.test/2"]);
  assert.equal(world.storage[ERROR_KEY], undefined);
});

test("X-118: the first start claims the normal window, not a focused popup", async (t) => {
  const world = makeWorld({
    windows: [{ id: 1 }, { id: 2, type: "popup", focused: true }],
    tabs: [
      { id: 1, url: "https://a.test/", active: true },
      { id: 2, windowId: 2, url: "https://auth.test/login", active: true },
    ],
    storage: {},
  });
  const { B } = await boot(world, t);
  assert.equal(B._state, "ready");
  assert.equal(world.storage["primary-window-id"], 1);
  const [id] = world.storage["ld-wsp-window-1"];
  assert.deepEqual(world.record(id).tabs, [1]);
  assert.equal(world.storage["ld-wsp-window-2"], undefined);
});

test("X-118/D2: the first start claims the non-private window, not a focused private one", async (t) => {
  const world = makeWorld({
    windows: [{ id: 1 }, { id: 2, incognito: true, focused: true }],
    tabs: [
      { id: 1, url: "https://a.test/", active: true },
      { id: 2, windowId: 2, url: "https://private.test/", active: true },
    ],
    storage: {},
  });
  await boot(world, t);
  assert.equal(world.storage["primary-window-id"], 1);
  assert.equal(world.storage["ld-wsp-window-2"], undefined);
});

test("X-118: a window opened while initialize() runs is looked at once it is done, not dropped", async (t) => {
  // No window at the start (macOS); one opens while init still runs
  const world = makeWorld({ windows: [], tabs: [], storage: {}, storageLatencyMs: 2 });
  let opened = null;
  const realGetAll = world.overrides.windows.getAll;
  world.overrides.windows.getAll = async (opts) => {
    const result = await realGetAll(opts);
    if (!opened && world.env?.get("Brainer")._state === "initializing") {
      opened = world.openWindow({ url: "https://early.test/" });
    }
    return result;
  };
  const { B } = await boot(world, t);
  await world.idle();

  assert.ok(opened, "the window opened during init");
  assert.equal(B._state, "ready");
  assert.equal(world.storage["primary-window-id"], opened.id);
  const [id] = world.storage[`ld-wsp-window-${opened.id}`];
  assert.deepEqual(world.record(id).tabs, [opened.tabs[0].id]);
});

test("X-11: the closed window reopened while a Dismiss is being handled is not dropped", async (t) => {
  const { world } = closableWorld();
  const { send } = await boot(world, t);
  world.closeTab(1);
  await world.idle();
  const { when } = world.storage[ERROR_KEY];

  // Dismiss looks for an open window holding the workspaces' tabs (none
  // yet); the user reopens the closed window from History meanwhile.
  const dismissing = send({ action: "acknowledgeLastRestoreError", when });
  await new Promise((r) => setTimeout(r, 150)); // Dismiss is waiting for Firefox to fill the windows
  const entry = world.closed.find((e) => e.window);
  const restored = world.restoreClosed(entry.window.sessionId).window;
  await dismissing;
  await world.idle();

  assert.equal(world.storage["primary-window-id"], restored.id);
  assert.equal(world.record(WSP_B).tabs.length, 2);
  assert.deepEqual(sorted(world.hidden(restored.id)), sorted(world.record(WSP_B).tabs));
});

test("X-35: a window taking the workspaces over files the tabs Firefox adds mid-restore and repaints the toolbar", async (t) => {
  const { world } = closableWorld();
  // A tab that appears in the reopened window between the restore's
  // catch-all pass and the commit, while tab events are still held back
  // ('restoring'): storage calls take a timer hop, so its onCreated is
  // delivered before the state turns 'ready'.
  let late = null;
  const area = makeStorageArea(world.storage, { latencyMs: 1 });
  world.overrides.storage.local = {
    ...area,
    set: async (obj) => {
      const B = world.env?.get("Brainer");
      if (!late && "primary-window-id" in obj && B?._state === "restoring") {
        late = world.openTab({ windowId: obj["primary-window-id"], url: "https://late.test/", active: false });
      }
      return area.set(obj);
    },
  };
  const badges = [];
  world.overrides.browserAction = { setBadgeText: async (d) => { badges.push(d); } };
  await boot(world, t);

  world.closeTab(1);
  await world.idle();
  const entry = world.closed.find((e) => e.window);
  const restored = world.restoreClosed(entry.window.sessionId).window;
  await world.idle();

  assert.equal(world.storage["primary-window-id"], restored.id);
  assert.ok(late, "the late tab was opened during the take-over");
  const a = world.record(WSP_A);
  assert.ok(a.tabs.includes(late.id), "the late tab is filed into the workspace on screen");
  assert.equal(world.tabValue(late.id), WSP_A);
  const last = badges.filter((d) => d.windowId === restored.id).at(-1);
  assert.equal(last?.text, String(a.tabs.length), "the toolbar shows the restored workspace");
});
