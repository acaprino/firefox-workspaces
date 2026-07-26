// tests/container-binding.test.mjs
// Regression: a newly created container-bound workspace must not have its tabs
// yanked into the container of the workspace that was active before it.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

process.on("unhandledRejection", () => {});

const WSP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTAINERS = [
  { cookieStoreId: "firefox-container-1", name: "Work", colorCode: "#f00" },
  { cookieStoreId: "firefox-container-2", name: "Personal", colorCode: "#0f0" },
];

// Window 1 holds one active workspace bound to container 1, with one tab in it.
function alphaStorage() {
  return {
    "ld-wsp-window-1": [WSP_A],
    "ld-wsp-order-1": [WSP_A],
    [`ld-wsp-${WSP_A}`]: {
      id: WSP_A, name: "Alpha", icon: "", active: true, tabs: [1], groups: [],
      windowId: 1, containerId: "firefox-container-1", tabSnapshot: ["https://alpha.test/"],
    },
  };
}

// Live tab table so tabs.create/get/remove behave like the real browser
// (_reopenInContainer creates then removes, and callers re-fetch by id).
function makeWorld() {
  const tabs = new Map([[1, {
    id: 1, windowId: 1, cookieStoreId: "firefox-container-1",
    url: "https://alpha.test/", pinned: false, hidden: false, active: true,
  }]]);
  const created = [];
  let seq = 100;
  const overrides = {
    tabs: {
      query: async ({ windowId, pinned, active } = {}) => [...tabs.values()].filter(t =>
        (windowId == null || t.windowId === windowId)
        && (pinned == null || t.pinned === pinned)
        && (active == null || t.active === active)),
      get: async (id) => {
        const t = tabs.get(id);
        if (!t) throw new Error("no tab " + id);
        return t;
      },
      create: async (opts) => {
        const tab = { id: ++seq, windowId: 1, pinned: false, hidden: false, url: "about:newtab", ...opts };
        tabs.set(tab.id, tab);
        created.push(tab);
        return tab;
      },
      remove: async (ids) => { for (const id of [].concat(ids)) tabs.delete(id); },
      update: async (id, props) => Object.assign(tabs.get(id) ?? {}, props),
    },
    contextualIdentities: {
      query: async () => CONTAINERS,
      get: async (id) => {
        const c = CONTAINERS.find(x => x.cookieStoreId === id);
        if (!c) throw new Error("no container " + id);
        return c;
      },
    },
  };
  return { tabs, created, overrides };
}

test("new workspace's tab is not pulled into the previously active container", async () => {
  const { tabs, created, overrides } = makeWorld();
  const { get, settle, storageData } = loadBackend({ storageData: alphaStorage(), overrides });
  await settle();

  const WorkspaceService = get("WorkspaceService");
  const TabService = get("TabService");
  // State left behind by a real activation of Alpha (activateWsp is the only
  // place that primes this cache).
  WorkspaceService._updateActiveCache(1, [1], WSP_A, "firefox-container-1");

  const { tabId, wspId } = await WorkspaceService.createWorkspaceWithTab({
    name: "Beta", icon: "", color: null, active: true,
    tabs: [], windowId: 1, containerId: "firefox-container-2",
  });
  assert.equal(tabs.get(tabId).cookieStoreId, "firefox-container-2",
    "initial tab opened in the requested container");

  // The user navigates that tab: tabs.onUpdated -> navigation-time enforcement.
  await TabService.forceTabIntoActiveContainer(tabs.get(tabId), "https://example.test/");

  assert.deepEqual(created.filter(t => t.cookieStoreId === "firefox-container-1"), [],
    "nothing was reopened in the previous workspace's container");
  assert.ok(storageData[`ld-wsp-${wspId}`].tabs.includes(tabId),
    "tab stayed in the workspace that was created for it");
  assert.ok(!storageData[`ld-wsp-${WSP_A}`].tabs.includes(tabId),
    "tab was not stolen by the previously active workspace");
});

test("a cache that no longer describes the tab's workspace is dropped, not extended", async () => {
  const { overrides } = makeWorld();
  const { get, settle } = loadBackend({ storageData: alphaStorage(), overrides });
  await settle();

  const WorkspaceService = get("WorkspaceService");
  WorkspaceService._updateActiveCache(1, [1], WSP_A, "firefox-container-1");
  WorkspaceService.addTabToActiveCache(7, WSP_A);
  assert.ok(WorkspaceService._activeCache.tabIds.has(7), "own tab is cached");

  WorkspaceService.addTabToActiveCache(8, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(WorkspaceService._activeCache, null,
    "foreign tab invalidates the cache instead of being claimed by it");
});

test("creating a workspace re-points the active cache at it", async () => {
  const { overrides } = makeWorld();
  const { get, settle } = loadBackend({ storageData: alphaStorage(), overrides });
  await settle();

  const WorkspaceService = get("WorkspaceService");
  WorkspaceService._updateActiveCache(1, [1], WSP_A, "firefox-container-1");

  const { wspId } = await WorkspaceService.createWorkspaceWithTab({
    name: "Beta", icon: "", color: null, active: true,
    tabs: [], windowId: 1, containerId: "firefox-container-2",
  });

  assert.equal(WorkspaceService._activeCache.activeWspId, wspId, "cache points at the new workspace");
  assert.equal(WorkspaceService._activeCache.containerId, "firefox-container-2",
    "cache carries the new workspace's container");
});
