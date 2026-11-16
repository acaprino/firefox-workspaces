import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A } from "./helpers/world.mjs";

const URL = "https://example.test/shared";
const GROUP_KEY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTAINERS = [1, 6].map(n => ({
  cookieStoreId: `firefox-container-${n}`, name: `Container ${n}`, color: "blue", icon: "circle",
}));

async function fixture(t) {
  const world = makeWorld({
    tabs: [
      { id: 1, url: URL, active: true, cookieStoreId: "firefox-container-1" },
      { id: 2, url: URL, cookieStoreId: "firefox-container-6" },
      { id: 3, url: "https://example.test/other", cookieStoreId: "firefox-default" },
    ],
    containers: CONTAINERS,
    sessionValues: {
      1: { wspId: WSP_A, wspGroup: GROUP_KEY },
      2: { wspId: WSP_A, wspGroup: GROUP_KEY },
      3: { wspId: WSP_A },
    },
    storage: seedWorkspaces(1, [{
      id: WSP_A, name: "Home", active: true, tabs: [1, 2, 3],
      containerId: null, icon: "home", color: "#123456",
      groups: [{ key: GROUP_KEY, title: "Trading", color: "green", collapsed: false }],
      tabSnapshot: [URL, URL, "https://example.test/other"],
    }]),
  });
  const env = await world.boot();
  t.after(() => world.teardown());
  await world.idle();
  return { world, env };
}

test("changed group membership refreshes a snapshot even when URLs stay identical", async t => {
  const { world, env } = await fixture(t);
  const service = env.get("SnapshotService");
  service.DEBOUNCE_MS = 1;
  service.schedule(1, WSP_A);
  await env.settle(40);
  const before = structuredClone(world.record(WSP_A).recoverySnapshot);
  await env.browser.sessions.removeTabValue(2, "wspGroup");
  service.schedule(1, WSP_A);
  await env.settle(40);
  const after = world.record(WSP_A).recoverySnapshot;
  assert.equal(before.tabs[1].groupKey, GROUP_KEY);
  assert.equal(after.tabs[1].groupKey, null);
  assert.deepEqual([...after.tabs].map(t => t.url), [...before.tabs].map(t => t.url));
});

test("a snapshot capture finishing after recovery pauses cannot overwrite the saved evidence", async t => {
  const { world, env } = await fixture(t);
  const before = structuredClone(world.record(WSP_A));
  const query = env.browser.tabs.query;
  env.browser.tabs.query = async options => (await query(options)).map(tab =>
    tab.id === 1 ? { ...tab, url: "https://example.test/new" } : tab);
  const getValue = env.browser.sessions.getTabValue;
  let release;
  let signal;
  const entered = new Promise(resolve => { signal = resolve; });
  env.browser.sessions.getTabValue = async (id, key) => {
    if (id === 1 && key === "wspGroup") {
      await new Promise(resolve => { release = resolve; signal(); });
    }
    return getValue(id, key);
  };
  const service = env.get("SnapshotService");
  service.DEBOUNCE_MS = 1;
  service.schedule(1, WSP_A);
  await entered;
  env.get("Brainer")._state = "restoring";
  release();
  await env.settle(40);
  assert.deepEqual(world.record(WSP_A).tabSnapshot, before.tabSnapshot);
  assert.deepEqual(world.record(WSP_A).recoverySnapshot, before.recoverySnapshot);
});
