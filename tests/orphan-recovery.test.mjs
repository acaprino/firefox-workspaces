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

test("sweep exports orphan snapshots and detaches the dead window index", async () => {
  const created = [];
  const { get, settle, storageData, browser } = loadBackend({
    storageData: orphanStorage(),
  });
  const origCreate = browser.bookmarks.create;
  browser.bookmarks.create = async (b) => { created.push(b); return origCreate(b); };
  await settle();

  const Brainer = get("Brainer");
  await Brainer._recoverOrphanWorkspaces();

  const urls = created.filter(b => b.url).map(b => b.url);
  assert.deepEqual(urls.sort(), ["https://lost/1", "https://lost/2"], "snapshot URLs exported");
  assert.ok(!("ld-wsp-window-99" in storageData), "dead window index detached");
  assert.ok("ld-wsp-11111111-1111-4111-8111-111111111111" in storageData,
    "per-workspace records preserved for diagnostics");
});

test("sweep is idempotent: second run neither re-exports nor throws", async () => {
  const { get, settle, browser } = loadBackend({ storageData: orphanStorage() });
  await settle();
  const Brainer = get("Brainer");
  await Brainer._recoverOrphanWorkspaces();

  const created = [];
  const origCreate = browser.bookmarks.create;
  browser.bookmarks.create = async (b) => { created.push(b); return origCreate(b); };
  await Brainer._recoverOrphanWorkspaces();
  assert.equal(created.length, 0, "nothing left to export or detach");
});

test("sweep keeps records when the export fails (retry next start)", async () => {
  const { get, settle, storageData, browser } = loadBackend({ storageData: orphanStorage() });
  // The boot-time fire-and-forget sweep (wired into initialize()) runs during
  // settle(). Install the failing-export override BEFORE settle so that sweep
  // also hits the export-failure path; otherwise it would detach window 99
  // with working bookmarks and leave nothing for the explicit call to keep.
  browser.bookmarks.create = async () => { throw new Error("bookmarks unavailable"); };
  await settle();
  const Brainer = get("Brainer");
  await Brainer._recoverOrphanWorkspaces();
  assert.ok("ld-wsp-window-99" in storageData,
    "window index NOT detached while the data has no bookmark copy");
});
