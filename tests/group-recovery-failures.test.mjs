import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B } from "./helpers/world.mjs";

const KEY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function fixture(t) {
  const world = makeWorld({
    tabs: [{ id: 1, url: "https://a.test/", active: true }, { id: 2, url: "https://b.test/", hidden: true }],
    sessionValues: { 1: WSP_A, 2: { wspId: WSP_B, wspGroup: KEY } },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1] },
      { id: WSP_B, name: "B", tabs: [2], tabSnapshot: ["https://b.test/"],
        groups: [{ key: KEY, title: "Hidden group", color: "green", collapsed: false }] },
    ]),
  });
  const env = await world.boot(); t.after(() => world.teardown()); await world.idle();
  return { world, env };
}

test("a failed group membership read preserves a hidden group and the next export succeeds", async t => {
  const { world, env } = await fixture(t);
  const before = structuredClone(world.record(WSP_B));
  const get = env.browser.sessions.getTabValue;
  let failed = false;
  env.browser.sessions.getTabValue = async (id, key) => {
    if (id === 2 && key === "wspGroup" && !failed) {
      failed = true;
      throw new Error("Transient group read failure");
    }
    return get(id, key);
  };
  const workspace = await env.get("WSPStorageManager").getWorkspace(WSP_B);
  await assert.rejects(workspace.updateTabGroups(), /Transient group read failure/);
  assert.deepEqual(world.record(WSP_B).groups, before.groups);
  assert.deepEqual(world.record(WSP_B).recoverySnapshot, before.recoverySnapshot);
  const result = await env.get("SnapshotService").capture([await env.browser.tabs.get(2)], workspace.groups);
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0].groupKey, KEY);
});

test("failed group membership writes preserve the saved group until a healthy retry", async t => {
  const { world, env } = await fixture(t);
  const before = structuredClone(world.record(WSP_B));
  await env.browser.sessions.removeTabValue(2, "wspGroup");
  const query = env.browser.tabs.query;
  env.browser.tabs.query = async options => (await query(options)).map(tab =>
    tab.id === 2 ? { ...tab, groupId: 7 } : tab);
  env.browser.tabGroups.query = async () => [{ id: 7, title: "Changed", color: "red", collapsed: true }];
  const set = env.browser.sessions.setTabValue;
  env.browser.sessions.setTabValue = async () => { throw new Error("Group write failed"); };
  const workspace = await env.get("WSPStorageManager").getWorkspace(WSP_B);
  await assert.rejects(workspace.updateTabGroups(), /Group write failed/);
  assert.deepEqual(world.record(WSP_B).groups, before.groups);
  assert.deepEqual(world.record(WSP_B).recoverySnapshot, before.recoverySnapshot);
  env.browser.sessions.setTabValue = set;
  await workspace.updateTabGroups();
  assert.equal(world.record(WSP_B).groups[0].title, "Changed");
  assert.equal(world.record(WSP_B).recoverySnapshot.tabs[0].groupKey, world.record(WSP_B).groups[0].key);
});

test("a failed obsolete membership clear leaves the saved group and snapshot intact", async t => {
  const { world, env } = await fixture(t);
  const service = env.get("TabService");
  const extra = await service.withReopenGuard(() => env.browser.tabs.create({
    windowId: 1, url: "https://b.test/extra", active: false,
  }));
  const nativeMember = await service.withReopenGuard(() => env.browser.tabs.create({
    windowId: 1, url: "https://b.test/native", active: false,
  }));
  await service.setTabSessionValue(extra.id, WSP_B);
  await service.setGroupTag(extra.id, KEY);
  await service.setTabSessionValue(nativeMember.id, WSP_B);
  await service.setGroupTag(nativeMember.id, KEY);
  const storage = env.get("WSPStorageManager");
  await storage.mutateWorkspace(WSP_B, wsp => { wsp.tabs.push(extra.id, nativeMember.id); });
  const workspace = await storage.getWorkspace(WSP_B);
  const before = structuredClone(world.record(WSP_B));
  const query = env.browser.tabs.query;
  env.browser.tabs.query = async options => (await query(options)).map(tab =>
    tab.id === 2 || tab.id === nativeMember.id ? { ...tab, groupId: 7 } : tab);
  env.browser.tabGroups.query = async () => [{ id: 7, title: "Changed", color: "red", collapsed: true }];
  env.browser.sessions.removeTabValue = async () => { throw new Error("Group clear failed"); };
  await assert.rejects(workspace.updateTabGroups(), /Group clear failed/);
  assert.deepEqual(world.record(WSP_B).groups, before.groups);
  assert.deepEqual(world.record(WSP_B).recoverySnapshot, before.recoverySnapshot);
});
