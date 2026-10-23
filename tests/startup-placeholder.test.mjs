import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

const WSP_A = "11111111-1111-4111-8111-111111111111";
const WSP_B = "22222222-2222-4222-8222-222222222222";

async function startupFixture(t, url) {
  const env = loadBackend();
  await env.settle();
  t.after(() => {
    for (const timer of env.get("TabService")._snapshotTimers.values()) clearTimeout(timer);
    clearTimeout(env.get("Brainer")._restoreRetryTimer);
    clearTimeout(env.get("WorkspaceService")._lastActiveTimer);
  });
  env.get("LIMITS").RESTORE_DELAY_MS = 5;
  const saved = {
    "primary-window-id": 1,
    "ld-wsp-window-1": [WSP_A, WSP_B],
    "ld-wsp-order-1": [WSP_A, WSP_B],
    [`ld-wsp-${WSP_A}`]: {
      id: WSP_A, name: "Home", windowId: 1, active: false, tabs: [20], groups: [],
      tabSnapshot: ["about:newtab", "https://example.com/saved-home"],
    },
    [`ld-wsp-${WSP_B}`]: {
      id: WSP_B, name: "Other", windowId: 1, active: true, tabs: [30], groups: [],
      tabSnapshot: ["https://example.com/saved-other"],
    },
  };
  for (const key of Object.keys(env.storageData)) delete env.storageData[key];
  Object.assign(env.storageData, structuredClone(saved));
  const liveTabs = [{ id: 1, windowId: 1, url, pinned: false, active: true }];
  env.browser.tabs.query = async (query = {}) => liveTabs.filter(tab =>
    (query.windowId == null || tab.windowId === query.windowId)
    && (query.pinned == null || tab.pinned === query.pinned)
    && (query.active == null || tab.active === query.active));
  env.browser.tabs.get = async id => liveTabs.find(tab => tab.id === id);
  const tagged = [];
  env.browser.sessions.setTabValue = async (...args) => { tagged.push(args); };
  return { ...env, saved, liveTabs, tagged };
}

async function fire(event, ...args) {
  await Promise.all(event._listeners.map(listener => listener(...args)));
}

async function waitUntil(env, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await env.settle(5);
  }
  assert.ok(predicate(), "recovery did not finish");
}

for (const path of ["detected restart", "undetected restart"]) {
  for (const url of ["chrome://browser/content/blanktab.html", "about:newtab"]) {
    test(`${path}: ${url} cannot replace saved content`, async t => {
      const env = await startupFixture(t, url);
      if (path === "detected restart") {
        delete env.storageData["primary-window-id"];
        env.storageData["primary-window-last-id"] = 1;
      }
      const Brainer = env.get("Brainer");
      await assert.rejects(
        path === "detected restart"
          ? Brainer._restoreWorkspaces({ id: 1 })
          : Brainer._repairTabAssignments(1, true),
        /Refuse-to-wipe/,
      );
      for (const key of ["ld-wsp-window-1", "ld-wsp-order-1", `ld-wsp-${WSP_A}`, `ld-wsp-${WSP_B}`]) {
        assert.deepEqual(env.storageData[key], env.saved[key], "workspace data must stay untouched");
      }
      assert.deepEqual(env.tagged, [], "do not tag startup placeholders as recovered tabs");
      assert.equal(env.storageData["ld-wsp-last-restore-error"].reason, "refuse-to-wipe");
      assert.equal(Brainer._refuseToWipeActive, true);
      assert.equal(env.storageData["primary-window-last-id"], 1, "keep an explicit retry signal");
      assert.equal(env.storageData["primary-window-id"], undefined);
    });
  }
}

test("a pending snapshot refresh cannot erase data after startup recovery pauses", async t => {
  const env = await startupFixture(t, "chrome://browser/content/blanktab.html");
  const TabService = env.get("TabService");
  TabService._SNAPSHOT_DEBOUNCE_MS = 1;
  TabService._scheduleSnapshotRefresh(1, WSP_B);

  await assert.rejects(env.get("Brainer")._repairTabAssignments(1, true), /Refuse-to-wipe/);
  await env.settle();

  assert.deepEqual(env.storageData[`ld-wsp-${WSP_B}`], env.saved[`ld-wsp-${WSP_B}`]);
});

test("an ordinary reload with blank tabs still cleans deliberately closed tab IDs", async t => {
  const env = await startupFixture(t, "about:newtab");
  await env.get("Brainer")._repairTabAssignments(1, false);
  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_A}`].tabs], []);
  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_B}`].tabs], [1]);
  assert.equal(env.storageData["ld-wsp-last-restore-error"], undefined);
});

for (const path of ["detected restart", "undetected restart"]) {
  for (const event of ["created", "url updated"]) {
    test(`${path}: resumes when restored tabs are ${event} after the initial pause`, async t => {
      const env = await startupFixture(t, "about:blank");
      const Brainer = env.get("Brainer");
      if (path === "detected restart") {
        delete env.storageData["primary-window-id"];
        env.storageData["primary-window-last-id"] = 1;
      }
      await assert.rejects(path === "detected restart"
        ? Brainer._restoreWorkspaces({ id: 1 })
        : Brainer._repairTabAssignments(1, true), /Refuse-to-wipe/);

      // Let the initial retry see placeholders only. Later tab events must
      // still wake recovery, without depending on another onStartup event.
      await env.settle(30);
      assert.equal(Brainer._state, "uninitialized");
      assert.deepEqual(env.storageData[`ld-wsp-${WSP_B}`], env.saved[`ld-wsp-${WSP_B}`]);
      const restored = { id: event === "created" ? 2 : 1, windowId: 1,
        url: "https://example.com/saved-other", pinned: false, active: true };
      if (event === "created") env.liveTabs.push(restored);
      else Object.assign(env.liveTabs[0], restored);
      env.browser.sessions.getTabValue = async id => id === restored.id ? WSP_B : undefined;
      let restoreCalls = 0;
      const restore = Brainer._restoreWorkspaces.bind(Brainer);
      Brainer._restoreWorkspaces = async window => { restoreCalls++; return restore(window); };
      await Promise.all(Array.from({ length: 3 }, () => event === "created"
        ? fire(env.browser.tabs.onCreated, restored)
        : fire(env.browser.tabs.onUpdated, restored.id, { url: restored.url }, restored)));
      await waitUntil(env, () => Brainer._state === "ready" && !Brainer._restoreInFlight);

      assert.equal(restoreCalls, 1, "concurrent tab events must share one restore");
      assert.equal(env.storageData[`ld-wsp-${WSP_B}`].tabs.includes(restored.id), true);
      assert.equal(env.storageData["primary-window-id"], 1);
      assert.equal(env.storageData["primary-window-last-id"], undefined);
      assert.equal(env.storageData["ld-wsp-last-restore-error"], undefined);
      assert.equal(Brainer._refuseToWipeActive, false);
      assert.equal(env.get("WorkspaceService")._activeCache.activeWspId, WSP_B);
      const result = await env.get("_handleMessage")({ action: "activateWorkspace", wspId: WSP_B, windowId: 1 });
      assert.equal(result.success, true, "popup actions must work again");
    });
  }
}

test("restored content arriving while the pause is being recorded is not missed", async t => {
  const env = await startupFixture(t, "about:blank");
  const remove = env.browser.storage.local.remove;
  env.browser.storage.local.remove = async keys => {
    await remove(keys);
    if (keys !== "primary-window-id") return;
    Object.assign(env.liveTabs[0], { url: "https://example.com/saved-other" });
    env.browser.sessions.getTabValue = async () => WSP_B;
    await fire(env.browser.tabs.onUpdated, 1, { url: env.liveTabs[0].url }, env.liveTabs[0]);
  };
  const Brainer = env.get("Brainer");
  await assert.rejects(Brainer._repairTabAssignments(1, true), /Refuse-to-wipe/);
  await waitUntil(env, () => Brainer._state === "ready" && !Brainer._restoreInFlight);
  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_B}`].tabs], [1]);
});

test("content in an unrelated window does not resume a paused restore", async t => {
  const env = await startupFixture(t, "about:blank");
  const Brainer = env.get("Brainer");
  await assert.rejects(Brainer._repairTabAssignments(1, true), /Refuse-to-wipe/);
  const unrelated = { id: 2, windowId: 2, url: "https://example.com/unrelated", pinned: false };
  env.liveTabs.push(unrelated);
  await fire(env.browser.tabs.onCreated, unrelated);
  await fire(env.browser.tabs.onUpdated, 2, { url: unrelated.url }, unrelated);
  await env.settle(30);
  assert.equal(Brainer._state, "uninitialized");
  assert.deepEqual(env.storageData[`ld-wsp-${WSP_B}`], env.saved[`ld-wsp-${WSP_B}`]);
});

test("dismissing the warning keeps automatic recovery in the original window", async t => {
  const env = await startupFixture(t, "about:blank");
  const Brainer = env.get("Brainer");
  await assert.rejects(Brainer._repairTabAssignments(1, true), /Refuse-to-wipe/);
  const result = await env.get("_handleMessage")({ action: "acknowledgeLastRestoreError" });
  assert.equal(result.success, true);
  assert.equal(env.storageData["ld-wsp-last-restore-error"], undefined);
  await env.settle(30);

  env.liveTabs[0].url = "https://example.com/saved-other";
  env.browser.sessions.getTabValue = async () => WSP_B;
  await fire(env.browser.windows.onCreated, { id: 2 });
  await fire(env.browser.tabs.onUpdated, 1, { url: env.liveTabs[0].url }, env.liveTabs[0]);
  await waitUntil(env, () => Brainer._state === "ready" && !Brainer._restoreInFlight);
  assert.equal(env.storageData["primary-window-id"], 1);
  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_B}`].tabs], [1]);
});

test("giving up recovery cancels pending automatic retries", async t => {
  const env = await startupFixture(t, "about:blank");
  const Brainer = env.get("Brainer");
  await assert.rejects(Brainer._repairTabAssignments(1, true), /Refuse-to-wipe/);
  const result = await env.get("_handleMessage")({ action: "giveUpRestoreRetry" });
  assert.equal(result.success, true);
  assert.equal(env.storageData["primary-window-last-id"], undefined);
  env.liveTabs[0].url = "https://example.com/saved-other";
  await fire(env.browser.tabs.onUpdated, 1, { url: env.liveTabs[0].url }, env.liveTabs[0]);
  await env.settle(30);
  assert.equal(env.storageData["primary-window-id"], undefined);
  assert.deepEqual(env.storageData[`ld-wsp-${WSP_B}`], env.saved[`ld-wsp-${WSP_B}`]);
});

test("give-up cannot discard records while automatic recovery is reading them", async t => {
  const env = await startupFixture(t, "about:blank");
  const Brainer = env.get("Brainer");
  await assert.rejects(Brainer._repairTabAssignments(1, true), /Refuse-to-wipe/);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  let readingSession = false;
  env.liveTabs[0].url = "https://example.com/saved-other";
  env.browser.sessions.getTabValue = async () => {
    readingSession = true;
    await gate;
    return WSP_B;
  };
  await fire(env.browser.tabs.onUpdated, 1, { url: env.liveTabs[0].url }, env.liveTabs[0]);
  await waitUntil(env, () => readingSession);
  const result = await env.get("_handleMessage")({ action: "giveUpRestoreRetry" });
  assert.equal(result.success, false, "refresh the warning instead of claiming to cancel an active restore");
  assert.equal(result.stale, true);
  assert.equal(env.storageData["primary-window-last-id"], 1);
  release();
  await waitUntil(env, () => Brainer._state === "ready" && !Brainer._restoreInFlight);
  assert.equal(env.storageData[`ld-wsp-${WSP_B}`].name, "Other");
  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_B}`].tabs], [1]);
});
