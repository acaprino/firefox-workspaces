// Startup recovery must not mistake freshly timestamped closed-tab records
// for permission to reopen them. Firefox can restamp intentional closures.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

const WSP_A = "11111111-1111-4111-8111-111111111111";
const WSP_B = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];

async function recoveryFixture({ exportFails = false } = {}) {
  const liveTabs = [];
  const restoredIds = [];
  const bookmarks = [];
  const events = [];
  const sessionValues = new Map();
  const closedSessions = SNAPSHOT.map((url, i) => ({
    lastModified: Date.now(),
    tab: { sessionId: `closed-${i}`, url, windowId: 1, index: i, pinned: false },
  }));
  const env = loadBackend({
    storageData: {
      "ld-wsp-window-1": [WSP_A, WSP_B],
      "ld-wsp-order-1": [WSP_A, WSP_B],
      [`ld-wsp-${WSP_A}`]: {
        id: WSP_A, name: "Home", tabs: [], groups: [], active: true, windowId: 1,
        tabSnapshot: SNAPSHOT.slice(0, 2),
      },
      [`ld-wsp-${WSP_B}`]: {
        id: WSP_B, name: "Other", tabs: [], groups: [], active: false, windowId: 1,
        tabSnapshot: SNAPSHOT.slice(2),
      },
    },
    overrides: {
      tabs: {
        query: async (query = {}) => liveTabs.filter(t =>
          (query.windowId == null || t.windowId === query.windowId) &&
          (query.pinned == null || t.pinned === query.pinned)),
        get: async id => {
          const tab = liveTabs.find(t => t.id === id);
          if (!tab) throw new Error("No tab");
          return tab;
        },
      },
      sessions: {
        getTabValue: async id => sessionValues.get(id),
        setTabValue: async (id, key, value) => { sessionValues.set(id, value); },
        getRecentlyClosed: async () => closedSessions,
        restore: async sessionId => {
          restoredIds.push(sessionId);
          const i = closedSessions.findIndex(s => s.tab.sessionId === sessionId);
          const [closed] = closedSessions.splice(i, 1);
          const tab = { ...closed.tab, id: 300 + restoredIds.length };
          liveTabs.push(tab);
          return { tab };
        },
      },
      bookmarks: {
        create: async options => {
          if (exportFails) throw new Error("Bookmarks unavailable");
          const bookmark = { id: `bm-${bookmarks.length}`, ...options };
          bookmarks.push(bookmark);
          if (options.url) events.push("export");
          return bookmark;
        },
      },
    },
  });
  // Let automatic initialization finish with no live content tabs, then run
  // one controlled startup recovery against the real services.
  await env.settle();
  assert.equal(env.get("Brainer")._state, "ready");
  const originalSet = env.browser.storage.local.set;
  env.browser.storage.local.set = async data => {
    if (data[`ld-wsp-${WSP_A}`]) events.push("workspace-write");
    await originalSet(data);
  };
  return { ...env, liveTabs, restoredIds, bookmarks, events, sessionValues, closedSessions };
}

async function recover(env, path) {
  const Brainer = env.get("Brainer");
  if (path === "detected restart") {
    env.storageData["primary-window-last-id"] = 1;
    delete env.storageData["primary-window-id"];
    await Brainer._restoreWorkspaces({ id: 1 });
  } else {
    await Brainer._repairTabAssignments(1, true);
  }
}

for (const path of ["detected restart", "undetected restart"]) {
  test(`${path}: fresh closed-tab matches stay closed and snapshots are backed up first`, async t => {
    const env = await recoveryFixture();
    t.after(() => {
      for (const timer of env.get("TabService")._snapshotTimers.values()) clearTimeout(timer);
    });
    // Regression fixture: this is Firefox's internal blank-tab URL, which
    // the existing startup predicate counts as live content.
    env.liveTabs.push({ id: 50, windowId: 1, url: "chrome://browser/content/blanktab.html", pinned: false });
    await recover(env, path);

    assert.deepEqual(env.restoredIds, [], "startup must not consume undo-close history");
    assert.equal(env.closedSessions.length, 3);
    assert.deepEqual(env.liveTabs.map(t => t.id), [50], "no closed tab was reopened");
    assert.deepEqual(env.bookmarks.filter(b => b.url).map(b => b.url), SNAPSHOT);
    assert.ok(env.events.lastIndexOf("export") < env.events.indexOf("workspace-write"),
      "all snapshot exports precede workspace changes");
    const banner = env.storageData["ld-wsp-last-restore-error"];
    assert.equal(banner.reason, "session-not-restored", "report incomplete restore, not a proven closure cause");
    assert.equal(banner.snapshotUrlCount, 3);
    assert.equal(banner.exportedWorkspaces, 2);
    assert.equal(banner.exportedUrls, 3);
    assert.deepEqual([...env.storageData[`ld-wsp-${WSP_A}`].tabs], [50]);
    assert.deepEqual([...env.storageData[`ld-wsp-${WSP_B}`].tabs], []);
  });
}

test("normal restart keeps Firefox-restored tabs in their workspaces without recovery exports", async () => {
  const env = await recoveryFixture();
  env.liveTabs.push(
    { id: 51, windowId: 1, url: SNAPSHOT[0], pinned: false },
    { id: 52, windowId: 1, url: SNAPSHOT[2], pinned: false },
  );
  env.sessionValues.set(51, WSP_A);
  env.sessionValues.set(52, WSP_B);
  await recover(env, "detected restart");

  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_A}`].tabs], [51]);
  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_B}`].tabs], [52]);
  assert.equal(env.storageData["ld-wsp-last-restore-error"], undefined);
  assert.deepEqual(env.bookmarks, []);
  assert.deepEqual(env.restoredIds, []);
});

test("URL fallback reassigns already-open tabs without opening closed ones", async () => {
  const env = await recoveryFixture();
  env.liveTabs.push(...SNAPSHOT.map((url, i) => ({ id: 51 + i, windowId: 1, url, pinned: false })));
  await recover(env, "detected restart");

  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_A}`].tabs], [51, 52]);
  assert.deepEqual([...env.storageData[`ld-wsp-${WSP_B}`].tabs], [53]);
  assert.deepEqual(env.restoredIds, []);
  assert.deepEqual(env.bookmarks, []);
  assert.equal(env.storageData["ld-wsp-last-restore-error"], undefined);
});

test("repeated incomplete detection deduplicates backups and does not rearm a dismissed warning", async () => {
  const env = await recoveryFixture();
  env.liveTabs.push({ id: 50, windowId: 1, url: "https://example.com/new", pinned: false });
  const Brainer = env.get("Brainer");
  await Brainer._detectSessionLoss(1);
  assert.equal(env.storageData["ld-wsp-last-restore-error"].exportedUrls, 3);
  const count = env.bookmarks.length;
  await env.get("WSPStorageManager").clearLastRestoreError();
  await Brainer._detectSessionLoss(1);

  assert.deepEqual(env.restoredIds, []);
  assert.equal(env.bookmarks.length, count);
  assert.equal(env.storageData["ld-wsp-last-restore-error"], undefined);
});

test("a pending warning is preserved while incomplete snapshots are backed up", async () => {
  const env = await recoveryFixture();
  const pending = { when: 123, reason: "phase4-failure" };
  env.storageData["ld-wsp-last-restore-error"] = pending;
  env.liveTabs.push({ id: 50, windowId: 1, url: "https://example.com/new", pinned: false });
  await env.get("Brainer")._detectSessionLoss(1);

  assert.deepEqual(env.bookmarks.filter(b => b.url).map(b => b.url), SNAPSHOT);
  assert.deepEqual(env.restoredIds, []);
  assert.equal(env.storageData["ld-wsp-last-restore-error"], pending);
});

test("failed bookmark export never falls back to automatic reopening", async () => {
  const env = await recoveryFixture({ exportFails: true });
  env.liveTabs.push({ id: 50, windowId: 1, url: "https://example.com/new", pinned: false });
  await env.get("Brainer")._detectSessionLoss(1);

  assert.deepEqual(env.restoredIds, []);
  const banner = env.storageData["ld-wsp-last-restore-error"];
  assert.equal(banner.reason, "session-not-restored");
  assert.equal(banner.exportedWorkspaces, 0);
  assert.equal(banner.exportedUrls, 0);
});
