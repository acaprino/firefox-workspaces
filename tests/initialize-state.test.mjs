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

async function healthyBackend() {
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
  await env.settle();
  return env;
}

test("a toolbar failure after initialization keeps workspace commands available", async () => {
  const env = await healthyBackend();
  let titleAttempts = 0;
  env.browser.browserAction.setTitle = async () => {
    if (++titleAttempts === 1) throw new Error("Toolbar temporarily unavailable");
  };

  await assert.rejects(env.get("Brainer").initialize(), /Toolbar temporarily unavailable/);

  assert.equal(titleAttempts, 1, "exercise the final toolbar refresh failure");
  assert.equal(env.get("Brainer")._state, "ready");
  assert.equal(env.get("Brainer")._initStarted, false);
  const result = await env.get("_handleMessage")({
    action: "renameWorkspace", wspId: WSP_ID, wspName: "Renamed",
  });
  assert.equal(result.success, true, "workspace commands must remain usable after the UI failure");
  assert.equal(env.storageData[`ld-wsp-${WSP_ID}`].name, "Renamed");
});

test("a failure before workspace initialization still blocks workspace commands", async () => {
  const env = await healthyBackend();
  env.get("WSPStorageManager").ensureSchemaVersion = async () => {
    throw new Error("Storage temporarily unavailable");
  };

  await assert.rejects(env.get("Brainer").initialize(), /Storage temporarily unavailable/);

  assert.equal(env.get("Brainer")._state, "uninitialized");
  assert.equal(env.get("Brainer")._initStarted, false);
  const result = await env.get("_handleMessage")({
    action: "renameWorkspace", wspId: WSP_ID, wspName: "Renamed",
  });
  assert.equal(result.retriable, true);
  assert.equal(env.storageData[`ld-wsp-${WSP_ID}`].name, "Home");
});
