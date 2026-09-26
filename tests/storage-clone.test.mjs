// tests/storage-clone.test.mjs
// Harness fidelity (X-66): real storage.local structured-clones values in and
// out. The stub used to hand out live references, so two interleaved
// read-modify-writes both pushed into the SAME stored array and "composed"
// instead of the second overwriting the first. Every lost-update race was
// invisible and the lock discipline had no regression coverage. These tests
// pin the copy semantics and give each locked writer a concurrency check,
// plus a control run with the mutex bypassed to prove the checks can fail.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

// Window 1: workspace A (active) owns tabs 1 and 2, B owns hidden tab 3.
// `autoEvents: false` unless a scenario wants the event-driven path: the
// writers are called directly, so onCreated must not file the tabs a
// second time behind the test's back.
async function boot(opts = {}) {
  const world = makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 2, url: "https://a.test/2" },
      { id: 3, url: "https://b.test/1", hidden: true },
    ],
    sessionValues: { 1: WSP_A, 2: WSP_A, 3: WSP_B },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1, 2] },
      { id: WSP_B, name: "B", tabs: [3] },
    ]),
    autoEvents: false,
    ...opts,
  });
  const env = await world.boot();
  assert.equal(env.get("Brainer")._state, "ready");
  return { world, env };
}

// A background tab that exists in the browser but that no listener has
// filed yet (autoEvents off).
const newTab = (world, id) => world.openTab({ url: `https://a.test/${id}`, active: false });

test("storage.local.get returns copies: mutating a result never reaches storage", async () => {
  const { browser, storageData } = loadBackend({ storageData: { k: { tabs: [1] } } });
  const one = await browser.storage.local.get("k");
  one.k.tabs.push(2);
  const all = await browser.storage.local.get(null);
  all.k.tabs.push(3);
  const withDefault = await browser.storage.local.get({ k: null, missing: [] });
  withDefault.k.tabs.push(4);
  assert.deepEqual(storageData.k.tabs, [1]);
  assert.deepEqual(withDefault.missing, [], "object form returns defaults for missing keys");
});

test("storage.local.set stores a copy: mutating the argument afterwards changes nothing", async () => {
  const { browser, storageData } = loadBackend();
  const value = { tabs: [1] };
  const pending = browser.storage.local.set({ k: value });
  value.tabs.push(2); // even before the promise settles
  await pending;
  value.tabs.push(3);
  assert.deepEqual(storageData.k.tabs, [1]);
  await assert.rejects(browser.storage.local.set({ f: () => {} }), /could not be cloned/i,
    "non-cloneable values are rejected, as in Firefox");
});

test("an unlocked read-modify-write loses a concurrent update (the harness can see the race)", async (t) => {
  const { world, env } = await boot();
  t.after(() => world.teardown());
  const WSPStorageManager = env.get("WSPStorageManager");
  const unlockedAdd = async (tabId) => {
    const wsp = await WSPStorageManager.getWorkspace(WSP_B);
    wsp.tabs.push(tabId);
    await wsp._saveState();
  };
  await Promise.all([unlockedAdd(11), unlockedAdd(12)]);
  const tabs = world.record(WSP_B).tabs;
  assert.equal(tabs.length, 2, `one of the two pushes is overwritten, got ${JSON.stringify(tabs)}`);
});

// Each scenario runs concurrent writers against one record and reports what
// should have survived vs what did.
const SCENARIOS = [
  {
    name: "TabService.addTabToWorkspace (workspace lock)",
    async run(world, env) {
      const tabs = [11, 12, 13, 14, 15].map(i => newTab(world, i));
      await Promise.all(tabs.map(tab => env.get("TabService").addTabToWorkspace(tab)));
      return { expected: [1, 2, ...tabs.map(tab => tab.id)], actual: world.record(WSP_A).tabs };
    },
  },
  {
    name: "tabs opened back to back, filed by the onCreated listener (workspace lock)",
    opts: { autoEvents: true, storageLatencyMs: 1 },
    async run(world) {
      const tabs = [11, 12, 13, 14].map(i => newTab(world, i));
      await world.idle();
      return { expected: [1, 2, ...tabs.map(tab => tab.id)], actual: world.record(WSP_A).tabs };
    },
  },
  {
    name: "addTabToWorkspace vs removeTabFromWorkspace (workspace lock)",
    async run(world, env) {
      const tab = newTab(world, 20);
      const TabService = env.get("TabService");
      await Promise.all([TabService.addTabToWorkspace(tab), TabService.removeTabFromWorkspace(1, 2)]);
      return { expected: [1, tab.id], actual: world.record(WSP_A).tabs };
    },
  },
  {
    name: "Workspace.rename of two different fields (workspace lock)",
    async run(world, env) {
      const Workspace = env.get("Workspace");
      await Promise.all([Workspace.rename(WSP_A, { name: "Renamed" }), Workspace.rename(WSP_A, { color: "red" })]);
      const rec = world.record(WSP_A);
      return { expected: ["Renamed", "red"], actual: [rec.name, rec.color] };
    },
  },
  {
    name: "WSPStorageManager.addWsp (window-index lock)",
    async run(world, env) {
      const ids = ["w1", "w2", "w3", "w4"];
      await Promise.all(ids.map(id => env.get("WSPStorageManager").addWsp(id, 7)));
      return { expected: ids, actual: world.storage["ld-wsp-window-7"] };
    },
  },
  {
    name: "WSPStorageManager.saveClosedTab (closed-tab lock)",
    async run(world, env) {
      const urls = ["https://c/1", "https://c/2", "https://c/3", "https://c/4"];
      await Promise.all(urls.map((url, i) => env.get("WSPStorageManager").saveClosedTab(WSP_A, { url, closedAt: i })));
      return { expected: urls, actual: world.storage[`ld-wsp-closed-${WSP_A}`].map(e => e.url) };
    },
  },
];

const sorted = (list) => [...list].map(String).sort();

for (const s of SCENARIOS) {
  test(`concurrent writers keep every update: ${s.name}`, async (t) => {
    const { world, env } = await boot(s.opts);
    t.after(() => world.teardown());
    const { expected, actual } = await s.run(world, env);
    assert.deepEqual(sorted(actual), sorted(expected));
  });
}

test("control: with the storage mutex bypassed every scenario above loses an update", async (t) => {
  for (const s of SCENARIOS) {
    const { world, env } = await boot(s.opts);
    t.after(() => world.teardown());
    // Turn every keyed lock into a pass-through: the writers still
    // read-modify-write, just without serialization.
    env.get("_storageMutex").run = async (key, fn) => fn();
    const { expected, actual } = await s.run(world, env);
    assert.notDeepEqual(sorted(actual), sorted(expected),
      `${s.name}: expected a lost update without the lock, got ${JSON.stringify(actual)}`);
  }
});
