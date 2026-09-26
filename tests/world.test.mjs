// tests/world.test.mjs
// Self-test for tests/helpers/world.mjs: the stateful browser model must
// follow the Firefox rules the scenario tests rely on, or those tests prove
// nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, wspRecord, WSP_A, WSP_B } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

// Boot the real backend on a world and record every event it receives
// through extra listeners on the same event objects.
async function bootWithLog(opts) {
  const world = makeWorld(opts);
  const env = await world.boot();
  const log = [];
  const names = ["onCreated", "onActivated", "onRemoved", "onUpdated", "onMoved", "onAttached", "onDetached"];
  for (const n of names) env.browser.tabs[n].addListener((...args) => { log.push([`tabs.${n}`, ...args]); });
  for (const n of ["onCreated", "onRemoved", "onFocusChanged"]) {
    env.browser.windows[n].addListener((...args) => { log.push([`windows.${n}`, ...args]); });
  }
  await world.idle();
  log.length = 0;
  return { world, env, log, names: () => log.map((e) => e[0]) };
}

const BASE_TABS = [
  { id: 1, url: "https://a.test/1", active: true },
  { id: 2, url: "https://a.test/2" },
  { id: 3, url: "https://b.test/1", hidden: true },
  { id: 4, url: "https://pinned.test/", pinned: true },
];

function baseStorage() {
  return seedWorkspaces(1, [
    { id: WSP_A, name: "A", active: true, tabs: [1, 2] },
    { id: WSP_B, name: "B", tabs: [3] },
  ]);
}

test("tabs.hide skips active, pinned, hidden and sharing tabs and returns what it hid", async (t) => {
  const { world, env } = await bootWithLog({ tabs: [...BASE_TABS, { id: 5, url: "https://call.test/" }], storage: baseStorage() });
  t.after(() => world.teardown());
  world.setSharing(5, true);
  const hidden = await env.browser.tabs.hide([1, 2, 3, 4, 5]);
  assert.deepEqual(hidden, [2], "only the plain background tab is hidden");
  assert.equal(world.tab(1).hidden, false, "active tab refused");
  assert.equal(world.tab(4).hidden, false, "pinned tab refused");
  assert.equal(world.tab(5).hidden, false, "sharing tab refused");
});

test("an invalid id rejects the whole show/hide/remove call before anything changes", async (t) => {
  const { world, env } = await bootWithLog({ tabs: BASE_TABS, storage: baseStorage() });
  t.after(() => world.teardown());
  await assert.rejects(env.browser.tabs.hide([2, 999]), /Invalid tab ID: 999/);
  assert.equal(world.tab(2).hidden, false);
  await assert.rejects(env.browser.tabs.show([3, 999]), /Invalid tab ID: 999/);
  assert.equal(world.tab(3).hidden, true);
  await assert.rejects(env.browser.tabs.remove([2, 999]), /Invalid tab ID: 999/);
  assert.ok(world.tab(2), "tab 2 still open");
});

test("indexes are per-window positions with pinned tabs first; move respects the pinned boundary", async (t) => {
  const { world, env, log } = await bootWithLog({ tabs: BASE_TABS, storage: baseStorage() });
  t.after(() => world.teardown());
  assert.deepEqual(world.order(1), [4, 1, 2, 3], "seeded pinned tab sorted to the front");
  assert.deepEqual((await env.browser.tabs.query({ windowId: 1 })).map((x) => x.index), [0, 1, 2, 3]);
  await env.browser.tabs.move(3, { index: 1 });
  assert.deepEqual(world.order(1), [4, 3, 1, 2]);
  await env.browser.tabs.move(1, { index: 0 }); // across the pinned boundary: ignored
  assert.deepEqual(world.order(1), [4, 3, 1, 2]);
  await world.idle();
  assert.deepEqual(log.filter((e) => e[0] === "tabs.onMoved").map((e) => [e[1], e[2].fromIndex, e[2].toIndex]), [[3, 3, 1]]);
});

test("selecting a hidden tab shows it before onActivated and clears the multiselection", async (t) => {
  const { world, env, log, names } = await bootWithLog({ tabs: BASE_TABS, storage: baseStorage() });
  t.after(() => world.teardown());
  world.multiselect([2]);
  assert.equal(world.tab(2).highlighted, true);
  await env.browser.tabs.update(3, { active: true });
  assert.equal(world.tab(3).hidden, false);
  assert.equal(world.tab(2).highlighted, false, "multiselection cleared by the selection change");
  await world.idle();
  const shown = log.findIndex((e) => e[0] === "tabs.onUpdated" && e[1] === 3 && e[2].hidden === false);
  const activated = log.findIndex((e) => e[0] === "tabs.onActivated" && e[1].tabId === 3);
  assert.ok(shown !== -1 && activated !== -1 && shown < activated, `order: ${names().join(",")}`);
  assert.equal(log[activated][1].previousTabId, 1);
});

test("closing the selected tab selects the next visible tab, skipping hidden ones", async (t) => {
  const { world, log } = await bootWithLog({
    tabs: [
      { id: 1, url: "https://a.test/1" },
      { id: 2, url: "https://a.test/2", active: true },
      { id: 3, url: "https://b.test/1", hidden: true },
    ],
    storage: baseStorage(),
  });
  t.after(() => world.teardown());
  world.closeTab(2);
  assert.equal(world.activeTabId(1), 1, "no visible tab to the right: falls back to the left");
  await world.idle();
  const removed = log.findIndex((e) => e[0] === "tabs.onRemoved" && e[1] === 2);
  const activated = log.findIndex((e) => e[0] === "tabs.onActivated" && e[1].tabId === 1);
  assert.ok(removed < activated, "onRemoved precedes onActivated");
  assert.equal(log[activated][1].previousTabId, undefined, "closed previous tab is not reported");
});

test("closing the last visible tab closes the window and every hidden tab in it", async (t) => {
  const { world, log } = await bootWithLog({
    tabs: [{ id: 1, url: "https://a.test/1", active: true }, { id: 3, url: "https://b.test/1", hidden: true }],
    storage: baseStorage(),
  });
  t.after(() => world.teardown());
  world.closeTab(1);
  assert.equal(world.windows.size, 0);
  assert.equal(world.tab(3), undefined, "hidden tab closed with the window");
  await world.idle();
  const removed = log.filter((e) => e[0] === "tabs.onRemoved");
  assert.deepEqual(removed.map((e) => [e[1], e[2].isWindowClosing]), [[1, true], [3, true]]);
  assert.ok(log.some((e) => e[0] === "windows.onRemoved" && e[1] === 1));
  assert.ok(world.closed[0].window, "recorded as a recently closed window");
});

test("with closeWindowWithLastTab off, a new tab replaces the last visible one", async (t) => {
  const { world } = await bootWithLog({
    tabs: [{ id: 1, url: "https://a.test/1", active: true }, { id: 3, url: "https://b.test/1", hidden: true }],
    storage: baseStorage(), closeWindowWithLastTab: false,
  });
  t.after(() => world.teardown());
  world.closeTab(1);
  assert.equal(world.windows.size, 1);
  const [fresh] = world.visible(1);
  assert.equal(world.tab(fresh).url, "about:newtab");
  assert.equal(world.activeTabId(1), fresh);
  assert.equal(world.tab(3).hidden, true);
});

test("session values follow a tab across windows and come back on undo close under a new id", async (t) => {
  const { world, env, log } = await bootWithLog({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [...BASE_TABS, { id: 10, windowId: 2, url: "https://w2.test/", active: true }],
    sessionValues: { 1: WSP_A, 2: WSP_A, 3: WSP_B },
    storage: baseStorage(),
  });
  t.after(() => world.teardown());
  await env.browser.tabs.move(3, { windowId: 2, index: -1 });
  assert.equal(world.tab(3).windowId, 2);
  assert.equal(world.tab(3).hidden, false, "adopted tab arrives visible");
  assert.equal(await env.browser.sessions.getTabValue(3, "wspId"), WSP_B);
  await world.idle();
  const names = log.map((e) => e[0]);
  assert.ok(names.indexOf("tabs.onDetached") < names.indexOf("tabs.onAttached"));
  assert.ok(!names.includes("tabs.onRemoved") && !names.includes("tabs.onCreated"), "a move is not a close/open");

  world.closeTab(2);
  await assert.rejects(env.browser.sessions.getTabValue(2, "wspId"), /Invalid tab ID: 2/);
  const [recent] = await env.browser.sessions.getRecentlyClosed();
  assert.equal(recent.tab.url, "https://a.test/2");
  assert.equal(recent.tab.id, undefined, "closed tabs carry a sessionId, not an id");
  const restored = await env.browser.sessions.restore(recent.tab.sessionId);
  assert.notEqual(restored.tab.id, 2, "undo close yields a new tab id");
  assert.equal(await env.browser.sessions.getTabValue(restored.tab.id, "wspId"), WSP_A);
  assert.equal(world.activeTabId(1), restored.tab.id, "restored tab is selected");
});

test("onCreated reports the post-selection state and precedes onActivated", async (t) => {
  const { world, env, log } = await bootWithLog({ tabs: BASE_TABS, storage: baseStorage() });
  t.after(() => world.teardown());
  const tab = await env.browser.tabs.create({ url: "https://new.test/" });
  await world.idle();
  const created = log.findIndex((e) => e[0] === "tabs.onCreated" && e[1].id === tab.id);
  const activated = log.findIndex((e) => e[0] === "tabs.onActivated" && e[1].tabId === tab.id);
  assert.ok(created !== -1 && created < activated);
  assert.equal(log[created][1].active, true);
  assert.equal(log[created][1].index, 4, "appended after the existing tabs");
});

test("onUpdated honours the {properties} listener filter", async (t) => {
  const { world, env } = await bootWithLog({ tabs: BASE_TABS, storage: baseStorage() });
  t.after(() => world.teardown());
  const seen = [];
  env.browser.tabs.onUpdated.addListener((id, info) => { seen.push(Object.keys(info)[0]); }, { properties: ["pinned"] });
  await env.browser.tabs.update(2, { pinned: true });
  world.navigate(2, "https://a.test/2b");
  await world.idle();
  assert.deepEqual(seen, ["pinned"]);
  assert.deepEqual(world.order(1).slice(0, 2), [4, 2], "pinning moves the tab to the end of the pinned block");
});

test("windows expose type and incognito; getAll's default filter excludes devtools", async (t) => {
  const { world, env } = await bootWithLog({
    windows: [{ id: 1 }, { id: 2, type: "popup" }, { id: 3, incognito: true }, { id: 4, type: "devtools" }],
    tabs: [{ id: 1, url: "https://a.test/", active: true }, { id: 2, windowId: 2, url: "https://p.test/" },
      { id: 3, windowId: 3, url: "https://private.test/" }],
    storage: baseStorage(),
  });
  t.after(() => world.teardown());
  const all = await env.browser.windows.getAll();
  assert.deepEqual(all.map((w) => [w.id, w.type, w.incognito]), [[1, "normal", false], [2, "popup", false], [3, "normal", true]]);
  assert.equal(world.tab(3).incognito, true);
  assert.equal(world.tab(3).cookieStoreId, "firefox-private");
  await assert.rejects(env.browser.windows.get(99), /Invalid window ID: 99/);
});

test("the backend boots on the world and files a user-opened tab into the active workspace", async (t) => {
  const world = makeWorld({ tabs: BASE_TABS, sessionValues: { 1: WSP_A, 2: WSP_A, 3: WSP_B }, storage: baseStorage() });
  t.after(() => world.teardown());
  const env = await world.boot();
  assert.equal(env.get("Brainer")._state, "ready");
  const opened = world.openTab({ url: "https://a.test/3" });
  await world.idle();
  assert.ok(world.record(WSP_A).tabs.includes(opened.id), "event-driven assignment reached storage");
  assert.equal(world.tabValue(opened.id), WSP_A, "session tag written through the world");
  assert.deepEqual(world.listenerErrors, []);
});

test("storage latency option delays storage.local and still clones", async (t) => {
  const world = makeWorld({ tabs: BASE_TABS, storage: { ...baseStorage(), ...wspRecord(WSP_B, { name: "B", tabs: [3] }) }, storageLatencyMs: 5 });
  t.after(() => world.teardown());
  const env = await world.boot({ settleMs: 50 });
  const started = Date.now();
  const got = await env.browser.storage.local.get(`ld-wsp-${WSP_B}`);
  assert.ok(Date.now() - started >= 4, "the call took a timer hop");
  got[`ld-wsp-${WSP_B}`].tabs.push(99);
  assert.deepEqual(world.record(WSP_B).tabs, [3], "returned value is a copy");
});

test("restoring a closed window brings its tabs back under new ids with values and hidden state", async (t) => {
  const { world, env } = await bootWithLog({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 5, windowId: 2, url: "https://w2.test/a", active: true },
      { id: 6, windowId: 2, url: "https://w2.test/b", hidden: true },
    ],
    sessionValues: { 1: WSP_A, 5: WSP_A, 6: WSP_B },
    storage: baseStorage(),
  });
  t.after(() => world.teardown());
  world.closeWindow(2);
  const [entry] = await env.browser.sessions.getRecentlyClosed();
  assert.deepEqual(entry.window.tabs.map((x) => [x.url, x.hidden]), [["https://w2.test/a", false], ["https://w2.test/b", true]]);
  const { window: win } = await env.browser.sessions.restore(entry.window.sessionId);
  assert.notEqual(win.id, 2);
  const [a, b] = win.tabs;
  assert.ok(a.id !== 5 && b.id !== 6, "new tab ids");
  assert.deepEqual([a.active, a.hidden, b.active, b.hidden], [true, false, false, true]);
  assert.equal(world.tabValue(a.id), WSP_A);
  assert.equal(world.tabValue(b.id), WSP_B);
});

test("windows.create({tabId}) adopts the tab; the source window survives while it has a visible tab", async (t) => {
  const { world, env, log } = await bootWithLog({ tabs: BASE_TABS, sessionValues: { 2: WSP_A }, storage: baseStorage() });
  t.after(() => world.teardown());
  const win = await env.browser.windows.create({ tabId: 2 });
  assert.deepEqual(win.tabs.map((x) => [x.id, x.active]), [[2, true]]);
  assert.equal(world.windows.has(1), true);
  assert.equal(world.tabValue(2), WSP_A);
  await world.idle();
  assert.ok(log.some((e) => e[0] === "windows.onCreated" && e[1].id === win.id));
  assert.ok(log.some((e) => e[0] === "tabs.onAttached" && e[1] === 2 && e[2].newWindowId === win.id));
});

test("urlCommitMs: a web URL opens as about:blank and commits later with onUpdated {url}", async (t) => {
  const { world, env, log } = await bootWithLog({ tabs: BASE_TABS, storage: baseStorage(), urlCommitMs: 5 });
  t.after(() => world.teardown());
  const tab = await env.browser.tabs.create({ url: "https://late.test/" });
  assert.equal(tab.url, "about:blank");
  assert.equal(tab.status, "loading");
  await new Promise((r) => setTimeout(r, 10));
  await world.idle();
  assert.equal(world.tab(tab.id).url, "https://late.test/");
  const created = log.find((e) => e[0] === "tabs.onCreated" && e[1].id === tab.id);
  assert.equal(created[1].url, "about:blank");
  assert.ok(log.some((e) => e[0] === "tabs.onUpdated" && e[1] === tab.id && e[2].url === "https://late.test/"));
});
