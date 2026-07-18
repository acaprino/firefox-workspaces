// tests/orphan-detection.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

process.on("unhandledRejection", () => {});

// Arrays returned from the backend are built with the vm realm's Array, whose
// prototype is not identical to this module's Array.prototype. assert/strict's
// deepEqual (deepStrictEqual) compares [[Prototype]] by ===, so a structurally
// correct result would fail purely on realm identity. Spreading through `[...]`
// re-materializes the result as a this-realm array before comparison; contents
// are untouched. This is a harness artifact, not a production defect - the code
// returns a genuine array (Array.isArray is true). Same treatment as
// export-fingerprint.test.mjs.
const norm = (arr) => [...arr];

test("_findOrphanWindowIds classifies window keys correctly", async () => {
  const { get, settle } = loadBackend();
  await settle();
  const Brainer = get("Brainer");

  const snapshot = {
    "ld-wsp-window-1": ["uuid-a"],          // live primary -> not orphan
    "ld-wsp-window-7": ["uuid-b"],          // armed lastId -> not orphan (retry loop owns it)
    "ld-wsp-window-8": ["uuid-c"],          // live secondary window -> not orphan
    "ld-wsp-window-99": ["uuid-d"],         // dead, non-empty -> ORPHAN
    "ld-wsp-window-100": [],                // dead but empty -> ignore
    "ld-wsp-window-abc": ["uuid-e"],        // malformed id -> ignore
    "ld-wsp-order-99": ["uuid-d"],          // different key family -> ignore
    "ld-wsp-uuid-d": { name: "X" },         // workspace state key -> ignore
    "primary-window-id": 1,
  };
  const orphans = Brainer._findOrphanWindowIds(snapshot, {
    liveWindowIds: new Set([1, 8]),
    primaryId: 1,
    lastId: 7,
  });
  assert.deepEqual(norm(orphans), [99]);
});

test("_findOrphanWindowIds with null primary/lastId (post-crash first start)", async () => {
  const { get, settle } = loadBackend();
  await settle();
  const Brainer = get("Brainer");
  const orphans = Brainer._findOrphanWindowIds(
    { "ld-wsp-window-3": ["uuid-x"], "ld-wsp-window-4": ["uuid-y"] },
    { liveWindowIds: new Set([4]), primaryId: null, lastId: null },
  );
  assert.deepEqual(norm(orphans), [3]);
});
