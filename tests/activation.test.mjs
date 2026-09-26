// tests/activation.test.mjs
// Workspace switches: the one-active invariant and what is left on screen
// when a switch races other operations or Firefox refuses part of it.
//  - A failed activation keeps the previous workspace active (X-29), and a
//    destroy waits for an activation already heading for its workspace.
//  - createWorkspace switches on the activation chain (X-36); so does a
//    bookmark restore (X-23).
//  - Rapid keyboard cycling steps from the pending target (X-37).
//  - Moving a workspace's last tab brings the destination up directly (X-38).
//  - tabs.hide/show are all-or-nothing in Firefox: one closing tab must not
//    cancel the pass (X-104); a tab Firefox refused to hide while sharing
//    is hidden once the sharing stops (X-103).
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B, WSP_C } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

const sorted = (list) => [...list].sort((a, b) => a - b);
const activeIds = (world, ids = [WSP_A, WSP_B, WSP_C]) => ids.filter((id) => world.record(id)?.active);

// Window list [A, B, C]; A (active) owns 1, 2; B owns 3, 4; C owns 5.
function threeWorkspaces({ cTabs = [5], ...opts } = {}) {
  return makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 2, url: "https://a.test/2" },
      { id: 3, url: "https://b.test/3", hidden: true },
      { id: 4, url: "https://b.test/4", hidden: true },
      ...cTabs.map((id) => ({ id, url: `https://c.test/${id}`, hidden: true })),
    ],
    sessionValues: { 1: WSP_A, 2: WSP_A, 3: WSP_B, 4: WSP_B, ...Object.fromEntries(cTabs.map((id) => [id, WSP_C])) },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1, 2] },
      { id: WSP_B, name: "B", tabs: [3, 4] },
      { id: WSP_C, name: "C", tabs: cTabs },
    ]),
    ...opts,
  });
}

async function boot(world, t) {
  const env = await world.boot();
  t.after(() => world.teardown());
  assert.equal(env.get("Brainer")._state, "ready");
  return { env, WS: env.get("WorkspaceService"), TabService: env.get("TabService") };
}

test("X-29: an activation that throws keeps the previous workspace active, on screen and in the cache", async (t) => {
  // C is empty, so activating it creates a fallback tab -- which fails.
  const world = threeWorkspaces({ cTabs: [] });
  const { env, WS } = await boot(world, t);
  env.browser.tabs.create = async () => { throw new Error("Invalid window ID: 1"); };

  await assert.rejects(WS.activateWsp(WSP_C, 1), /Invalid window ID/);
  assert.deepEqual(activeIds(world), [WSP_A], "A was never stood down");
  assert.deepEqual(sorted(world.visible(1)), [1, 2]);
  assert.equal(WS._activeCache?.activeWspId, WSP_A);
});

test("X-29: a target deleted mid-activation keeps the previous workspace active", async (t) => {
  const world = threeWorkspaces();
  const { env, WS } = await boot(world, t);
  const S = env.get("WSPStorageManager");
  const realShow = env.browser.tabs.show;
  env.browser.tabs.show = async (ids) => {
    // The record disappears while B's tabs are being shown
    await S.removeWsp(WSP_B, 1);
    await S.deleteWspState(WSP_B);
    return realShow(ids);
  };

  await WS.activateWsp(WSP_B, 1);
  assert.deepEqual(activeIds(world), [WSP_A]);
  assert.equal(WS._activeCache?.activeWspId, WSP_A);
});

test("X-29: a destroy racing an activation of the same workspace leaves one live workspace active", async (t) => {
  const world = threeWorkspaces();
  const { WS } = await boot(world, t);

  const activation = WS.activateWsp(WSP_B, 1);
  const destroy = WS.destroyWsp(WSP_B, 1);
  await Promise.allSettled([activation, destroy]);
  await world.idle();

  assert.equal(world.record(WSP_B), undefined, "B destroyed");
  const active = activeIds(world);
  assert.equal(active.length, 1, `exactly one workspace active, got ${active}`);
  assert.equal(WS._activeCache?.activeWspId, active[0], "the cache names the live active workspace");
  assert.deepEqual(sorted(world.visible(1)), sorted(world.record(active[0]).tabs));
});

test("X-36: createWorkspace queued behind an activation leaves exactly one workspace active", async (t) => {
  const world = threeWorkspaces({ storageLatencyMs: 1 });
  const { WS } = await boot(world, t);
  const created = { name: "N", windowId: 1, active: true, tabs: [] };

  const activation = WS.activateWsp(WSP_B, 1);
  await new Promise((r) => setTimeout(r, 3)); // the activation is under way
  await Promise.all([activation, WS.createWorkspace(created)]);

  const ids = [WSP_A, WSP_B, WSP_C, created.id];
  assert.deepEqual(activeIds(world, ids), [created.id], "the later request wins, alone");
  assert.equal(WS._activeCache.activeWspId, created.id);
});

test("X-36: createWorkspaceWithTab files its first tab into the new workspace even behind an activation", async (t) => {
  const world = threeWorkspaces({ storageLatencyMs: 1 });
  const { env, WS } = await boot(world, t);
  const wsp = { name: "N", windowId: 1, active: true, tabs: [] };

  const activation = WS.activateWsp(WSP_B, 1);
  const created = await env.get("WorkspaceService").createWorkspaceWithTab(wsp);
  await activation;
  await world.idle();

  assert.deepEqual(world.record(created.wspId).tabs, [created.tabId]);
  assert.ok(!world.record(WSP_B).tabs.includes(created.tabId));
  assert.deepEqual(activeIds(world, [WSP_A, WSP_B, WSP_C, created.wspId]), [created.wspId]);
  assert.deepEqual(world.visible(1), [created.tabId]);
});

test("X-37: two quick Alt+Period presses step two workspaces", async (t) => {
  const world = threeWorkspaces({ storageLatencyMs: 1 });
  await boot(world, t);

  world.fire("commands", "onCommand", "workspace-next");
  await new Promise((r) => setTimeout(r, 5));
  world.fire("commands", "onCommand", "workspace-next");
  await world.idle();

  assert.deepEqual(activeIds(world), [WSP_C]);
  assert.deepEqual(world.visible(1), [5]);
});

test("X-38: moving a workspace's only tab to another brings the destination up without a detour", async (t) => {
  const world = makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 3, url: "https://b.test/3", hidden: true },
      { id: 5, url: "https://c.test/5", hidden: true },
    ],
    sessionValues: { 1: WSP_A, 3: WSP_B, 5: WSP_C },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1] },
      { id: WSP_B, name: "B", tabs: [3], lastActiveTabId: 3 },
      { id: WSP_C, name: "C", tabs: [5] },
    ]),
  });
  const { env, WS, TabService } = await boot(world, t);
  const activated = [];
  const realActivate = WS._doActivateWsp.bind(WS);
  WS._doActivateWsp = (wspId, ...rest) => { activated.push(wspId); return realActivate(wspId, ...rest); };
  const bBefore = structuredClone(world.record(WSP_B));

  const tab = await env.browser.tabs.get(1);
  await TabService.moveTabToWsp(tab, WSP_A, WSP_C);
  await world.idle();

  assert.deepEqual(activated, [WSP_C], "B was never brought up in between");
  assert.deepEqual(world.record(WSP_B), bBefore, "B's record untouched");
  assert.equal(world.record(WSP_A), undefined, "the emptied source is gone");
  assert.deepEqual(activeIds(world), [WSP_C]);
  assert.deepEqual(sorted(world.visible(1)), [1, 5]);
  assert.equal(world.activeTabId(1), 1);
});

test("X-23: a click on an old tab during a bookmark restore leaves storage, cache and screen agreeing", async (t) => {
  const world = threeWorkspaces({ apiLatencyMs: 1 });
  world.overrides.bookmarks = {
    search: async () => [{ id: "parent", type: "folder", parentId: "unfiled_____", title: "Workspaces" }],
    get: async (id) => [{ id, type: "folder", parentId: "parent", title: "Saved" }],
    getChildren: async () => Array.from({ length: 6 }, (_, i) => ({ url: `https://saved.test/${i}`, title: `s${i}` })),
  };
  const { env, WS } = await boot(world, t);

  const restore = env.get("BookmarkService").restoreWorkspace("saved", 1);
  await new Promise((r) => setTimeout(r, 8)); // some restored tabs are open
  world.selectTab(2); // the user clicks A's still visible tab
  const result = await restore;
  await world.idle();

  const ids = [WSP_A, WSP_B, WSP_C, result.wspId];
  assert.deepEqual(activeIds(world, ids), [result.wspId]);
  assert.equal(WS._activeCache.activeWspId, result.wspId);
  assert.deepEqual(sorted(world.visible(1)), sorted(world.record(result.wspId).tabs));
  assert.equal(world.record(result.wspId).tabs.length, 6);
});

test("X-104: a closing tab in the hide list does not keep the other tabs on screen", async (t) => {
  const world = threeWorkspaces();
  const { env, WS } = await boot(world, t);
  // Tab 9 of B is animating closed: every tabs.query still lists it, but
  // its id is already invalid for tabs.hide.
  await env.get("WSPStorageManager").mutateWorkspace(WSP_B, (w) => { w.tabs.push(9); });
  const ghost = { id: 9, windowId: 1, url: "https://b.test/9", hidden: false, pinned: false, active: false, groupId: -1 };
  const realQuery = env.browser.tabs.query;
  env.browser.tabs.query = async (q = {}) => {
    const list = await realQuery(q);
    if ((q.windowId == null || q.windowId === 1) && !q.hidden && !q.pinned && !q.active) list.push({ ...ghost });
    return list;
  };
  await env.browser.tabs.show([3, 4]); // B's tabs visible next to A's (e.g. after an undo close)

  await WS.hideInactiveWspTabs(1, WSP_A);
  assert.deepEqual(sorted(world.hidden(1)), [3, 4, 5]);
  assert.deepEqual(sorted(world.visible(1)), [1, 2]);
});

test("X-104: a closing tab of the target does not abort the switch", async (t) => {
  const world = threeWorkspaces();
  const { env, WS } = await boot(world, t);
  await env.get("WSPStorageManager").mutateWorkspace(WSP_B, (w) => { w.tabs.push(9); });
  const realQuery = env.browser.tabs.query;
  env.browser.tabs.query = async (q = {}) => {
    const list = await realQuery(q);
    if (q.windowId === 1 && q.hidden == null && q.active == null && q.pinned == null) {
      list.push({ id: 9, windowId: 1, url: "https://b.test/9", hidden: true, pinned: false, active: false, groupId: -1 });
    }
    return list;
  };

  await WS.activateWsp(WSP_B, 1);
  assert.deepEqual(activeIds(world), [WSP_B]);
  assert.deepEqual(sorted(world.visible(1)), [3, 4]);
  assert.equal(WS._activeCache.activeWspId, WSP_B);
});

test("X-103: a tab Firefox refused to hide while sharing is hidden once the sharing stops", async (t) => {
  const world = threeWorkspaces();
  const { WS } = await boot(world, t);
  await WS.activateWsp(WSP_B, 1);
  world.setSharing(3, true); // video call in B's tab 3
  world.selectTab(4);
  await world.idle();
  await WS.activateWsp(WSP_A, 1);
  await world.idle();
  assert.deepEqual(sorted(world.visible(1)), [1, 2, 3], "Firefox refused to hide the sharing tab");

  world.setSharing(3, false);
  await world.idle();
  assert.deepEqual(sorted(world.visible(1)), [1, 2]);
  assert.equal(world.tab(3).hidden, true);
  assert.deepEqual(activeIds(world), [WSP_A]);
});
