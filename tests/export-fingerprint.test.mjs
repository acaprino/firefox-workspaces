// tests/export-fingerprint.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

process.on("unhandledRejection", () => {});

// Arrays returned from the backend are built with the vm realm's Array, whose
// prototype is not identical to this module's Array.prototype. assert/strict's
// deepEqual (deepStrictEqual) compares [[Prototype]] by ===, so a structurally
// correct result would fail purely on realm identity. Spreading through `[...]`
// re-materializes each result as a this-realm array before comparison; contents
// (verified separately) are untouched. This is a harness artifact, not a
// production defect - the code returns a genuine array (Array.isArray is true).
const norm = (arr) => [...arr];

test("fingerprint list: add, dedupe, cap, legacy string migration", async () => {
  const { get, settle } = loadBackend();
  await settle();
  const WSPStorageManager = get("WSPStorageManager");
  const LIMITS = get("LIMITS");

  assert.deepEqual(norm(await WSPStorageManager.getSessionLossExportFingerprints()), []);

  await WSPStorageManager.addSessionLossExportFingerprint("fp-1");
  await WSPStorageManager.addSessionLossExportFingerprint("fp-2");
  await WSPStorageManager.addSessionLossExportFingerprint("fp-1"); // duplicate
  assert.deepEqual(norm(await WSPStorageManager.getSessionLossExportFingerprints()), ["fp-1", "fp-2"]);

  for (let i = 3; i <= LIMITS.MAX_EXPORT_FINGERPRINTS + 2; i++) {
    await WSPStorageManager.addSessionLossExportFingerprint("fp-" + i);
  }
  const list = await WSPStorageManager.getSessionLossExportFingerprints();
  assert.equal(list.length, LIMITS.MAX_EXPORT_FINGERPRINTS, "bounded");
  assert.ok(!list.includes("fp-1"), "oldest evicted");
});

test("legacy single-string value reads as a one-element list", async () => {
  const { get, settle } = loadBackend({
    storageData: { "ld-wsp-session-loss-export": "legacy-fp" },
  });
  await settle();
  const WSPStorageManager = get("WSPStorageManager");
  assert.deepEqual(norm(await WSPStorageManager.getSessionLossExportFingerprints()), ["legacy-fp"]);
});

test("_exportSnapshotsSafe dedupes via the list and two distinct sets coexist", async () => {
  const { get, settle } = loadBackend();
  await settle();
  const Brainer = get("Brainer");
  const setA = [{ id: "wsA", name: "A", tabSnapshot: ["https://a/1", "https://a/2"] }];
  const setB = [{ id: "wsB", name: "B", tabSnapshot: ["https://b/1", "https://b/2"] }];

  const r1 = await Brainer._exportSnapshotsSafe(setA);
  assert.equal(r1.deduped, false);
  assert.equal(r1.folders, 1);

  const r2 = await Brainer._exportSnapshotsSafe(setB); // different content
  assert.equal(r2.deduped, false, "set B must not be blocked by set A's fingerprint");

  const r3 = await Brainer._exportSnapshotsSafe(setA); // repeat of A
  assert.equal(r3.deduped, true, "set A stays deduped even after set B was recorded");
  const r4 = await Brainer._exportSnapshotsSafe(setB); // repeat of B
  assert.equal(r4.deduped, true);
});
