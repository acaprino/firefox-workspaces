// tests/banner-actions.test.mjs
// The restore-error banner's Dismiss and Give up after a refused restore:
//  - neither leaves the extension inert until the next Firefox start: Give
//    up starts over at once in the current normal window, Dismiss restores
//    into a window that meanwhile holds the workspaces' tabs (X-34);
//  - Give up detaches the old window's index after exporting it, so a
//    window reusing its id does not adopt the given-up workspaces (X-71);
//  - Give up is refused while a restore runs, and does not clear a warning
//    written during its export (X-72).
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

const ERROR_KEY = "ld-wsp-last-restore-error";

async function boot(world, t) {
  const env = await world.boot();
  t.after(() => world.teardown());
  const send = (message) => env.browser.runtime.onMessage._listeners[0](message, {});
  return { env, send, B: env.get("Brainer") };
}

// Detected restart into window 1, which shows only the homepage: the
// restore is refused (refuse-to-wipe). Firefox numbered the new window 1,
// the id the workspaces were stored under.
function refusedStartWorld({ onBookmark = null } = {}) {
  const storage = seedWorkspaces(1, [
    { id: WSP_A, name: "A", active: true, tabs: [51, 52], tabSnapshot: ["https://a.test/1", "https://a.test/2"] },
    { id: WSP_B, name: "B", tabs: [53], tabSnapshot: ["https://b.test/3"] },
  ]);
  delete storage["primary-window-id"];
  storage["primary-window-last-id"] = 1;
  const world = makeWorld({
    windows: [{ id: 1, focused: true }],
    tabs: [{ id: 1, url: "about:home", active: true }],
    storage,
    sessionAlive: false,
  });
  const bookmarks = [];
  world.overrides.bookmarks = {
    create: async (b) => {
      if (onBookmark) await onBookmark(b, bookmarks);
      bookmarks.push(b);
      return { id: "bm-" + bookmarks.length, type: b.url ? "bookmark" : "folder", ...b };
    },
  };
  return { world, bookmarks };
}

test("X-34/X-71: Give up exports, detaches the old index and starts over in the current window at once", async (t) => {
  const { world, bookmarks } = refusedStartWorld();
  const { B, send } = await boot(world, t);
  assert.equal(world.storage[ERROR_KEY]?.reason, "refuse-to-wipe");
  assert.equal(B._state, "uninitialized");

  const reply = await send({ action: "giveUpRestoreRetry", when: world.storage[ERROR_KEY].when });
  await world.idle();

  assert.equal(reply.success, true);
  assert.equal(reply.exportedWorkspaces, 2);
  assert.deepEqual(bookmarks.filter((b) => b.url).map((b) => b.url).sort(),
    ["https://a.test/1", "https://a.test/2", "https://b.test/3"]);
  assert.equal(B._state, "ready", "used to stay inert until the next Firefox start");
  assert.equal(world.storage["primary-window-id"], 1);
  assert.equal(world.storage["primary-window-last-id"], undefined);
  assert.equal(world.storage[ERROR_KEY], undefined);
  const ids = world.storage["ld-wsp-window-1"];
  assert.equal(ids.length, 1, "one fresh default workspace");
  assert.ok(!ids.includes(WSP_A) && !ids.includes(WSP_B),
    "the given-up workspaces are not adopted by the window that reuses their id");
  assert.deepEqual(world.record(ids[0]).tabs, [1]);
  assert.equal(world.record(ids[0]).active, true);

  // A pop-out opened afterwards stays an additional window (X-118)
  world.openWindow({ type: "popup", url: "https://pay.test/checkout" });
  await world.idle();
  assert.equal(world.storage["primary-window-id"], 1);
});

test("X-34: Dismiss restores into the window once Firefox has filled it with the workspaces' tabs", async (t) => {
  const { world } = refusedStartWorld();
  const { B, send, env } = await boot(world, t);
  const { when } = world.storage[ERROR_KEY];

  // Session restore catches up: the tagged tabs arrive after the refusal
  const a1 = world.openTab({ windowId: 1, url: "https://a.test/1", active: false });
  const b3 = world.openTab({ windowId: 1, url: "https://b.test/3", active: false });
  await env.browser.sessions.setTabValue(a1.id, "wspId", WSP_A);
  await env.browser.sessions.setTabValue(b3.id, "wspId", WSP_B);
  await world.idle();
  assert.equal(B._state, "uninitialized");

  const reply = await send({ action: "acknowledgeLastRestoreError", when });
  await world.idle();

  assert.equal(reply.success, true);
  assert.equal(B._state, "ready", "used to stay inert until a new window or a restart");
  assert.equal(world.storage["primary-window-id"], 1);
  assert.equal(world.storage["primary-window-last-id"], undefined);
  assert.ok(world.record(WSP_A).tabs.includes(a1.id));
  assert.deepEqual(world.record(WSP_B).tabs, [b3.id]);
  assert.deepEqual(world.hidden(1), [b3.id]);
  assert.equal(world.storage[ERROR_KEY], undefined);
  assert.equal(reply.resumed, true);
});

test("X-72: Give up is refused while a restore runs", async (t) => {
  const { world } = refusedStartWorld();
  const { B, send } = await boot(world, t);
  const { when } = world.storage[ERROR_KEY];

  B._state = "restoring"; // a restore in flight (e.g. a window taking the workspaces over)
  const reply = await send({ action: "giveUpRestoreRetry", when });
  B._state = "uninitialized";

  assert.equal(reply._error, true);
  assert.equal(reply._userFacing, true);
  assert.equal(world.storage["primary-window-last-id"], 1, "the retry signal is kept");
  assert.equal(world.storage[ERROR_KEY]?.when, when, "the banner is kept");
});

test("X-72: a warning written while Give up exports is not cleared with the one given up on", async (t) => {
  let injected = false;
  let env;
  const { world } = refusedStartWorld({
    onBookmark: async () => {
      if (injected) return;
      injected = true;
      await env.get("WSPStorageManager").setLastRestoreError({ when: 999, reason: "session-not-restored", wspCount: 1 });
    },
  });
  env = await world.boot();
  t.after(() => world.teardown());
  const send = (message) => env.browser.runtime.onMessage._listeners[0](message, {});
  const { when } = world.storage[ERROR_KEY];

  const reply = await send({ action: "giveUpRestoreRetry", when });
  await world.idle();

  assert.equal(reply.success, true);
  assert.ok(injected);
  assert.equal(world.storage[ERROR_KEY]?.when, 999, "the newer warning survives");
  assert.equal(world.storage["primary-window-last-id"], undefined);
});
