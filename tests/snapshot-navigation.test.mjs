// Regression: navigation and late session-tagged tabs must keep recovery
// snapshots current even before the active-workspace cache has been warmed.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

const WSP_A = "11111111-1111-4111-8111-111111111111";
const WSP_B = "22222222-2222-4222-8222-222222222222";

async function fixture(t) {
  const tabs = [
    { id: 1, windowId: 1, url: "https://example.test/active-before", pinned: false, hidden: false, active: true },
    { id: 2, windowId: 1, url: "https://example.test/inactive-before", pinned: false, hidden: true, active: false },
  ];
  const env = loadBackend({
    storageData: {
      "primary-window-id": 1,
      "ld-wsp-window-1": [WSP_A, WSP_B],
      "ld-wsp-order-1": [WSP_A, WSP_B],
      [`ld-wsp-${WSP_A}`]: {
        id: WSP_A, name: "Active", active: true, windowId: 1,
        tabs: [1], groups: [], tabSnapshot: ["chrome://browser/content/blanktab.html"],
      },
      [`ld-wsp-${WSP_B}`]: {
        id: WSP_B, name: "Inactive", active: false, windowId: 1,
        tabs: [2], groups: [], tabSnapshot: ["https://example.test/inactive-before"],
      },
    },
    overrides: {
      storage: { session: { get: async () => ({ "wsp-session-alive": true }), set: async () => {} } },
      tabs: {
        query: async (query = {}) => tabs.filter(tab =>
          (query.windowId == null || tab.windowId === query.windowId)
          && (query.pinned == null || tab.pinned === query.pinned)
          && (query.hidden == null || tab.hidden === query.hidden)),
        get: async id => {
          const tab = tabs.find(tab => tab.id === id);
          if (!tab) throw new Error("No tab");
          return { ...tab };
        },
      },
      sessions: { getTabValue: async id => id === 1 ? WSP_A : WSP_B },
    },
  });
  await env.settle();
  assert.equal(env.get("Brainer")._state, "ready");
  // Firefox storage reads/writes clone records. Match that behavior so two
  // unlocked readers cannot accidentally share the same tabs array in tests.
  const originalGet = env.browser.storage.local.get;
  const originalSet = env.browser.storage.local.set;
  env.browser.storage.local.get = async keys => structuredClone(await originalGet(keys));
  env.browser.storage.local.set = async data => originalSet(structuredClone(data));
  const tabService = env.get("TabService");
  tabService._SNAPSHOT_DEBOUNCE_MS = 1;
  t.after(() => {
    for (const timer of tabService._snapshotTimers.values()) clearTimeout(timer);
    clearTimeout(env.get("WorkspaceService")._lastActiveTimer);
  });
  return { ...env, tabs };
}

async function navigate(env, tabId, url) {
  const tab = env.tabs.find(tab => tab.id === tabId);
  tab.url = url;
  // The first URL listener owns cache and snapshot maintenance. Other URL
  // listeners enforce containers, a separate behavior covered elsewhere.
  await env.browser.tabs.onUpdated._listeners[0](tabId, { url }, { ...tab });
  await env.settle();
}

test("active navigation refreshes a startup snapshot while the active cache is cold", async t => {
  const env = await fixture(t);
  env.get("WorkspaceService")._activeCache = null;
  assert.equal(env.get("WorkspaceService")._activeCache, null);

  await navigate(env, 1, "https://example.test/active-after");

  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_A}`].tabSnapshot],
    ["https://example.test/active-after"]);
});

test("active navigation refreshes snapshots when a stale cache omits the tab", async t => {
  const env = await fixture(t);
  env.get("WorkspaceService")._updateActiveCache(1, [], WSP_A);

  await navigate(env, 1, "https://example.test/active-after");

  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_A}`].tabSnapshot],
    ["https://example.test/active-after"]);
});

test("inactive navigation refreshes its owning workspace snapshot", async t => {
  const env = await fixture(t);
  env.get("WorkspaceService")._updateActiveCache(1, [1], WSP_A);

  await navigate(env, 2, "https://example.test/inactive-after");

  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_B}`].tabSnapshot],
    ["https://example.test/inactive-after"]);
});

test("a URL lookup finishing during restore leaves its saved snapshot untouched", async t => {
  const env = await fixture(t);
  env.get("WorkspaceService")._activeCache = null;
  const savedSnapshot = [...env.storageData[`ld-wsp-${WSP_A}`].tabSnapshot];
  const originalGet = env.browser.storage.local.get;
  let release;
  env.browser.storage.local.get = async keys => {
    if (keys === "ld-wsp-window-1") await new Promise(resolve => { release = resolve; });
    return originalGet(keys);
  };
  const tab = env.tabs[0];
  tab.url = "https://example.test/active-after";
  const navigation = env.browser.tabs.onUpdated._listeners[0](1, { url: tab.url }, { ...tab });
  await env.settle();
  assert.equal(typeof release, "function", "owner lookup is in flight before restore starts");
  env.get("Brainer")._state = "restoring";
  release();
  await navigation;
  await env.settle();

  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_A}`].tabSnapshot],
    savedSnapshot);
});

test("concurrent session-tagged additions retain both tabs in their workspace snapshot", async t => {
  const env = await fixture(t);
  const added = [
    { id: 3, windowId: 1, url: "https://example.test/late-one", pinned: false, hidden: false, active: false },
    { id: 4, windowId: 1, url: "https://example.test/late-two", pinned: false, hidden: false, active: false },
  ];
  env.tabs.push(...added);

  await Promise.all(added.map(tab => env.get("TabService").addTabToWorkspace(tab)));
  await env.settle();

  const workspace = env.storageData[`ld-wsp-${WSP_B}`];
  assert.deepEqual([...workspace.tabs], [2, 3, 4]);
  assert.deepEqual([...workspace.tabSnapshot], [
    "https://example.test/inactive-before", "https://example.test/late-one", "https://example.test/late-two",
  ]);
});

test("a session-tagged tab cannot recreate a workspace destroyed during its lookup", async t => {
  const env = await fixture(t);
  const added = { id: 3, windowId: 1, url: "https://example.test/late", pinned: false, hidden: false, active: false };
  env.tabs.push(added);
  env.browser.sessions.getTabValue = async () => {
    delete env.storageData[`ld-wsp-${WSP_B}`];
    env.storageData["ld-wsp-window-1"] = [WSP_A];
    env.storageData["ld-wsp-order-1"] = [WSP_A];
    return WSP_B;
  };

  await env.get("TabService").addTabToWorkspace(added);

  assert.equal(env.storageData[`ld-wsp-${WSP_B}`], undefined);
});
