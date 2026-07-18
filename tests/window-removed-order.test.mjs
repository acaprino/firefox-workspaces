// tests/window-removed-order.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

process.on("unhandledRejection", () => {});

test("onWindowRemoved arms lastId BEFORE dropping the primary claim", async () => {
  const { get, browser, settle } = loadBackend();
  await settle(); // boot claims window 1 as primary via _ensureDefaultWorkspace

  const WSPStorageManager = get("WSPStorageManager");
  assert.equal(await WSPStorageManager.getPrimaryWindowId(), 1, "boot claimed primary");

  const calls = [];
  const origSet = WSPStorageManager.setPrimaryWindowLastId;
  const origRemove = WSPStorageManager.removePrimaryWindowId;
  WSPStorageManager.setPrimaryWindowLastId = async function (id) {
    calls.push("setLastId");
    return origSet.call(this, id);
  };
  WSPStorageManager.removePrimaryWindowId = async function () {
    calls.push("removePrimary");
    return origRemove.call(this);
  };

  const listener = browser.windows.onRemoved._listeners[0];
  await listener(1);

  assert.deepEqual(calls, ["setLastId", "removePrimary"],
    "a crash between the two writes must leave BOTH keys set, never neither");
  assert.equal(await WSPStorageManager.getPrimaryWindowLastId(), 1);
  // getPrimaryWindowId() returns result[key] with no `?? null` fallback
  // (storage.js), so a removed key reads back as undefined, not null.
  assert.equal(await WSPStorageManager.getPrimaryWindowId(), undefined);
});
