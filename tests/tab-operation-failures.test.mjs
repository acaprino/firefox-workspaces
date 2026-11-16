import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A } from "./helpers/world.mjs";

async function fixture(t) {
  const world = makeWorld({
    tabs: [{ id: 1, url: "https://example.test/", active: true }],
    sessionValues: { 1: WSP_A },
    storage: seedWorkspaces(1, [{ id: WSP_A, name: "Home", active: true, tabs: [1] }]),
    containers: [{ cookieStoreId: "firefox-container-1", name: "Work", color: "blue", icon: "circle" }],
  });
  const env = await world.boot();
  t.after(() => world.teardown());
  return { world, env };
}

test("failed forced container reopen keeps the original tab assigned and cached", async t => {
  const { world, env } = await fixture(t);
  const workspace = env.get("WorkspaceService");
  world.record(WSP_A).containerId = "firefox-container-1";
  workspace._updateActiveCache(1, [1], WSP_A, "firefox-container-1");
  env.browser.tabs.create = async () => { throw new Error("Tab creation failed"); };
  await env.get("TabService").forceTabIntoActiveContainer(world.tab(1), "https://example.test/");
  assert.deepEqual([...world.record(WSP_A).tabs], [1]);
  assert.ok(workspace._activeCache.tabIds.has(1));
  assert.ok(world.tab(1));
});

test("concurrent restores consume one history entry only once", async t => {
  const { world, env } = await fixture(t);
  const entry = { url: "https://example.test/closed", title: "Closed", closedAt: 123 };
  await env.get("WSPStorageManager").saveClosedTab(WSP_A, entry);
  const create = env.browser.tabs.create;
  let created = 0;
  env.browser.tabs.create = async options => {
    created++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return create(options);
  };
  const service = env.get("TabService");
  const results = await Promise.all([
    service.restoreClosedTab(WSP_A, entry, 1), service.restoreClosedTab(WSP_A, entry, 1),
  ]);
  assert.equal(created, 1);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await service.getClosedTabs(WSP_A)).length, 0);
  await world.idle();
});

test("a failed history restore remains retryable", async t => {
  const { world, env } = await fixture(t);
  const entry = { url: "https://example.test/closed", title: "Closed", closedAt: 123 };
  await env.get("WSPStorageManager").saveClosedTab(WSP_A, entry);
  const create = env.browser.tabs.create;
  env.browser.tabs.create = async () => { throw new Error("Unavailable"); };
  const service = env.get("TabService");
  await assert.rejects(service.restoreClosedTab(WSP_A, entry, 1), /Unavailable/);
  assert.equal((await service.getClosedTabs(WSP_A)).length, 1);
  env.browser.tabs.create = create;
  assert.ok(await service.restoreClosedTab(WSP_A, entry, 1));
  await world.idle();
});

test("failed original close rolls back the newly created container tab", async t => {
  const { world, env } = await fixture(t);
  const remove = env.browser.tabs.remove;
  env.browser.tabs.remove = async id => {
    if (id === 1) throw new Error("Original close failed");
    return remove(id);
  };
  const result = await env.get("TabService").withReopenGuard(() =>
    env.get("TabService")._reopenInContainer(world.tab(1), "firefox-container-1"));
  await world.idle();
  assert.equal(result, null);
  assert.deepEqual((await env.browser.tabs.query({ windowId: 1 })).map(t => t.id), [1]);
  assert.deepEqual([...world.record(WSP_A).tabs], [1]);
});

test("double close failure keeps both live tabs owned by the workspace", async t => {
  const { world, env } = await fixture(t);
  const workspace = env.get("WorkspaceService");
  world.record(WSP_A).containerId = "firefox-container-1";
  workspace._updateActiveCache(1, [1], WSP_A, "firefox-container-1");
  env.browser.tabs.remove = async () => { throw new Error("All closes failed"); };
  await env.get("TabService").forceTabIntoActiveContainer(world.tab(1), "https://example.test/");
  await world.idle();
  const live = await env.browser.tabs.query({ windowId: 1 });
  assert.equal(live.length, 2);
  assert.deepEqual([...world.record(WSP_A).tabs].sort(), live.map(t => t.id).sort());
  for (const tab of live) {
    assert.equal(await env.browser.sessions.getTabValue(tab.id, "wspId"), WSP_A);
    assert.ok(workspace._activeCache.tabIds.has(tab.id));
  }
});

test("a close reporting failure after removal still commits the replacement", async t => {
  const { world, env } = await fixture(t);
  const remove = env.browser.tabs.remove;
  env.browser.tabs.remove = async id => {
    await remove(id);
    throw new Error("Failure after close");
  };
  const result = await env.get("TabService").withReopenGuard(() =>
    env.get("TabService")._reopenInContainer(world.tab(1), "firefox-container-1"));
  assert.ok(result);
  assert.equal(result.cookieStoreId, "firefox-container-1");
  assert.deepEqual((await env.browser.tabs.query({ windowId: 1 })).map(t => t.id), [result.id]);
});

test("a resolved close request that leaves the original open rolls back the replacement", async t => {
  const { world, env } = await fixture(t);
  const remove = env.browser.tabs.remove;
  env.browser.tabs.remove = async id => id === 1 ? undefined : remove(id);
  const result = await env.get("TabService").withReopenGuard(() =>
    env.get("TabService")._reopenInContainer(world.tab(1), "firefox-container-1"));
  assert.equal(result, null);
  assert.deepEqual((await env.browser.tabs.query({ windowId: 1 })).map(t => t.id), [1]);
});
