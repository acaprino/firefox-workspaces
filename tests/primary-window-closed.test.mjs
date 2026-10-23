// tests/primary-window-closed.test.mjs
// Firefox closes a window when its last VISIBLE tab closes
// (browser.tabs.closeWindowWithLastTab): the inactive workspaces' hidden
// tabs go with it. The close cannot be prevented; the backend reports it and
// offers a recovery the user triggers (X-100). Nothing reopens on its own.
// Also: an AMO update waits for a running activation before reloading (X-95).
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

const sorted = (list) => [...list].sort((a, b) => a - b);
const ERROR_KEY = "ld-wsp-last-restore-error";

// Window 1 (primary): A active with its only tab 1; B owns hidden tabs 3, 4.
// Window 2: an unrelated window that stays open.
function closableWorld({ secondWindow = true, ...opts } = {}) {
  return makeWorld({
    windows: secondWindow ? [{ id: 1, focused: true }, { id: 2 }] : [{ id: 1 }],
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 3, url: "https://b.test/3", hidden: true },
      { id: 4, url: "https://b.test/4", hidden: true },
      ...(secondWindow ? [{ id: 10, windowId: 2, url: "https://other.test/", active: true }] : []),
    ],
    sessionValues: { 1: WSP_A, 3: WSP_B, 4: WSP_B },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1], tabSnapshot: ["https://a.test/1"] },
      { id: WSP_B, name: "B", tabs: [3, 4], tabSnapshot: ["https://b.test/3", "https://b.test/4"] },
    ]),
    ...opts,
  });
}

async function boot(world, t) {
  const env = await world.boot();
  t.after(() => world.teardown());
  assert.equal(env.get("Brainer")._state, "ready");
  const send = (message) => env.browser.runtime.onMessage._listeners[0](message, {});
  return { env, send };
}

test("X-100: closing the last visible tab closes the window with the hidden workspaces; the banner reports it", async (t) => {
  const world = closableWorld();
  const { env } = await boot(world, t);

  world.closeTab(1); // Ctrl+W on the only tab on screen
  await world.idle();

  assert.equal(world.windows.has(1), false, "Firefox closed the whole window");
  const payload = world.storage[ERROR_KEY];
  assert.equal(payload?.reason, "primary-window-closed");
  assert.equal(payload.hiddenTabCount, 2);
  assert.equal(payload.hiddenWspCount, 1);
  assert.equal(world.storage["primary-window-last-id"], 1, "the workspaces wait for the window to come back");
  assert.equal(world.windows.size, 1, "nothing was reopened automatically");
  assert.equal(env.get("Brainer")._state, "uninitialized");
});

test("X-100: the banner action reopens the closed window and restores the workspaces into it", async (t) => {
  const world = closableWorld();
  const { env, send } = await boot(world, t);
  world.closeTab(1);
  await world.idle();
  const { when } = world.storage[ERROR_KEY];

  const reply = await send({ action: "reopenClosedPrimaryWindow", when });
  await world.idle();

  assert.equal(reply.success, true);
  const windowId = reply.windowId;
  assert.ok(world.windows.has(windowId));
  assert.equal(world.storage["primary-window-id"], windowId);
  assert.equal(world.storage[ERROR_KEY], undefined, "banner cleared");
  assert.equal(env.get("Brainer")._state, "ready");
  const a = world.record(WSP_A);
  const b = world.record(WSP_B);
  assert.equal(a.active, true);
  assert.equal(a.tabs.length, 1);
  assert.equal(b.tabs.length, 2, "B's tabs are back");
  assert.deepEqual(sorted(world.visible(windowId)), a.tabs, "only A's tab on screen");
  assert.deepEqual(sorted(world.hidden(windowId)), sorted(b.tabs));
});

test("X-100: a window opened meanwhile is not taken for the closed one", async (t) => {
  const world = closableWorld();
  const { env } = await boot(world, t);
  world.closeTab(1);
  await world.idle();

  world.openWindow({ url: "about:newtab" }); // Ctrl+N
  await new Promise((r) => setTimeout(r, 700));
  await world.idle();

  assert.equal(world.storage[ERROR_KEY]?.reason, "primary-window-closed", "banner kept, no refuse-to-wipe");
  assert.equal(world.storage["primary-window-id"], undefined);
  assert.deepEqual(world.record(WSP_B).tabs, [3, 4], "the workspaces are not emptied into the new window");
  assert.equal(env.get("Brainer")._refuseToWipeActive, false);
});

test("X-100: a stale or impossible reopen request is refused", async (t) => {
  const world = closableWorld();
  const { send } = await boot(world, t);
  const idle = await send({ action: "reopenClosedPrimaryWindow" });
  assert.equal(idle._userFacing, true, "nothing is waiting while the primary window is open");

  world.closeTab(1);
  await world.idle();
  const stale = await send({ action: "reopenClosedPrimaryWindow", when: 1 });
  assert.equal(stale.success, false);
  assert.equal(stale.stale, true);
  assert.equal(world.windows.size, 1);
});

test("X-100: closing the window as the browser quits (no other window) raises no banner", async (t) => {
  const world = closableWorld({ secondWindow: false });
  await boot(world, t);
  world.closeTab(1);
  await world.idle();
  assert.equal(world.storage[ERROR_KEY], undefined);
  assert.equal(world.storage["primary-window-last-id"], 1);
});

test("X-95: an AMO update waits for a running activation before reloading the background", async (t) => {
  const world = closableWorld();
  const reloads = [];
  const listeners = [];
  world.overrides.runtime = {
    reload: () => { reloads.push(Date.now()); },
    onUpdateAvailable: { addListener: (fn) => listeners.push(fn) },
  };
  const { env } = await boot(world, t);
  const WS = env.get("WorkspaceService");
  let release;
  const gate = new Promise((r) => { release = r; });
  const realShow = env.browser.tabs.show;
  env.browser.tabs.show = async (ids) => { await gate; return realShow(ids); };

  const activation = WS.activateWsp(WSP_B, 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(listeners.length, 1);
  listeners[0]({ version: "9.9.9" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reloads.length, 0, "not while B is being brought up");

  release();
  await activation;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reloads.length, 1);
  assert.equal(world.record(WSP_B).active, true);
});
