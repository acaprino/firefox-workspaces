// tests/session-loss-predicate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

process.on("unhandledRejection", () => {});

test("_isSessionLost fires only on real loss evidence", async () => {
  const { get, settle } = loadBackend();
  await settle();
  const Brainer = get("Brainer");
  const base = {
    snapshotUrlCount: 10, taggedCount: 0, survivingUrlCount: 0,
    liveContentCount: 3, lookupFailures: 0,
  };
  assert.equal(Brainer._isSessionLost(base), true, "clean loss fires");
  assert.equal(Brainer._isSessionLost({ ...base, taggedCount: 1 }), false, "any tagged tab bails");
  assert.equal(Brainer._isSessionLost({ ...base, lookupFailures: 1 }), false, "API failure is indeterminate, not loss");
  assert.equal(Brainer._isSessionLost({ ...base, liveContentCount: 0 }), false, "no live content is refuse-to-wipe territory");
  assert.equal(Brainer._isSessionLost({ ...base, snapshotUrlCount: 1 }), false, "below minimum evidence");
  assert.equal(Brainer._isSessionLost({ ...base, survivingUrlCount: 5 }), false, "exactly half survived: not lost");
  assert.equal(Brainer._isSessionLost({ ...base, survivingUrlCount: 4 }), true, "under half survived: lost");
});

test("_snapshotFingerprint is order-insensitive and content-sensitive", async () => {
  const { get, settle } = loadBackend();
  await settle();
  const Brainer = get("Brainer");
  const a = { id: "aaa", tabSnapshot: ["https://x/1", "https://x/2"] };
  const b = { id: "bbb", tabSnapshot: ["https://y/1"] };
  assert.equal(Brainer._snapshotFingerprint([a, b]), Brainer._snapshotFingerprint([b, a]));
  const a2 = { id: "aaa", tabSnapshot: ["https://x/1", "https://x/CHANGED"] };
  assert.notEqual(Brainer._snapshotFingerprint([a, b]), Brainer._snapshotFingerprint([a2, b]));
});
