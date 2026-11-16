import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B } from "./helpers/world.mjs";

async function fixture(t) {
  const world = makeWorld({
    tabs: [{ id: 1, url: "https://a.test/", active: true }, { id: 2, url: "https://b.test/", hidden: true }],
    sessionValues: { 1: WSP_A, 2: WSP_B },
    containers: [1, 2].map(n => ({ cookieStoreId: `firefox-container-${n}`, name: `C${n}`, color: "blue", icon: "circle" })),
    storage: seedWorkspaces(1, [{ id: WSP_A, active: true, tabs: [1] }, { id: WSP_B, tabs: [2] }]),
    autoEvents: false,
  });
  const env = await world.boot(); t.after(() => world.teardown());
  return { world, env, service: env.get("WorkspaceService"), tabs: env.get("TabService"), storage: env.get("WSPStorageManager") };
}

test("container migration retains membership appended during browser calls", async t => {
  const { world, env, service, tabs, storage } = await fixture(t);
  const reopen = tabs._reopenInContainer.bind(tabs);
  let added;
  tabs._reopenInContainer = async (...args) => {
    added = await env.browser.tabs.create({ windowId: 1, url: "https://added.test/", cookieStoreId: "firefox-container-1" });
    await storage.mutateWorkspace(WSP_A, fresh => { fresh.tabs.push(added.id); });
    return reopen(...args);
  };
  await service.setWorkspaceContainer(WSP_A, "firefox-container-1");
  assert.ok(world.record(WSP_A).tabs.includes(added.id));
  assert.equal(world.record(WSP_A).tabs.length, 2);
});

test("container migration serializes with a workspace switch", async t => {
  const { world, service, tabs } = await fixture(t);
  const reopen = tabs._reopenInContainer.bind(tabs);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  tabs._reopenInContainer = async (...args) => { entered(); await gate; return reopen(...args); };
  const migration = service.setWorkspaceContainer(WSP_A, "firefox-container-1");
  await started;
  const switching = service.activateWsp(WSP_B, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  const activeBeforeRelease = world.record(WSP_B).active;
  release();
  await Promise.all([migration, switching]);
  assert.equal(activeBeforeRelease, false);
  assert.equal(service._activeCache.activeWspId, WSP_B);
  assert.equal(world.record(WSP_A).active, false);
});

test("repeated container changes settle on the last binding and live tabs", async t => {
  const { world, env, service } = await fixture(t);
  await Promise.all([service.setWorkspaceContainer(WSP_A, "firefox-container-1"), service.setWorkspaceContainer(WSP_A, "firefox-container-2")]);
  assert.equal(world.record(WSP_A).containerId, "firefox-container-2");
  assert.equal(service._activeCache.containerId, "firefox-container-2");
  assert.equal(world.record(WSP_A).tabs.length, 1);
  const tab = await env.browser.tabs.get(world.record(WSP_A).tabs[0]);
  assert.equal(tab.cookieStoreId, "firefox-container-2");
  assert.equal((await env.browser.tabs.query({})).filter(t => t.url === "https://a.test/").length, 1);
});

test("migration carries group identity to replacement tabs", async t => {
  const { world, env, service } = await fixture(t);
  const key = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  world.record(WSP_A).groups = [{ key, title: "Trading", color: "green", collapsed: false, tabs: [] }];
  await env.browser.sessions.setTabValue(1, "wspGroup", key);
  await service.setWorkspaceContainer(WSP_A, "firefox-container-1");
  const id = world.record(WSP_A).tabs[0];
  assert.equal(await env.browser.sessions.getTabValue(id, "wspGroup"), key);
  assert.equal(world.record(WSP_A).groups[0]?.title, "Trading");
});

test("migration keeps both live tabs when both close attempts fail", async t => {
  const { world, env, service } = await fixture(t);
  env.browser.tabs.remove = async () => { throw new Error("Close unavailable"); };
  await service.setWorkspaceContainer(WSP_A, "firefox-container-1");
  const owned = [...world.record(WSP_A).tabs];
  assert.equal(owned.length, 2);
  assert.ok(owned.includes(1));
  for (const id of owned) assert.equal(await env.browser.sessions.getTabValue(id, "wspId"), WSP_A);
});
