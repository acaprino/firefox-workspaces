// tests/mass-closure.test.mjs
// Mass-closure reclassification: a session-loss verdict is downgraded to
// "tabs closed at startup" when the snapshot URLs sit in the recently-closed
// list with fresh timestamps, and the tabs are reopened via sessions.restore.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

process.on("unhandledRejection", () => {});

const WSP_A = "11111111-1111-4111-8111-111111111111";
const WSP_B = "22222222-2222-4222-8222-222222222222";

test("_isMassTabClosure fires only at or above the match ratio", async () => {
  const { get, settle } = loadBackend();
  await settle();
  const Brainer = get("Brainer");
  assert.equal(Brainer._isMassTabClosure({ snapshotUrlCount: 1, recentClosedMatchCount: 1 }),
    false, "below minimum evidence");
  assert.equal(Brainer._isMassTabClosure({ snapshotUrlCount: 17, recentClosedMatchCount: 8 }),
    false, "under half matched: not a mass-closure");
  assert.equal(Brainer._isMassTabClosure({ snapshotUrlCount: 17, recentClosedMatchCount: 9 }),
    true, "over half matched: mass-closure");
  assert.equal(Brainer._isMassTabClosure({ snapshotUrlCount: 10, recentClosedMatchCount: 5 }),
    true, "exactly half matched: mass-closure (>=)");
});

test("_findRecentlyClosedSnapshotTabs matches fresh tab sessions, consumption-based", async () => {
  const now = Date.now();
  const { get, settle } = loadBackend({
    overrides: {
      sessions: {
        getRecentlyClosed: async () => [
          // fresh matches
          { lastModified: now - 5000, tab: { sessionId: "s1", url: "https://a/1" } },
          { lastModified: now - 5000, tab: { sessionId: "s2", url: "https://a/dup" } },
          { lastModified: now - 5000, tab: { sessionId: "s3", url: "https://a/dup" } },
          // lastModified in SECONDS (Firefox quirk) -- must still count as fresh
          { lastModified: Math.floor((now - 5000) / 1000), tab: { sessionId: "s4", url: "https://b/1" } },
          // stale: closed long before this start
          { lastModified: now - 3600000, tab: { sessionId: "s5", url: "https://a/stale" } },
          // closed window, not a tab
          { lastModified: now - 5000, window: { sessionId: "w1" } },
          // fresh but not in any snapshot
          { lastModified: now - 5000, tab: { sessionId: "s6", url: "https://elsewhere/" } },
        ],
      },
    },
  });
  await settle();
  const Brainer = get("Brainer");
  const workspaces = [
    { id: WSP_A, tabSnapshot: ["https://a/1", "https://a/dup", "https://a/dup", "https://a/stale"] },
    { id: WSP_B, tabSnapshot: ["https://b/1"] },
  ];
  const { matches, matchCount } = await Brainer._findRecentlyClosedSnapshotTabs(workspaces);
  assert.equal(matchCount, 4, "3 fresh A-matches (dup consumed twice, stale skipped) + 1 B-match");
  const bySession = Object.fromEntries(matches.map(m => [m.sessionId, m.wspId]));
  assert.deepEqual(bySession, { s1: WSP_A, s2: WSP_A, s3: WSP_A, s4: WSP_B });
});

test("_findRecentlyClosedSnapshotTabs survives an API failure", async () => {
  const { get, settle } = loadBackend({
    overrides: { sessions: { getRecentlyClosed: async () => { throw new Error("nope"); } } },
  });
  await settle();
  const Brainer = get("Brainer");
  const result = await Brainer._findRecentlyClosedSnapshotTabs([{ id: WSP_A, tabSnapshot: ["https://a/1"] }]);
  // Field-wise: the result object comes from the vm realm, so a strict
  // deepEqual would fail on the foreign Object.prototype.
  assert.equal(result.matchCount, 0);
  assert.equal(result.matches.length, 0);
});

test("_restoreClosedTabsSafe restores, filters foreign windows, prefers extData wspId", async () => {
  const restoredIds = [];
  const { get, settle } = loadBackend({
    overrides: {
      sessions: {
        restore: async (sessionId) => {
          restoredIds.push(sessionId);
          if (sessionId === "s-fail") throw new Error("gone");
          if (sessionId === "s-foreign") return { tab: { id: 202, windowId: 9, url: "https://f/" } };
          return { tab: { id: 201, windowId: 1, url: "https://a/1" } };
        },
        // The restored tab carries its true prior workspace in extData.
        getTabValue: async (tabId) => (tabId === 201 ? WSP_B : undefined),
      },
    },
  });
  await settle();
  const Brainer = get("Brainer");
  const matches = [
    { sessionId: "s-ok", url: "https://a/1", wspId: WSP_A },
    { sessionId: "s-fail", url: "https://a/2", wspId: WSP_A },
    { sessionId: "s-foreign", url: "https://f/", wspId: WSP_A },
  ];
  const restored = await Brainer._restoreClosedTabsSafe(matches,
    { windowId: 1, validWspIds: new Set([WSP_A, WSP_B]) });
  assert.deepEqual(restoredIds, ["s-ok", "s-fail", "s-foreign"], "every match attempted");
  assert.equal(restored.length, 1, "failure and foreign-window tab excluded");
  assert.equal(restored[0].tab.id, 201);
  assert.equal(restored[0].wspId, WSP_B, "restored extData wspId wins over the URL match");
});

test("_detectSessionLoss reclassifies to tabs-closed-at-startup and reopens", async () => {
  const now = Date.now();
  const snapshot = ["https://a/1", "https://a/2", "https://a/3"];
  const restoredIds = [];
  // The boot-time init (runs during settle) also calls the detector when the
  // session sentinel is missing, as it is in this stub. Keep the window empty
  // during boot -- liveContentCount 0 makes the detector bail -- and populate
  // it only for the explicit call below, so this test exercises exactly one
  // controlled detector run.
  let booted = false;
  const { get, settle, storageData } = loadBackend({
    storageData: {
      "ld-wsp-window-1": [WSP_A],
      [`ld-wsp-${WSP_A}`]: {
        name: "Home", tabs: [], groups: [], active: true, windowId: 1,
        tabSnapshot: snapshot,
      },
    },
    overrides: {
      tabs: {
        // One live untagged content tab: liveContentCount > 0, zero matches.
        query: async () => booted ? [{ id: 50, windowId: 1, url: "https://fresh/", pinned: false }] : [],
      },
      sessions: {
        getTabValue: async () => undefined,
        getRecentlyClosed: async () =>
          snapshot.map((url, i) => ({ lastModified: now - 4000, tab: { sessionId: `s${i}`, url } })),
        restore: async (sessionId) => {
          restoredIds.push(sessionId);
          return { tab: { id: 300 + restoredIds.length, windowId: 1, url: "restored" } };
        },
      },
    },
  });
  await settle();
  booted = true;
  const Brainer = get("Brainer");
  await Brainer._detectSessionLoss(1);

  assert.deepEqual(restoredIds, ["s0", "s1", "s2"], "every matched closed tab reopened");
  const banner = storageData["ld-wsp-last-restore-error"];
  assert.ok(banner, "banner armed");
  assert.equal(banner.reason, "tabs-closed-at-startup");
  assert.equal(banner.closedMatchCount, 3);
  assert.equal(banner.restoredCount, 3);
});

test("_detectSessionLoss keeps the plain loss verdict when closed evidence is stale", async () => {
  const now = Date.now();
  const snapshot = ["https://a/1", "https://a/2", "https://a/3"];
  const restoredIds = [];
  let booted = false;   // same boot-time isolation as the test above
  const { get, settle, storageData } = loadBackend({
    storageData: {
      "ld-wsp-window-1": [WSP_A],
      [`ld-wsp-${WSP_A}`]: {
        name: "Home", tabs: [], groups: [], active: true, windowId: 1,
        tabSnapshot: snapshot,
      },
    },
    overrides: {
      tabs: {
        query: async () => booted ? [{ id: 50, windowId: 1, url: "https://fresh/", pinned: false }] : [],
      },
      sessions: {
        getTabValue: async () => undefined,
        // Same URLs, but closed an hour ago: carried over from a previous
        // session, not a startup mass-closure.
        getRecentlyClosed: async () =>
          snapshot.map((url, i) => ({ lastModified: now - 3600000, tab: { sessionId: `s${i}`, url } })),
        restore: async (sessionId) => { restoredIds.push(sessionId); return { tab: {} }; },
      },
    },
  });
  await settle();
  booted = true;
  const Brainer = get("Brainer");
  await Brainer._detectSessionLoss(1);

  assert.deepEqual(restoredIds, [], "nothing reopened");
  const banner = storageData["ld-wsp-last-restore-error"];
  assert.ok(banner, "banner armed");
  assert.equal(banner.reason, "session-not-restored");
});
