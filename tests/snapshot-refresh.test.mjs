// tests/snapshot-refresh.test.mjs
// X-17: a snapshot refresh still pending when the primary window closes must
// not replace the last good tabSnapshot with the empty result of querying
// the closed window. tabSnapshot is restore's URL fallback, refuse-to-wipe's
// evidence and the session-loss export's content.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B } from "./helpers/world.mjs";

process.on("unhandledRejection", () => {});

const SNAPSHOT = ["https://a.test/1", "https://a.test/2"];

// Window 1 is primary; window 2 keeps Firefox running after it closes.
async function boot() {
  const world = makeWorld({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      { id: 1, url: "https://a.test/1", active: true },
      { id: 2, url: "https://a.test/2" },
      { id: 3, url: "https://b.test/1", hidden: true },
      { id: 20, windowId: 2, url: "https://other.test/", active: true },
    ],
    sessionValues: { 1: WSP_A, 2: WSP_A, 3: WSP_B },
    storage: seedWorkspaces(1, [
      { id: WSP_A, name: "A", active: true, tabs: [1, 2], tabSnapshot: SNAPSHOT },
      { id: WSP_B, name: "B", tabs: [3], tabSnapshot: ["https://b.test/1"] },
    ]),
    autoEvents: false,
  });
  const env = await world.boot();
  const TabService = env.get("TabService");
  TabService._SNAPSHOT_DEBOUNCE_MS = 20;
  return { world, env, TabService };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

test("closing the primary window cancels its pending snapshot refreshes", async (t) => {
  const { world, env, TabService } = await boot();
  t.after(() => world.teardown());
  TabService._scheduleSnapshotRefresh(1, WSP_A);
  world.closeWindow(1);
  await Promise.all(env.browser.windows.onRemoved._listeners.map(fn => fn(1)));
  assert.equal(TabService._snapshotTimers.size, 0, "nothing left to fire");
  await wait(60);
  assert.deepEqual(world.record(WSP_A).tabSnapshot, SNAPSHOT);
  assert.equal(world.storage["primary-window-last-id"], 1, "restart signal armed as before");
});

test("a refresh firing after its window closed keeps the snapshot even without onRemoved", async (t) => {
  const { world, TabService } = await boot();
  t.after(() => world.teardown());
  TabService._scheduleSnapshotRefresh(1, WSP_A);
  world.closeWindow(1); // no listener runs (autoEvents off)
  await wait(60);
  assert.deepEqual(world.record(WSP_A).tabSnapshot, SNAPSHOT);
  assert.deepEqual(world.record(WSP_A).tabs, [1, 2]);
});

test("control: a refresh in a live window still records the new URLs", async (t) => {
  const { world, TabService } = await boot();
  t.after(() => world.teardown());
  world.navigate(2, "https://a.test/2-next");
  TabService._scheduleSnapshotRefresh(1, WSP_A);
  await wait(60);
  assert.deepEqual(world.record(WSP_A).tabSnapshot, ["https://a.test/1", "https://a.test/2-next"]);
});
