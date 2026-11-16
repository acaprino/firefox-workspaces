// tests/orphan-recovery.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

import { completeSnapshots, nativeBackup } from "./helpers/native-backup.mjs";

process.on("unhandledRejection", () => {});

// Storage layout under test: window 99 is dead and owns one workspace with a
// snapshot (exportable) and one with an empty snapshot.
function orphanStorage() {
  return completeSnapshots({
    "ld-wsp-window-99": ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    "ld-wsp-order-99": ["11111111-1111-4111-8111-111111111111"],
    "ld-wsp-11111111-1111-4111-8111-111111111111":
      { name: "Lost", tabs: [], groups: [], tabSnapshot: ["https://lost/1", "https://lost/2"] },
    "ld-wsp-22222222-2222-4222-8222-222222222222":
      { name: "Empty", tabs: [], groups: [], tabSnapshot: [] },
  });
}

// initialize() ends with a fire-and-forget sweep, so booting WITH orphan
// records lets that boot-time sweep export and detach them before any
// explicit call runs (the explicit call then returns early and proves
// nothing). Boot clean, then strand the records, so the call under test is
// the only sweep that sees them. Native writes are captured from here on.
async function bootThenStrand() {
  const env = loadBackend();
  await env.settle();
  assert.equal(env.get("Brainer")._state, "ready");
  Object.assign(env.storageData, orphanStorage());
  const native = nativeBackup();
  env.browser.runtime.connectNative = native.runtime.connectNative;
  return { ...env, created: native.archives, native };
}

const exportedUrls = (created) => created.flatMap(a => a.workspaces.flatMap(w => w.snapshot.tabs.map(t => t.url))).sort();

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
  const native = nativeBackup();
  const created = native.archives;
  const { settle, storageData } = loadBackend({ storageData: orphanStorage(), overrides: { runtime: native.runtime } });
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
  const { get, storageData, created, native } = await bootThenStrand();
  const Brainer = get("Brainer");
  native.fail(true);
  await Brainer._recoverOrphanWorkspaces();
  assert.ok("ld-wsp-window-99" in storageData,
    "window index NOT detached while the data has no JSON copy");

  // The retry succeeds once the helper works again.
  native.fail(false);
  await Brainer._recoverOrphanWorkspaces();
  assert.deepEqual(exportedUrls(created), ["https://lost/1", "https://lost/2"]);
  assert.ok(!("ld-wsp-window-99" in storageData), "detached after the successful retry");
});
