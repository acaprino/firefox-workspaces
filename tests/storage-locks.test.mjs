// tests/storage-locks.test.mjs
// Read-modify-writes outside the workspace records: the workspace order
// (X-62), the session-loss export fingerprints (X-63), the closed-tab lists
// (X-64), plus the schema-version downgrade guard (X-89).
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";
import { seedWorkspaces, wspRecord, WSP_A, WSP_B, WSP_C } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

const FOREIGN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NEW = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function threeWorkspaces() {
  return seedWorkspaces(1, [
    { id: WSP_A, name: "A", active: true, tabs: [] },
    { id: WSP_B, name: "B", tabs: [] },
    { id: WSP_C, name: "C", tabs: [] },
  ]);
}

test("saveWorkspaceOrder merges a stale popup list: unknown ids keep their place, foreign ids are dropped", async () => {
  const { get, settle, storageData } = loadBackend({ storageData: threeWorkspaces() });
  await settle();
  // The popup rendered before C existed and sends an id from another window.
  await get("WorkspaceService").saveWorkspaceOrder(1, [WSP_B, WSP_A, FOREIGN, WSP_B]);
  assert.deepEqual(storageData["ld-wsp-order-1"], [WSP_B, WSP_A, WSP_C]);
});

test("saveWorkspaceOrder waits for an in-flight order append instead of racing it", async () => {
  const { get, settle, storageData } = loadBackend({ storageData: threeWorkspaces() });
  await settle();
  const S = get("WSPStorageManager");
  await S.addWsp(NEW, 1);
  let reorder;
  // createWorkspace's append: read, (reorder arrives), write.
  await S.withOrderLock(1, async () => {
    const order = await S.getWorkspaceOrder(1);
    reorder = get("WorkspaceService").saveWorkspaceOrder(1, [WSP_B, WSP_A, WSP_C]);
    await settle(5);
    order.push(NEW);
    await S.saveWorkspaceOrder(1, order);
  });
  await reorder;
  assert.deepEqual(storageData["ld-wsp-order-1"], [WSP_B, WSP_A, WSP_C, NEW],
    "both the reorder and the appended id survive");
});



test("clearing closed tabs while a save is in flight does not bring the cleared entries back", async () => {
  const closedKey = `ld-wsp-closed-${WSP_A}`;
  const { get, settle, storageData, browser } = loadBackend({
    storageData: { ...wspRecord(WSP_A), [closedKey]: [{ url: "https://old", closedAt: 1 }] },
  });
  await settle();
  const S = get("WSPStorageManager");
  const realGet = browser.storage.local.get;
  let readDone;
  const saveHasRead = new Promise(r => { readDone = r; });
  browser.storage.local.get = async (k) => {
    const v = await realGet(k);
    if (k === closedKey) { readDone(); await settle(10); }
    return v;
  };
  const save = S.saveClosedTab(WSP_A, { url: "https://new", closedAt: 2 });
  await saveHasRead;                  // the save holds the old list
  await S.clearClosedTabs(WSP_A);     // user clicks Clear
  await save;
  assert.equal(storageData[closedKey], undefined, "the cleared list stays cleared");
});

test("a closed tab saved after its workspace was destroyed leaves no orphan list", async () => {
  const { get, settle, storageData } = loadBackend();
  await settle();
  await get("WSPStorageManager").saveClosedTab(WSP_B, { url: "https://x", closedAt: 1 });
  assert.ok(!(`ld-wsp-closed-${WSP_B}` in storageData));
});

test("a downgraded build keeps the newer stored schema version and flags it in diagnostics", async () => {
  const { get, settle, storageData } = loadBackend({ storageData: { "ld-wsp-schema-version": 3 } });
  await settle();
  assert.equal(storageData["ld-wsp-schema-version"], 3, "never stamped down");
  const diag = await get("WSPStorageManager").getDiagnostics();
  assert.equal(diag._schemaVersion, 2);
  assert.equal(diag._storedSchemaVersion, 3);
  assert.equal(diag._schemaDowngrade, true);
});

test("an older stored schema is upgraded and not flagged", async () => {
  const { get, settle, storageData } = loadBackend({ storageData: { "ld-wsp-schema-version": 1 } });
  await settle();
  assert.equal(storageData["ld-wsp-schema-version"], 2);
  const diag = await get("WSPStorageManager").getDiagnostics();
  assert.equal(diag._storedSchemaVersion, 1);
  assert.equal(diag._schemaDowngrade, undefined);
});
