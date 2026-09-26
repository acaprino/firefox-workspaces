// tests/init-visibility.test.mjs
// What initialize() leaves on screen and in the active cache on the
// already-running path, and the one-active invariant on both init paths:
//  - after a disable/re-enable Firefox has shown every hidden tab; init must
//    hide the inactive workspaces' tabs again (X-94);
//  - the active cache is primed at init and on onTabActivated's slow path
//    (X-10);
//  - no workspace (or two) flagged active after an interrupted handoff is
//    repaired instead of hiding every tab (X-95);
//  - tabs _reconcileLateTabs files into the active workspace are shown, and
//    hidden leftovers of an interrupted destroy are closed (X-96).
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B, WSP_C } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

const sorted = (list) => [...list].sort((a, b) => a - b);
const activeIds = (world) => [WSP_A, WSP_B, WSP_C].filter((id) => world.record(id)?.active);

// A owns 1, 2; B owns 3, 4; C owns 5. Session tags agree with the lists.
function threeWorkspaces({ hidden = [], active = 1, flags = { A: true }, sessionAlive = true, storage = {},
  extraTabs = [], extraValues = {} } = {}) {
  const tab = (id, host) => ({ id, url: `https://${host}.test/${id}`, active: id === active, hidden: hidden.includes(id) });
  return makeWorld({
    tabs: [tab(1, "a"), tab(2, "a"), tab(3, "b"), tab(4, "b"), tab(5, "c"), ...extraTabs],
    sessionValues: { 1: WSP_A, 2: WSP_A, 3: WSP_B, 4: WSP_B, 5: WSP_C, ...extraValues },
    storage: {
      ...seedWorkspaces(1, [
        { id: WSP_A, name: "A", active: !!flags.A, tabs: [1, 2], tabSnapshot: ["https://a.test/1", "https://a.test/2"] },
        { id: WSP_B, name: "B", active: !!flags.B, tabs: [3, 4], tabSnapshot: ["https://b.test/3", "https://b.test/4"] },
        { id: WSP_C, name: "C", active: !!flags.C, tabs: [5], tabSnapshot: ["https://c.test/5"] },
      ]),
      ...storage,
    },
    sessionAlive,
  });
}

async function boot(world, t) {
  const env = await world.boot();
  t.after(() => world.teardown());
  assert.equal(env.get("Brainer")._state, "ready");
  return { env, WS: env.get("WorkspaceService") };
}

test("X-94: after a disable/re-enable (every tab shown, tags intact) init hides the inactive workspaces again", async (t) => {
  // Firefox's showHiddenTabs left all five tabs visible; storage.session was
  // cleared with the extension.
  const world = threeWorkspaces({ sessionAlive: false });
  const { WS } = await boot(world, t);

  assert.deepEqual(sorted(world.visible(1)), [1, 2], "only A's tabs on screen");
  assert.deepEqual(sorted(world.hidden(1)), [3, 4, 5]);
  assert.deepEqual(activeIds(world), [WSP_A]);
  assert.equal(WS._activeCache?.activeWspId, WSP_A, "active cache primed (X-10)");
  assert.deepEqual(sorted(WS._activeCache.tabIds), [1, 2]);
});

test("X-94: a tab of another workspace selected while the extension was disabled brings that workspace up", async (t) => {
  const world = threeWorkspaces({ active: 4, sessionAlive: false });
  const { WS } = await boot(world, t);

  assert.deepEqual(activeIds(world), [WSP_B]);
  assert.deepEqual(sorted(world.visible(1)), [3, 4]);
  assert.equal(world.activeTabId(1), 4, "the selection is kept");
  assert.equal(WS._activeCache?.activeWspId, WSP_B);
});

test("X-10: a plain reload primes the active cache; onTabActivated's slow path refills a cold one", async (t) => {
  const world = threeWorkspaces({ hidden: [3, 4, 5] });
  const { WS } = await boot(world, t);
  assert.equal(WS._activeCache?.activeWspId, WSP_A, "primed at init");

  WS._activeCache = null; // e.g. dropped by a filing mismatch
  world.selectTab(2);
  await world.idle();
  assert.equal(WS._activeCache?.activeWspId, WSP_A, "refilled from the slow path's read");
  assert.equal(WS.isTabInActiveWsp(1, 1), true);
});

test("X-10: the slow path does not refill the cache from a read an activation overtook", async (t) => {
  const world = threeWorkspaces({ hidden: [3, 4, 5] });
  const { WS, env } = await boot(world, t);
  const wspA = await env.get("WSPStorageManager").getWorkspace(WSP_A);
  const seq = WS.activationSeq();
  await WS.activateWsp(WSP_B, 1);
  WS.primeActiveCache(1, wspA, seq); // the read predates the switch to B
  assert.equal(WS._activeCache.activeWspId, WSP_B);
});

test("X-95: no workspace active after an interrupted switch: init activates the one owning the selected tab", async (t) => {
  // A was stood down and B's tabs shown, then the background died before
  // B was saved active.
  const world = threeWorkspaces({ hidden: [5], flags: {} });
  const { WS } = await boot(world, t);

  assert.deepEqual(activeIds(world), [WSP_A]);
  assert.deepEqual(sorted(world.visible(1)), [1, 2]);
  assert.equal(world.activeTabId(1), 1);
  assert.equal(WS._activeCache?.activeWspId, WSP_A);
});

test("X-95: two workspaces flagged active: the one owning the selected tab stays, the other is stood down", async (t) => {
  const world = threeWorkspaces({ active: 3, hidden: [5], flags: { A: true, B: true } });
  await boot(world, t);

  assert.deepEqual(activeIds(world), [WSP_B]);
  assert.deepEqual(sorted(world.visible(1)), [3, 4]);
});

test("X-95: a restart after an interrupted switch restores one active workspace instead of hiding every tab", async (t) => {
  // Crash: the stored primary (7) is gone, window 1 comes back with the tags.
  const world = threeWorkspaces({ hidden: [5], flags: {}, sessionAlive: false });
  const seed = world.storage;
  for (const id of [WSP_A, WSP_B, WSP_C]) seed[`ld-wsp-${id}`].windowId = 7;
  seed["ld-wsp-window-7"] = seed["ld-wsp-window-1"];
  seed["ld-wsp-order-7"] = seed["ld-wsp-order-1"];
  delete seed["ld-wsp-window-1"];
  delete seed["ld-wsp-order-1"];
  seed["primary-window-id"] = 7;
  const env = await world.boot({ settleMs: 700 });
  t.after(() => world.teardown());

  assert.equal(env.get("Brainer")._state, "ready");
  assert.deepEqual(activeIds(world), [WSP_A]);
  assert.deepEqual(sorted(world.visible(1)), [1, 2], "A's tabs stay on screen");
  assert.deepEqual(sorted(world.hidden(1)), [3, 4, 5]);
});

test("X-95: hideInactiveWspTabs with no workspace named or flagged active hides nothing", async (t) => {
  const world = threeWorkspaces({ hidden: [5] });
  const { WS, env } = await boot(world, t);
  await env.get("WSPStorageManager").mutateWorkspace(WSP_A, (w) => { w.active = false; });
  await env.browser.tabs.show([3, 4]);
  await WS.hideInactiveWspTabs(1, null);
  assert.deepEqual(sorted(world.visible(1)), [1, 2, 3, 4]);
});

test("X-96: a hidden tab _reconcileLateTabs files into the active workspace is shown", async (t) => {
  const world = threeWorkspaces({ hidden: [3, 4, 5] });
  const { env, WS } = await boot(world, t);
  const Brainer = env.get("Brainer");

  // A late session-restored tab carrying the active workspace's tag, and one
  // whose tag names a workspace that no longer exists (no destroy tombstone).
  const late = world.openTab({ url: "https://a.test/late", active: false });
  const stray = world.openTab({ url: "https://gone.test/", active: false });
  await world.idle();
  await env.get("TabService").removeTabFromWorkspace(1, late.id);
  await env.get("TabService").removeTabFromWorkspace(1, stray.id);
  await env.browser.sessions.setTabValue(late.id, "wspId", WSP_A);
  await env.browser.sessions.setTabValue(stray.id, "wspId", "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  await env.browser.tabs.hide([late.id, stray.id]);
  assert.equal(world.tab(late.id).hidden, true);

  await Brainer._reconcileLateTabs(1);
  assert.ok(world.record(WSP_A).tabs.includes(late.id));
  assert.ok(world.record(WSP_A).tabs.includes(stray.id));
  assert.equal(world.tab(late.id).hidden, false, "filed into the workspace on screen and shown");
  assert.equal(world.tab(stray.id).hidden, false);
  assert.ok(WS.isTabInActiveWsp(1, late.id));
});

test("X-96: hidden tabs left by an interrupted destroy are closed at init, not adopted", async (t) => {
  // B's destroy died after dropping its records: tabs 3, 4 are hidden and
  // still tagged B, and the tombstone names B.
  const world = threeWorkspaces({ hidden: [3, 4, 5], storage: { "ld-wsp-pending-destroys": [WSP_B] } });
  const seed = world.storage;
  delete seed[`ld-wsp-${WSP_B}`];
  seed["ld-wsp-window-1"] = [WSP_A, WSP_C];
  seed["ld-wsp-order-1"] = [WSP_A, WSP_C];
  await boot(world, t);

  assert.equal(world.tab(3), undefined, "leftover closed");
  assert.equal(world.tab(4), undefined, "leftover closed");
  assert.deepEqual(world.record(WSP_A).tabs, [1, 2], "nothing adopted into the active workspace");
  assert.deepEqual(sorted(world.visible(1)), [1, 2]);
});

test("X-96: a completed destroy clears its tombstone", async (t) => {
  const world = threeWorkspaces({ hidden: [3, 4, 5] });
  const { WS } = await boot(world, t);
  await WS.destroyWsp(WSP_C, 1);
  assert.equal(world.tab(5), undefined);
  assert.equal(world.storage["ld-wsp-pending-destroys"], undefined);
});
