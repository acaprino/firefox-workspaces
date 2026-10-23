// tests/tab-filing.test.mjs
// Where tabs get filed when they appear in the primary window outside the
// usual "new tab in the active workspace" path: restored with an old
// session tag (X-01, X-101), unpinned (X-30), dragged between windows
// (X-22), opened mid-switch (X-13) or mid-destroy (X-70), closed within
// milliseconds (X-43), or hidden by another tab-hiding extension (X-105).
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const sorted = (list) => [...list].sort((a, b) => a - b);
const CONTAINER = "firefox-container-1";

// A active with tabs 1, 2; B inactive with hidden tabs 3..6.
function twoWorkspaces({ bTabs = [3, 4, 5, 6], b = {}, ...opts } = {}) {
  return makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 2, url: "https://a.test/2" },
      ...bTabs.map((id) => ({ id, url: `https://b.test/${id}`, hidden: true })),
    ],
    sessionValues: Object.fromEntries([[1, WSP_A], [2, WSP_A], ...bTabs.map((id) => [id, WSP_B])]),
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1, 2] },
      { id: WSP_B, name: "B", tabs: bTabs, ...b },
    ]),
    ...opts,
  });
}

async function boot(world, t, { settleMs = 20 } = {}) {
  const env = await world.boot({ settleMs });
  t.after(() => world.teardown());
  const WS = env.get("WorkspaceService");
  const TabService = env.get("TabService");
  assert.equal(env.get("Brainer")._state, "ready");
  return { env, WS, TabService };
}

// Every non-pinned tab of window 1 must belong to exactly one workspace.
function assertAllFiled(world) {
  const filed = [...world.record(WSP_A).tabs, ...world.record(WSP_B).tabs];
  assert.equal(new Set(filed).size, filed.length, `a tab is filed twice: ${filed}`);
  const open = world.order(1).filter((id) => !world.tab(id).pinned);
  assert.deepEqual(sorted(filed), sorted(open), "every open tab is filed, and only open tabs");
}

test("X-101: Undo Close Tab of an inactive workspace's tab switches to that workspace", async (t) => {
  // IPC latency: onActivated for the restored tab reads storage before
  // onCreated's filing lands, as it does in Firefox.
  const world = twoWorkspaces({ storageLatencyMs: 2 });
  const { WS, env } = await boot(world, t, { settleMs: 300 });

  await WS.activateWsp(WSP_B, 1);
  await world.idle();
  world.closeTab(6);
  await world.idle();
  await WS.activateWsp(WSP_A, 1);
  await world.idle();
  assert.deepEqual(sorted(world.visible(1)), [1, 2]);

  // Ctrl+Shift+T: Firefox selects the restored tab, which carries tag B.
  const restored = world.undoCloseTab();
  assert.equal(world.tabValue(restored.id), WSP_B);
  await world.idle();

  assert.equal(world.activeTabId(1), restored.id, "the restored tab is selected");
  assert.equal(world.record(WSP_B).active, true, "its workspace is shown");
  assert.equal(world.record(WSP_A).active, false);
  assert.ok(world.record(WSP_B).tabs.includes(restored.id));
  assert.deepEqual(sorted(world.visible(1)), sorted([3, 4, 5, restored.id]),
    "only B's tabs are on screen -- not the restored tab inside A's strip");
  const cache = env.get("WorkspaceService")._activeCache;
  assert.equal(cache.activeWspId, WSP_B);
  assert.ok(cache.tabIds.has(restored.id));
  assertAllFiled(world);
});

test("X-01: tagged tabs restored together are all filed, the selected one brings its workspace up", async (t) => {
  const world = twoWorkspaces({ storageLatencyMs: 1 });
  const { WS } = await boot(world, t, { settleMs: 200 });

  await WS.activateWsp(WSP_B, 1);
  await world.idle();
  for (const id of [4, 5, 6]) world.closeTab(id);
  await world.idle();
  await WS.activateWsp(WSP_A, 1);
  await world.idle();

  // History > Recently Closed Tabs > Restore All Tabs: three onCreated
  // handlers race for B's record; the last restored tab ends up selected.
  const restored = [world.restoreClosed().tab.id, world.restoreClosed().tab.id, world.restoreClosed().tab.id];
  await world.idle();

  assert.deepEqual(sorted(world.record(WSP_B).tabs), sorted([3, ...restored]), "no restored tab lost to a race");
  assert.equal(world.record(WSP_B).active, true);
  assert.deepEqual(sorted(world.visible(1)), sorted([3, ...restored]));
  assertAllFiled(world);
});

test("X-01: a tagged tab restored in the background is hidden in its workspace and its snapshot refreshed", async (t) => {
  const world = twoWorkspaces();
  const { env, TabService } = await boot(world, t);
  const key = `1:${WSP_B}`;
  assert.equal(TabService._snapshotTimers.has(key), false);

  const tab = world.openTab({ url: "https://b.test/back", active: false });
  await env.browser.sessions.setTabValue(tab.id, "wspId", WSP_B); // lands before onCreated is delivered
  await world.idle();

  assert.ok(world.record(WSP_B).tabs.includes(tab.id));
  assert.equal(world.tab(tab.id).hidden, true);
  assert.equal(world.record(WSP_A).active, true, "a background restore does not switch");
  assert.equal(TabService._snapshotTimers.has(key), true, "B's snapshot refresh is scheduled");
  assertAllFiled(world);
});

test("X-30: unpinning files the tab into the workspace on screen, not the one it was pinned in", async (t) => {
  const world = twoWorkspaces();
  const { env, WS } = await boot(world, t);

  await env.browser.tabs.update(2, { pinned: true });
  await world.idle();
  assert.deepEqual(world.record(WSP_A).tabs, [1]);
  assert.equal(world.tabValue(2), undefined, "pinning drops the workspace tag");

  await WS.activateWsp(WSP_B, 1);
  await world.idle();
  // A pinned tab tagged by an older version keeps its tag: still ignored.
  await env.browser.sessions.setTabValue(2, "wspId", WSP_A);
  await env.browser.tabs.update(2, { pinned: false });
  await world.idle();

  assert.equal(world.tab(2).hidden, false, "the unpinned tab stays in front of the user");
  assert.ok(world.record(WSP_B).tabs.includes(2));
  assert.ok(!world.record(WSP_A).tabs.includes(2));
  assert.equal(world.tabValue(2), WSP_B);
  assertAllFiled(world);
});

test("X-22: a tab torn out of the primary window leaves its workspace; dragged back it joins the one on screen", async (t) => {
  const world = twoWorkspaces({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 2, url: "https://a.test/2" },
      { id: 3, url: "https://b.test/3", hidden: true },
      { id: 10, windowId: 2, url: "https://other.test/", active: true },
    ],
    bTabs: [3],
  });
  const { env, WS } = await boot(world, t);

  await env.browser.tabs.move(2, { windowId: 2, index: -1 });
  await world.idle();
  assert.deepEqual(world.record(WSP_A).tabs, [1], "torn-out tab no longer counted in A");
  assert.equal(world.tabValue(2), undefined, "its tag is dropped");

  await WS.activateWsp(WSP_B, 1);
  await world.idle();
  await env.browser.tabs.move(2, { windowId: 1, index: -1 });
  await world.idle();
  assert.ok(world.record(WSP_B).tabs.includes(2), "dropped into B's strip: filed under B");
  assert.equal(world.tabValue(2), WSP_B);

  await WS.activateWsp(WSP_A, 1);
  await world.idle();
  await WS.activateWsp(WSP_B, 1);
  await world.idle();
  assert.deepEqual(sorted(world.visible(1)), [2, 3], "the tab is where the user put it");
  assertAllFiled(world);
});

test("X-13: a tab opened while a switch is running is filed, tagged and put in the workspace's container", async (t) => {
  // API latency: the switch spans the delivery of the new tab's events.
  const world = twoWorkspaces({
    bTabs: [3],
    b: { containerId: CONTAINER },
    containers: [{ cookieStoreId: CONTAINER, name: "Work" }],
    apiLatencyMs: 1,
  });
  const { WS } = await boot(world, t, { settleMs: 300 });

  // Ctrl+T right after the switch focused B's tab, while it still runs.
  const hideInactive = WS._hideInactiveFromList;
  let opened = null;
  WS._hideInactiveFromList = async function (...args) {
    if (!opened) opened = world.openTab({ url: "about:newtab" });
    return hideInactive.apply(this, args);
  };
  await WS.activateWsp(WSP_B, 1);
  WS._hideInactiveFromList = hideInactive;
  await world.idle();

  assert.ok(opened, "a tab was opened mid-activation");
  const bTabs = world.record(WSP_B).tabs;
  const fresh = bTabs.filter((id) => id !== 3);
  assert.equal(fresh.length, 1, `the new tab is filed under B: ${bTabs}`);
  const tab = world.tab(fresh[0]);
  assert.equal(tab.cookieStoreId, CONTAINER, "reopened in B's container");
  assert.equal(world.tabValue(tab.id), WSP_B);
  assert.equal(world.tab(opened.id), undefined, "the default-container original was replaced");
  assertAllFiled(world);
});

test("X-13: a background tab the post-switch sweep files is cached, so navigation enforces the container", async (t) => {
  const world = twoWorkspaces({
    bTabs: [3],
    b: { containerId: CONTAINER },
    containers: [{ cookieStoreId: CONTAINER, name: "Work" }],
    apiLatencyMs: 1,
  });
  const { WS } = await boot(world, t, { settleMs: 300 });

  const hideInactive = WS._hideInactiveFromList;
  let opened = null;
  WS._hideInactiveFromList = async function (...args) {
    if (!opened) opened = world.openTab({ url: "about:blank", active: false });
    return hideInactive.apply(this, args);
  };
  await WS.activateWsp(WSP_B, 1);
  WS._hideInactiveFromList = hideInactive;
  await world.idle();
  assert.ok(world.record(WSP_B).tabs.includes(opened.id));
  assert.ok(WS._activeCache.tabIds.has(opened.id), "the swept tab is in the active cache");

  world.navigate(opened.id, "https://bank.test/");
  await world.idle();
  const bank = [...world.tabs.values()].find((x) => x.url === "https://bank.test/" && x.windowId === 1);
  assert.equal(bank.cookieStoreId, CONTAINER, "the navigation reopened it in B's container");
  assert.ok(world.record(WSP_B).tabs.includes(bank.id));
});

test("X-70: a tab opened while the active workspace is being destroyed lands in the workspace that takes over", async (t) => {
  const world = twoWorkspaces({ bTabs: [3] });
  const { WS } = await boot(world, t);

  // A page opens a tab in the gap between destroyWsp's pre-deactivation of
  // A (first in the list) and the activation of B.
  const activate = WS.activateWsp;
  let opened = null;
  WS.activateWsp = async function (wspId, ...rest) {
    if (!opened && wspId === WSP_B) {
      opened = world.openTab({ url: "https://popup.test/", active: false });
      await delay(40);
    }
    return activate.call(this, wspId, ...rest);
  };
  await WS.destroyWsp(WSP_A, 1);
  WS.activateWsp = activate;
  await world.idle();

  assert.ok(opened);
  assert.ok(world.tab(opened.id), "the new tab was not closed with the destroyed workspace");
  assert.equal(world.record(WSP_A), undefined, "A is gone");
  assert.equal(world.record(WSP_B).active, true);
  assert.ok(world.record(WSP_B).tabs.includes(opened.id));
  assert.deepEqual(world.storage["ld-wsp-window-1"], [WSP_B]);
});

test("X-43: a tab closed within milliseconds of opening leaves no stale id behind", async (t) => {
  const world = twoWorkspaces({ storageLatencyMs: 2 });
  const { TabService } = await boot(world, t, { settleMs: 300 });

  const tab = world.openTab({ url: "https://download.test/file", active: false });
  world.closeTab(tab.id);
  await world.idle();
  assert.deepEqual(world.record(WSP_A).tabs, [1, 2]);

  // Same race driven directly: the add's reads were in flight when the close came.
  const tab2 = world.openTab({ url: "https://redirect.test/", active: false });
  await world.idle();
  const snapshot = { ...tab2 };
  world.closeTab(tab2.id);
  await world.idle();
  await TabService.addTabToWorkspace(snapshot);
  assert.deepEqual(world.record(WSP_A).tabs, [1, 2], "a late add of a closed tab is refused");
});

test("X-105: tabs hidden by another tab-hiding extension are not adopted on first install", async (t) => {
  // Simple Tab Groups has group-2 tabs 2 and 3 hidden; no workspace data yet.
  const world = makeWorld({
    tabs: [
      { id: 1, url: "https://one.test/", active: true },
      { id: 2, url: "https://two.test/", hidden: true },
      { id: 3, url: "https://three.test/", hidden: true },
    ],
  });
  const env = await world.boot();
  t.after(() => world.teardown());
  const Brainer = env.get("Brainer");
  const WS = env.get("WorkspaceService");
  assert.equal(Brainer._state, "ready");
  const [wspId] = world.storage["ld-wsp-window-1"];
  assert.deepEqual(world.record(wspId).tabs, [1], "only the tab on screen is absorbed");

  await Brainer._reconcileLateTabs(1);
  assert.deepEqual(world.record(wspId).tabs, [1], "the late-tab sweep leaves them alone too");

  await WS.createWorkspaceWithTab({ name: "Second", windowId: 1, active: true });
  await world.idle();
  await WS.activateWsp(wspId, 1);
  await world.idle();
  assert.deepEqual(world.visible(1), [1], "switching back does not show the other extension's tabs");
  assert.deepEqual(world.hidden(1).filter((id) => id <= 3), [2, 3]);
});
