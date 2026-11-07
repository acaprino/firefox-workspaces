// tests/tab-groups-restart.test.mjs
// Native tab groups across browser restarts and workspace switches. Firefox
// recreates the groups itself from its session store and reassigns tab ids at
// every browser start, so a stored tab id may name another tab by now.
// One group the user made stays one group with the same tabs, whatever the
// strip went through. Tabs are named by URL here: their ids change per run.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A as HOME, WSP_B as FIRE } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

const sorted = (list) => [...list].sort((a, b) => a - b);
const TRADING = { title: "Trading", color: "green", collapsed: true };

test("a restart keeps the group Firefox restored as one group with the same tabs", async (t) => {
  // The group's tabs were 5, 6, 7 when their ids were stored. One tab before
  // the group closed later in that session, so after this start the same tabs
  // are 4, 5, 6, and 7 is the ungrouped tab next to them.
  const tabIds = [1, 2, 3, 4, 5, 6, 7, 8];
  const url = (id) => `https://a.test/${id}`;
  const RESTORED_GROUP = 500; // outside the range the model mints new group ids from
  const { "primary-window-id": lastPrimary, ...seed } = seedWorkspaces(1, [{
    id: HOME, name: "Home", active: true, tabs: tabIds, tabSnapshot: tabIds.map(url),
    groups: [{ ...TRADING, tabs: [5, 6, 7] }],
  }]);
  const world = makeWorld({
    sessionAlive: false,
    storage: { ...seed, "primary-window-last-id": lastPrimary },
    tabs: tabIds.map((id) => ({
      id, url: url(id), active: id === 1, groupId: [4, 5, 6].includes(id) ? RESTORED_GROUP : -1,
    })),
    groups: [{ id: RESTORED_GROUP, windowId: 1, ...TRADING }],
    sessionValues: Object.fromEntries(tabIds.map((id) => [id, HOME])),
  });
  t.after(() => world.teardown());

  await world.boot();
  await world.idle();

  // The restart path committed. A refused or failed restore would also leave
  // one group behind, for the wrong reason.
  assert.equal(world.storage["primary-window-id"], 1, "the restore claimed window 1");
  assert.equal(world.storage["primary-window-last-id"], undefined, "the restore dropped its retry signal");
  assert.equal(world.storage["ld-wsp-last-restore-error"], undefined, "no refused or failed restore");

  const groups = await world.browser.tabGroups.query({ windowId: 1 });
  const members = (group) => sorted(world.order(1).filter((id) => world.tab(id).groupId === group.id));
  assert.equal(groups.length, 1, `one native group in window 1; tabs per group: ${JSON.stringify(groups.map(members))}`);
  assert.deepEqual(members(groups[0]), [4, 5, 6], "the group keeps exactly the tabs Firefox restored in it");
  assert.equal(world.tab(7)?.groupId, -1, "tab 7 was never in the group");
});

// ── A strip like a real profile ──
// Two workspaces mixed in one strip. Ids follow creation order (Home's tabs,
// then Fire's) from the same low numbers a new run hands out by position, so
// a stored id names another tab in the next run, as it does in Firefox.
const STRIP = ["h01", "h02", "f01", "h03", "h04", "h05", "h06", "f02", "h07", "h08"];
const firstId = (name) => (name[0] === "h" ? 1 : 9) + Number(name.slice(1));
const ids = (prefix) => STRIP.filter((n) => n[0] === prefix).map(firstId);
const nameOf = (world, id) => world.tab(id).url.split("/").pop();
const idOf = (world, name) => world.order(1).find((id) => nameOf(world, id) === name);
const idsOf = (world, names) => names.map((n) => idOf(world, n));
const strip = (world) => world.order(1).map((id) => nameOf(world, id));
const groupsOf = (world) => world.nativeGroups(1).map((g) => g.tabs.map((id) => nameOf(world, id)));
const groupCalls = (world) => world.calls.filter((call) => call[0] === "tabs.group").length;

function firstRun({ onScreen = HOME, extraWindow = false } = {}) {
  const home = onScreen === HOME;
  return {
    windows: extraWindow ? [{ id: 1, focused: true }, { id: 2 }] : [{ id: 1 }],
    tabs: [
      ...STRIP.map((name) => ({
        id: firstId(name), windowId: 1, url: `https://t.test/${name}`,
        hidden: home ? name[0] === "f" : name[0] === "h",
        active: name === (home ? "h08" : "f02"),
      })),
      ...(extraWindow ? [{ id: 99, windowId: 2, url: "https://other.test/", active: true }] : []),
    ],
    sessionValues: Object.fromEntries(STRIP.map((name) => [firstId(name), name[0] === "h" ? HOME : FIRE])),
    storage: seedWorkspaces(1, [
      { id: HOME, name: "Home", active: home, tabs: ids("h") },
      { id: FIRE, name: "Fire", active: !home, tabs: ids("f") },
    ]),
  };
}

// A scenario holds the current run; `restart` swaps it for the next one.
async function start(t, options = firstRun()) {
  const run = { world: makeWorld(options) };
  t.after(() => run.world.teardown());
  await run.world.boot();
  await run.world.idle();
  run.restart = async (quitOptions) => {
    run.world = makeWorld(await run.world.quit(quitOptions));
    await run.world.boot();
    await run.world.idle();
  };
  run.switchTo = async (wspId) => {
    await run.world.env.get("WorkspaceService").activateWsp(wspId, 1);
    await run.world.idle();
  };
  run.group = async (names, props = TRADING) => {
    const gid = run.world.groupTabs(idsOf(run.world, names), props);
    await run.world.idle();
    return gid;
  };
  run.close = async (name) => {
    run.world.closeTab(idOf(run.world, name));
    await run.world.idle();
  };
  return run;
}

const RESTORED = ["h03", "h04", "h05"];

for (const [label, quitOptions] of [
  ["clean quit", { clean: true }],
  ["crash", { clean: false }],
  ["clean quit, selected tab gets the first id", { clean: true, selectedFirst: true }],
]) {
  test(`${label}: the group on screen stays one group with the same tabs while tabs close before it`, async (t) => {
    const run = await start(t);
    await run.group(RESTORED);
    for (const before of ["h01", "h02"]) {
      await run.close(before);
      await run.restart(quitOptions);
      assert.deepEqual(groupsOf(run.world), [RESTORED], `after closing ${before}`);
      assert.equal(groupCalls(run.world), 0, "nothing is built on top of what Firefox restored");
    }
    await run.restart(quitOptions);
    assert.deepEqual(groupsOf(run.world), [RESTORED], "and at a restart with no change at all");
  });
}

test("the group on screen stays the same when a tab opens before it", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  for (const index of [1, 1]) {
    run.world.openTab({ url: `https://t.test/new${index}`, index, active: false });
    await run.world.idle();
    await run.restart();
    assert.deepEqual(groupsOf(run.world), [RESTORED]);
  }
});

test("a group of tabs that were not adjacent survives restarts without moving other tabs", async (t) => {
  const run = await start(t);
  const members = ["h02", "h06", "h07"];
  await run.group(members);
  const stripBefore = strip(run.world);
  assert.deepEqual(stripBefore, ["h01", "h02", "h06", "h07", "f01", "h03", "h04", "h05", "f02", "h08"],
    "the model gathers the listed tabs where the first one was");
  for (let i = 0; i < 3; i++) {
    await run.restart();
    assert.deepEqual(groupsOf(run.world), [members], `restart ${i + 1}`);
    assert.deepEqual(strip(run.world), stripBefore, `restart ${i + 1}: no tab moved`);
  }
});

test("off screen at quit: the group comes back on the same tabs, with its look, and moves nothing", async (t) => {
  const run = await start(t);
  const members = ["h02", "h06", "h07"];
  await run.group(members);
  const stripBefore = strip(run.world);
  await run.switchTo(FIRE);
  assert.deepEqual(groupsOf(run.world), [], "leaving takes the group apart");
  for (const closed of ["f01", null]) {
    await run.restart();
    assert.deepEqual(groupsOf(run.world), [], "nothing is restored while the workspace is off screen");
    await run.switchTo(HOME);
    assert.deepEqual(groupsOf(run.world), [members]);
    const [group] = run.world.nativeGroups(1);
    assert.deepEqual([group.title, group.color, group.collapsed], ["Trading", "green", true]);
    assert.deepEqual(strip(run.world).filter((n) => n !== "f01"), stripBefore.filter((n) => n !== "f01"),
      "the strip order did not change");
    await run.switchTo(FIRE);
    if (closed) await run.close(closed);
  }
});

test("a group the user took apart stays apart, after a restart and after a switch", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  run.world.ungroupTabs(idsOf(run.world, RESTORED));
  await run.world.idle();
  await run.restart();
  assert.deepEqual(groupsOf(run.world), []);
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), []);
});

test("a tab the user took out of a group stays out; a tab the user added stays in", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  run.world.ungroupTabs(idOf(run.world, "h03"));
  await run.world.idle();
  const [{ id: gid }] = run.world.nativeGroups(1);
  await run.world.env.browser.tabs.group({ tabIds: [idOf(run.world, "h06")], groupId: gid });
  await run.world.idle();
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [["h04", "h05", "h06"]]);
  await run.switchTo(FIRE);
  await run.restart();
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [["h04", "h05", "h06"]]);
});

test("a new tab opened inside a group is part of it when the workspace comes back", async (t) => {
  const run = await start(t);
  const gid = await run.group(RESTORED);
  run.world.openTab({ url: "https://t.test/h09", groupId: gid, active: false });
  await run.world.idle();
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [["h03", "h04", "h05", "h09"]]);
});

test("two groups with the same title stay two groups, each with its tabs", async (t) => {
  const run = await start(t);
  await run.group(["h01", "h02"]);
  await run.group(["h06", "h07"]);
  await run.switchTo(FIRE);
  await run.restart();
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [["h01", "h02"], ["h06", "h07"]]);
});

test("a tab moved to another workspace leaves its group for good", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  const moved = await run.world.browser.tabs.get(idOf(run.world, "h04"));
  await run.world.env.get("TabService").moveTabToWsp(moved, HOME, FIRE);
  await run.world.idle();
  assert.deepEqual(groupsOf(run.world), [["h03", "h05"]]);
  await run.switchTo(FIRE);
  assert.deepEqual(groupsOf(run.world), [], "not grouped in its new workspace");
  const back = await run.world.browser.tabs.get(idOf(run.world, "h04"));
  await run.world.env.get("TabService").moveTabToWsp(back, FIRE, HOME);
  await run.world.idle();
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [["h03", "h05"]], "moving it back does not put it in the group again");
});

test("a tab pinned out of a group does not go back in when it is unpinned", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  const id = idOf(run.world, "h04");
  await run.world.env.browser.tabs.update(id, { pinned: true });
  await run.world.idle();
  await run.world.env.browser.tabs.update(id, { pinned: false });
  await run.world.idle();
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [["h03", "h05"]]);
});

test("a one-tab group whose tab went to another window and came back is not built again", async (t) => {
  const run = await start(t, firstRun({ extraWindow: true }));
  await run.group(["h04"]);
  const id = idOf(run.world, "h04");
  run.world.moveTab(id, { windowId: 2 });
  await run.world.idle();
  run.world.moveTab(id, { windowId: 1, index: 3 });
  await run.world.idle();
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), []);
});

test("a stood-down workspace keeps its groups record when a pass reaches it late", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  await run.switchTo(FIRE);
  const stale = await run.world.env.get("WSPStorageManager").getWorkspace(HOME);
  await stale.updateTabGroups();
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [RESTORED]);
});

test("a tab carrying the key of a live group it is not in does not join it", async (t) => {
  // It left the group while nobody was listening: the extension was disabled,
  // so the event was never seen. The native group says who is in it.
  const run = await start(t);
  await run.group(RESTORED);
  const [{ key }] = run.world.record(HOME).groups;
  await run.world.env.get("TabService").setGroupTag(idOf(run.world, "h06"), key);
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [RESTORED]);
});

test("a group keeps the order of its tabs when it comes back", async (t) => {
  const run = await start(t);
  await run.group(["h05", "h03", "h04"]);
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [["h05", "h03", "h04"]]);
});

test("a tab moved into a group of its own stays apart from the group it left", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  await run.group(["h05"]);
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [["h03", "h04"], ["h05"]]);
});

test("a hidden tab grouped by someone else does not wipe the groups of its off-screen workspace", async (t) => {
  const run = await start(t);
  await run.group(["h01", "h02"]);
  await run.group(["h06", "h07"]);
  await run.switchTo(FIRE);
  run.world.groupTabs(idOf(run.world, "h04"), { title: "Stray" });
  await run.world.idle();
  await run.switchTo(FIRE); // any hide pass
  assert.deepEqual(groupsOf(run.world), [], "the stray group went with the hide pass");
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [["h01", "h02"], ["h04"], ["h06", "h07"]]);
});

test("a group whose rebuild failed is not forgotten: it comes back the next time", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  await run.group(["h06", "h07"], { title: "Second", color: "blue", collapsed: false });
  await run.switchTo(FIRE);
  const tabsApi = run.world.env.browser.tabs;
  const group = tabsApi.group;
  const blocked = idOf(run.world, "h03");
  let broken = true;
  tabsApi.group = async (options) => {
    if (broken && options.tabIds.includes(blocked)) throw new Error("Cannot group these tabs");
    return group(options);
  };
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [["h06", "h07"]], "the switch went through with the group that could be built");
  broken = false;
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [RESTORED, ["h06", "h07"]]);
});

test("a tab closing during a rebuild does not cost the group its other tabs", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  await run.switchTo(FIRE);
  const tabsApi = run.world.env.browser.tabs;
  const group = tabsApi.group;
  let armed = true;
  tabsApi.group = async (options) => {
    if (armed) {
      armed = false;
      run.world.closeTab(idOf(run.world, "h04")); // gone, and not yet reported
    }
    return group(options);
  };
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [["h03", "h05"]]);
});

test("a group taken apart right before a switch stays apart", async (t) => {
  const run = await start(t, { ...firstRun(), apiLatencyMs: 1 });
  await run.group(RESTORED);
  run.world.ungroupTabs(idsOf(run.world, RESTORED));
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), []);
});

test("a group taken apart while the extension is not ready stays apart", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  const Brainer = run.world.env.get("Brainer");
  Brainer._state = "uninitialized";
  run.world.ungroupTabs(idsOf(run.world, RESTORED));
  await run.world.idle();
  Brainer._state = "ready";
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), []);
});

test("a closed group does not come back around one undone tab", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  await run.world.env.browser.tabs.remove(idsOf(run.world, RESTORED));
  await run.world.idle();
  run.world.undoCloseTab();
  await run.world.idle();
  await run.restart();
  assert.deepEqual(groupsOf(run.world), [], "after a restart");
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [], "after a switch");
});

test("a tab closed out of a live group and undone is back in the group for good", async (t) => {
  const run = await start(t);
  await run.group(RESTORED);
  run.world.closeTab(idOf(run.world, "h05"));
  await run.world.idle();
  run.world.undoCloseTab();
  await run.world.idle();
  assert.deepEqual(groupsOf(run.world), [RESTORED]);
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [RESTORED]);
});

test("records stay readable by an older build, which filters each entry's tabs", async (t) => {
  // storage.js: an AMO rollback runs the older build on this data. It would
  // throw on group.tabs.filter, and that workspace could not be shown.
  const run = await start(t);
  await run.group(RESTORED);
  await run.switchTo(FIRE);
  const [entry] = run.world.record(HOME).groups;
  assert.deepEqual(entry.tabs, []);
});

test("entries from older versions, which listed tab ids, are dropped and move no tab", async (t) => {
  const options = firstRun({ onScreen: FIRE });
  options.storage[`ld-wsp-${HOME}`].groups = [
    { ...TRADING, tabs: [firstId("h04")] },
    { ...TRADING, tabs: [firstId("h01"), firstId("h07")] },
  ];
  const run = await start(t, options);
  const stripBefore = strip(run.world);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [], "no group is built from ids");
  assert.deepEqual(strip(run.world), stripBefore, "no tab moved");
  assert.deepEqual(run.world.record(HOME).groups, []);
});

test("a group on screen from before the upgrade is kept and comes back after a switch", async (t) => {
  // Native group present, record in the old format, not one event since then.
  const options = firstRun();
  for (const name of RESTORED) options.tabs.find((tab) => tab.id === firstId(name)).groupId = 500;
  options.groups = [{ id: 500, windowId: 1, ...TRADING }];
  options.storage[`ld-wsp-${HOME}`].groups = [{ ...TRADING, tabs: RESTORED.map(firstId) }];
  const run = await start(t, options);
  await run.switchTo(FIRE);
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [RESTORED]);
});

test("rebuilding a group keeps its tabs in their window when another window is in front", async (t) => {
  const run = await start(t, firstRun({ extraWindow: true }));
  await run.group(RESTORED);
  await run.switchTo(FIRE);
  run.world.focusWindow(2);
  await run.world.idle();
  await run.switchTo(HOME);
  assert.deepEqual(groupsOf(run.world), [RESTORED]);
  assert.deepEqual(run.world.order(2), [99], "window 2 keeps only its own tab");
});

test("group events arriving during a switch do not erase the groups of the workspace being left", async (t) => {
  // Both workspaces hold a group: the switch rebuilds one while taking the
  // other apart, and its events reach listeners that read "the active
  // workspace" while that is still the one being left.
  const run = await start(t, { ...firstRun(), apiLatencyMs: 1 });
  await run.group(RESTORED);
  await run.switchTo(FIRE);
  await run.group(["f01", "f02"], { title: "Other", color: "blue", collapsed: false });
  for (let i = 0; i < 3; i++) {
    await run.switchTo(HOME);
    assert.deepEqual(groupsOf(run.world), [RESTORED], `round ${i + 1}, Home`);
    await run.switchTo(FIRE);
    assert.deepEqual(groupsOf(run.world), [["f01", "f02"]], `round ${i + 1}, Fire`);
  }
});
