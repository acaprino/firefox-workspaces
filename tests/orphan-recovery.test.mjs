// tests/orphan-recovery.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

process.on("unhandledRejection", () => {});

// Storage layout under test: window 99 is dead and owns one workspace with a
// snapshot (exportable) and one with an empty snapshot.
function orphanStorage() {
  return {
    "ld-wsp-window-99": ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    "ld-wsp-order-99": ["11111111-1111-4111-8111-111111111111"],
    "ld-wsp-11111111-1111-4111-8111-111111111111":
      { name: "Lost", tabs: [], groups: [], tabSnapshot: ["https://lost/1", "https://lost/2"] },
    "ld-wsp-22222222-2222-4222-8222-222222222222":
      { name: "Empty", tabs: [], groups: [], tabSnapshot: [] },
  };
}

// initialize() ends with a fire-and-forget sweep, so booting WITH orphan
// records lets that boot-time sweep export and detach them before any
// explicit call runs (the explicit call then returns early and proves
// nothing). Boot clean, then strand the records, so the call under test is
// the only sweep that sees them. Bookmark creations are captured from here on.
async function bootThenStrand() {
  const env = loadBackend();
  await env.settle();
  assert.equal(env.get("Brainer")._state, "ready");
  Object.assign(env.storageData, orphanStorage());
  const created = [];
  const origCreate = env.browser.bookmarks.create;
  env.browser.bookmarks.create = async (b) => { created.push(b); return origCreate(b); };
  return { ...env, created, origCreate };
}

const exportedUrls = (created) => created.filter(b => b.url).map(b => b.url).sort();

test("sweep exports orphan snapshots and detaches the dead window index", async () => {
  const { get, storageData, created } = await bootThenStrand();
  await get("Brainer")._recoverOrphanWorkspaces();

  assert.deepEqual(exportedUrls(created), ["https://lost/1", "https://lost/2"], "snapshot URLs exported");
  assert.ok(!("ld-wsp-window-99" in storageData), "dead window index detached");
  assert.ok(!("ld-wsp-order-99" in storageData), "dead window order detached");
  assert.ok("ld-wsp-11111111-1111-4111-8111-111111111111" in storageData,
    "per-workspace records preserved for diagnostics");
});

test("initialize() runs the sweep at boot (fire-and-forget wiring)", async () => {
  const created = [];
  const { settle, storageData, browser } = loadBackend({ storageData: orphanStorage() });
  const origCreate = browser.bookmarks.create;
  browser.bookmarks.create = async (b) => { created.push(b); return origCreate(b); };
  await settle();
  assert.deepEqual(exportedUrls(created), ["https://lost/1", "https://lost/2"]);
  assert.ok(!("ld-wsp-window-99" in storageData), "boot-time sweep detached the dead window");
});

test("sweep is idempotent: second run neither re-exports nor throws", async () => {
  const { get, created } = await bootThenStrand();
  const Brainer = get("Brainer");
  await Brainer._recoverOrphanWorkspaces();
  assert.ok(created.length > 0, "first run exported");

  created.length = 0;
  await Brainer._recoverOrphanWorkspaces();
  assert.equal(created.length, 0, "nothing left to export or detach");
});

test("sweep keeps records when the export fails (retry next start)", async () => {
  const { get, storageData, browser, created, origCreate } = await bootThenStrand();
  const Brainer = get("Brainer");
  browser.bookmarks.create = async () => { throw new Error("bookmarks unavailable"); };
  await Brainer._recoverOrphanWorkspaces();
  assert.ok("ld-wsp-window-99" in storageData,
    "window index NOT detached while the data has no bookmark copy");

  // The retry succeeds once bookmarks work again.
  browser.bookmarks.create = async (b) => { created.push(b); return origCreate(b); };
  await Brainer._recoverOrphanWorkspaces();
  assert.deepEqual(exportedUrls(created), ["https://lost/1", "https://lost/2"]);
  assert.ok(!("ld-wsp-window-99" in storageData), "detached after the successful retry");
});
