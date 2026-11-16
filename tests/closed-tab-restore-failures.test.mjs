import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A } from "./helpers/world.mjs";

async function fixture(t) {
  const world = makeWorld({
    tabs: [{ id: 1, url: "https://active.test/", active: true }],
    sessionValues: { 1: WSP_A },
    storage: seedWorkspaces(1, [{ id: WSP_A, name: "A", active: true, tabs: [1] }]),
  });
  const env = await world.boot(); t.after(() => world.teardown());
  const entry = { url: "https://closed.test/", title: "Closed", closedAt: 123 };
  await env.get("WSPStorageManager").saveClosedTab(WSP_A, entry);
  return { world, env, entry, service: env.get("TabService") };
}

function rejectHistoryWrites(env) {
  const set = env.browser.storage.local.set;
  env.browser.storage.local.set = async values => {
    if (Object.keys(values).includes(`ld-wsp-closed-${WSP_A}`)) throw new Error("History storage unavailable");
    return set(values);
  };
  return () => { env.browser.storage.local.set = set; };
}

test("successful tab creation survives failed history consumption and repeated clicks do not duplicate it", async t => {
  const { world, env, entry, service } = await fixture(t);
  const restoreWrites = rejectHistoryWrites(env);
  assert.equal((await service.restoreClosedTab(WSP_A, entry, 1)).url, entry.url);
  await Promise.all([service.restoreClosedTab(WSP_A, entry, 1), service.restoreClosedTab(WSP_A, entry, 1)]);
  await world.idle();
  assert.equal((await env.browser.tabs.query({ windowId: 1 })).filter(tab => tab.url === entry.url).length, 1);
  assert.equal((await service.getClosedTabs(WSP_A)).length, 1, "failed persistence retains the saved entry");
  restoreWrites();
  assert.equal((await service.restoreClosedTab(WSP_A, entry, 1)).url, entry.url);
  assert.equal((await service.getClosedTabs(WSP_A)).length, 0);
  assert.equal(await service.restoreClosedTab(WSP_A, entry, 1), null);
  assert.equal((await env.browser.tabs.query({ windowId: 1 })).filter(tab => tab.url === entry.url).length, 1);
});

test("failed creation leaves no receipt and the saved tab can still be restored", async t => {
  const { world, env, entry, service } = await fixture(t);
  const create = env.browser.tabs.create;
  env.browser.tabs.create = async () => { throw new Error("Tab creation unavailable"); };
  await assert.rejects(service.restoreClosedTab(WSP_A, entry, 1), /Tab creation unavailable/);
  env.browser.tabs.create = create;
  assert.equal((await service.restoreClosedTab(WSP_A, entry, 1)).url, entry.url);
  await world.idle();
  assert.equal((await env.browser.tabs.query({ windowId: 1 })).filter(tab => tab.url === entry.url).length, 1);
  assert.equal((await service.getClosedTabs(WSP_A)).length, 0);
});

test("pending history consumption does not suppress another closure of the same URL", async t => {
  const { world, env, entry, service } = await fixture(t);
  const second = { ...entry, closedAt: 124 };
  await env.get("WSPStorageManager").saveClosedTab(WSP_A, second);
  const restoreWrites = rejectHistoryWrites(env);
  await service.restoreClosedTab(WSP_A, entry, 1);
  await service.restoreClosedTab(WSP_A, second, 1);
  restoreWrites();
  await Promise.all([service.restoreClosedTab(WSP_A, entry, 1), service.restoreClosedTab(WSP_A, second, 1)]);
  await world.idle();
  assert.equal((await env.browser.tabs.query({ windowId: 1 })).filter(tab => tab.url === entry.url).length, 2);
  assert.equal((await service.getClosedTabs(WSP_A)).length, 0);
});

test("receipt capacity preserves earlier completions and resumes new restores after cleanup", async t => {
  const { world, env, entry, service } = await fixture(t);
  service._MAX_CLOSED_RESTORE_RECEIPTS = 1;
  const second = { url: "https://second.test/", title: "Second", closedAt: 124 };
  await env.get("WSPStorageManager").saveClosedTab(WSP_A, second);
  const restoreWrites = rejectHistoryWrites(env);
  await service.restoreClosedTab(WSP_A, entry, 1);
  await assert.rejects(service.restoreClosedTab(WSP_A, second, 1), /waiting for history storage/);
  await service.restoreClosedTab(WSP_A, entry, 1);
  assert.equal((await env.browser.tabs.query({ windowId: 1 })).filter(tab => tab.url === entry.url).length, 1);
  assert.equal((await env.browser.tabs.query({ windowId: 1 })).filter(tab => tab.url === second.url).length, 0);
  restoreWrites();
  await service.restoreClosedTab(WSP_A, entry, 1);
  await service.restoreClosedTab(WSP_A, second, 1);
  await world.idle();
  assert.equal((await env.browser.tabs.query({ windowId: 1 })).filter(tab => tab.url === second.url).length, 1);
  assert.equal((await service.getClosedTabs(WSP_A)).length, 0);
});
