import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

const WSP_ID = "11111111-1111-4111-8111-111111111111";

function initializedWorkspaceData() {
  return {
    "ld-wsp-schema-version": 2,
    "primary-window-id": 1,
    "ld-wsp-window-1": [WSP_ID],
    "ld-wsp-order-1": [WSP_ID],
    [`ld-wsp-${WSP_ID}`]: {
      id: WSP_ID, name: "Home", windowId: 1, active: true, tabs: [1], groups: [],
      tabSnapshot: ["https://example.com/home"],
    },
  };
}

async function healthyBackend(t) {
  const env = loadBackend({
    storageData: initializedWorkspaceData(),
    overrides: {
      storage: { session: { get: async () => ({ "wsp-session-alive": true }), set: async () => {} } },
      tabs: {
        query: async () => [{ id: 1, windowId: 1, url: "https://example.com/home", pinned: false, active: true }],
      },
      sessions: { getTabValue: async () => WSP_ID },
    },
  });
  t.after(() => {
    clearTimeout(env.get("Brainer")._initRetryTimer);
    clearTimeout(env.get("Brainer")._restoreRetryTimer);
    for (const timer of env.get("TabService")._snapshotTimers.values()) clearTimeout(timer);
  });
  await env.settle();
  return env;
}

test("a toolbar failure after initialization keeps workspace commands available", async t => {
  const env = await healthyBackend(t);
  let titleAttempts = 0;
  env.browser.browserAction.setTitle = async () => {
    if (++titleAttempts === 1) throw new Error("Toolbar temporarily unavailable");
  };

  await env.get("Brainer").initialize();

  assert.equal(titleAttempts, 1, "exercise the final toolbar refresh failure");
  assert.equal(env.get("Brainer")._state, "ready");
  assert.equal(env.get("Brainer")._initStarted, false);
  const result = await env.get("_handleMessage")({
    action: "renameWorkspace", wspId: WSP_ID, wspName: "Renamed",
  });
  assert.equal(result.success, true, "workspace commands must remain usable after the UI failure");
  assert.equal(env.storageData[`ld-wsp-${WSP_ID}`].name, "Renamed");
});

test("a failure before workspace initialization still blocks workspace commands", async t => {
  const env = await healthyBackend(t);
  env.get("WSPStorageManager").ensureSchemaVersion = async () => {
    throw new Error("Storage temporarily unavailable");
  };

  await env.get("Brainer").initialize();

  assert.equal(env.get("Brainer")._state, "uninitialized");
  assert.equal(env.get("Brainer")._initStarted, false);
  assert.equal(env.storageData["ld-wsp-last-restore-error"].reason, "init-failure");
  assert.match(env.storageData["ld-wsp-last-restore-error"].error, /Storage temporarily unavailable/);
  const result = await env.get("_handleMessage")({
    action: "renameWorkspace", wspId: WSP_ID, wspName: "Renamed",
  });
  assert.equal(result.retriable, true);
  assert.equal(env.storageData[`ld-wsp-${WSP_ID}`].name, "Home");
});
