// tests/tab-close-tracking.test.mjs
// What a tab close records and costs: the tab-info cache that feeds the
// per-workspace "recently closed" list (X-31), closes of whole tab groups
// (X-92), closes of hidden tabs in other workspaces (X-106), and the work
// each close does (X-27).
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const closedKey = (id) => `ld-wsp-closed-${id}`;

test("X-31: the tab-info cache keeps long-lived tabs of a large window and drops closed tabs of any window", async () => {
  const { get, browser, settle } = loadBackend({
    storageData: seedWorkspaces(1, [{ id: WSP_A, name: "A", active: true, tabs: [] }]),
  });
  await settle();
  const TabService = get("TabService");
  TabService._tabInfoCache.clear();

  // 600 tabs cached at startup, oldest first: the first ones must survive.
  for (let id = 1; id <= 600; id++) TabService.cacheTabInfo({ id, url: `https://t.test/${id}`, title: `t${id}` });
  assert.ok(TabService._tabInfoCache.has(1), "the oldest live tab is still cached");

  // A tab of another window closes: its entry goes, although the listener
  // ignores the close otherwise.
  TabService.cacheTabInfo({ id: 900, windowId: 2, url: "https://other.test/" });
  await browser.tabs.onRemoved._listeners[0](900, { windowId: 2, isWindowClosing: false });
  assert.equal(TabService._tabInfoCache.has(900), false, "no dead entry left behind");

  // At the memory bound, the least recently UPDATED entry goes first.
  TabService._tabInfoCache.clear();
  TabService._TAB_INFO_CACHE_MAX = 3;
  for (const id of [1, 2, 3]) TabService.cacheTabInfo({ id, url: `https://t.test/${id}` });
  TabService.cacheTabInfo({ id: 1, url: "https://t.test/1b" }); // tab 1 navigates
  TabService.cacheTabInfo({ id: 4, url: "https://t.test/4" });
  assert.deepEqual([...TabService._tabInfoCache.keys()], [3, 1, 4]);
});

// A active: tabs 1..6, tabs 2, 3, 4 in group 900 and 5, 6 in group 901.
function groupedWorld() {
  return makeWorld({
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 2, url: "https://trip.test/2", groupId: 900 },
      { id: 3, url: "https://trip.test/3", groupId: 900 },
      { id: 4, url: "https://trip.test/4", groupId: 900 },
      { id: 5, url: "https://news.test/5", groupId: 901 },
      { id: 6, url: "https://news.test/6", groupId: 901 },
      { id: 10, url: "https://b.test/10", hidden: true },
    ],
    sessionValues: { 1: WSP_A, 2: WSP_A, 3: WSP_A, 4: WSP_A, 5: WSP_A, 6: WSP_A, 10: WSP_B },
    storage: {
      ...seedWorkspaces(1, [
        { id: WSP_A, name: "A", active: true, tabs: [1, 2, 3, 4, 5, 6] },
        { id: WSP_B, name: "B", tabs: [10] },
      ]),
      [closedKey(WSP_A)]: Array.from({ length: 25 }, (_, i) => ({
        url: `https://earlier.test/${i}`, title: `e${i}`, favIconUrl: "", closedAt: 1000 + i,
      })),
    },
  });
}

test("X-92: closing a whole tab group records no per-tab entries; a tab closed out of a group still does", async (t) => {
  const world = groupedWorld();
  const env = await world.boot();
  t.after(() => world.teardown());
  const TabService = env.get("TabService");
  TabService._GROUP_CLOSE_WAIT_MS = 30;

  // "Save and close group": every tab of group 900 closes, then the group.
  await env.browser.tabs.remove([2, 3, 4]);
  await world.idle();
  await delay(80);
  const urls = () => world.storage[closedKey(WSP_A)].map((e) => e.url);
  assert.equal(urls().filter((u) => u.startsWith("https://trip.test/")).length, 0,
    "Firefox keeps the closed group; the workspace list is not flooded with its tabs");
  assert.equal(urls().filter((u) => u.startsWith("https://earlier.test/")).length, 25,
    "earlier closures are not pushed out");

  // One tab closed out of group 901, which lives on: recorded after the wait.
  world.closeTab(5);
  await world.idle();
  await delay(80);
  assert.equal(urls()[0], "https://news.test/5");
  assert.deepEqual(world.record(WSP_A).tabs, [1, 6]);
});

test("X-92: a group emptied by the extension's own workspace switch keeps its closed-tab entries", async (t) => {
  const world = groupedWorld();
  const env = await world.boot();
  t.after(() => world.teardown());
  const TabService = env.get("TabService");
  TabService._GROUP_CLOSE_WAIT_MS = 5000;

  world.closeTab(5); // group 901 lives on with tab 6
  await world.idle();
  // Switching away hides and ungroups A's tabs: group 901 is emptied and
  // removed right away, before the wait expires.
  await env.get("WorkspaceService").activateWsp(WSP_B, 1);
  await world.idle();
  await delay(20);
  assert.equal(world.storage[closedKey(WSP_A)][0].url, "https://news.test/5");
});

test("X-106: a hidden tab of another workspace closed by Firefox (Close Duplicate Tabs) is flagged", async (t) => {
  const world = groupedWorld();
  await world.boot();
  t.after(() => world.teardown());

  world.closeTab(10); // B's hidden tab, e.g. a duplicate of one in A
  world.closeTab(1);
  await world.idle();
  const [bEntry] = world.storage[closedKey(WSP_B)];
  assert.equal(bEntry.url, "https://b.test/10");
  assert.equal(bEntry.closedWhileHidden, true);
  const [aEntry] = world.storage[closedKey(WSP_A)];
  assert.equal(aEntry.url, "https://a.test/1");
  assert.equal(aEntry.closedWhileHidden, undefined, "an ordinary close is not flagged");
  assert.deepEqual(world.record(WSP_B).tabs, []);
});

test("X-27: a close reads the workspace list once and repaints the toolbar only for the active workspace", async (t) => {
  const world = groupedWorld();
  const env = await world.boot();
  t.after(() => world.teardown());
  // Warm active cache, as after any switch: the repaint's own lookup is
  // then a single-record read, not a list read.
  env.get("WorkspaceService")._updateActiveCache(1, world.record(WSP_A).tabs, WSP_A, null);
  const local = env.browser.storage.local;
  const origGet = local.get;
  let listReads = 0;
  local.get = async (keys) => {
    if ([].concat(keys ?? []).includes("ld-wsp-window-1")) listReads++;
    return origGet(keys);
  };
  let paints = 0;
  env.browser.browserAction.setBadgeText = async () => { paints++; };
  // The menu rebuild is debounced (one per burst, not per tab): not counted.
  const MenuService = env.get("MenuService");
  clearTimeout(MenuService._refreshTimer);
  MenuService.refreshTabMenu = async () => {};

  world.closeTab(10); // hidden tab of inactive B
  await world.idle();
  await delay(80);
  assert.equal(listReads, 1, "one workspace-list read per close");
  assert.equal(paints, 0, "B's tab count is not on the badge: no repaint");

  listReads = 0;
  await env.browser.tabs.remove([5, 6, 4]); // "Close tabs to the right" in A
  await world.idle();
  await delay(80);
  assert.equal(listReads, 3, "still one read per closed tab");
  assert.equal(paints, 1, "a burst of closes repaints once");
  assert.deepEqual(world.record(WSP_A).tabs, [1, 2, 3]);
});
