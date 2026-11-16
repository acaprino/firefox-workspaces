import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, seedWorkspaces, WSP_A, WSP_B } from "./helpers/world.mjs";
import { makeStorageArea } from "./helpers/load-backend.mjs";

import { completeSnapshots, nativeBackup } from "./helpers/native-backup.mjs";

const LOST = ["https://lost.test/1", "https://lost.test/2"];
const SHARED = "https://shared.test/";

function restartStorage(windowId, records, detected) {
  const storage = seedWorkspaces(windowId, records);
  if (detected) {
    delete storage["primary-window-id"];
    storage["primary-window-last-id"] = windowId;
  }
  return storage;
}

for (const detected of [true, false]) {
  test(`backup failure preserves snapshots and can retry (${detected ? "detected restart" : "live repair"})`, async t => {
    const oldId = detected ? 7 : 1;
    const storage = restartStorage(oldId, [{id:WSP_A,name:"Recovery",active:true,tabs:[51,52],tabSnapshot:LOST,
      recoverySnapshot:{version:1,savedAt:1,tabs:LOST.map(url=>({url,title:url,cookieStoreId:"firefox-default",groupKey:null})),groups:[]}}], detected);
    const world=makeWorld({tabs:[{id:1,url:"https://unrelated.test/",active:true}],storage,sessionAlive:false});
    let attempts = 0;
    completeSnapshots(storage);
    const native = nativeBackup({ onWrite: async () => { attempts++; } });
    world.overrides.runtime = native.runtime;
    const connect = native.runtime.connectNative;
    let fail = true;
    world.overrides.runtime = { connectNative: () => { attempts++; if (fail) throw new Error("Disk unavailable"); return connect(); } };
    const env=await world.boot(); t.after(()=>world.teardown());
    assert.ok(attempts>0);
    assert.equal(env.get("Brainer")._state,"uninitialized");
    assert.deepEqual(world.record(WSP_A).tabSnapshot,LOST);
    assert.deepEqual(world.record(WSP_A).recoverySnapshot.tabs.map(tab=>tab.url),LOST);
    assert.ok(world.storage[`ld-wsp-window-${oldId}`].includes(WSP_A));
    fail=false;
    assert.equal(await env.get("Brainer").retryInitialize("test"),true);
    assert.equal(world.storage["primary-window-id"],1);
    assert.ok(native.archives.some(a => JSON.stringify(a.workspaces[0].snapshot.tabs.map(t => t.url)) === JSON.stringify(LOST)));
  });

  test(`tagged tabs consume duplicate snapshot rows (${detected ? "detected restart" : "live repair"})`, async t => {
    const storage=restartStorage(detected ? 7 : 1,[
      {id:WSP_A,name:"A",active:true,tabs:[51],tabSnapshot:[SHARED]},
      {id:WSP_B,name:"B",tabs:[52],tabSnapshot:[SHARED]},
    ],detected);
    const world=makeWorld({tabs:[{id:1,url:SHARED,active:true},{id:2,url:SHARED,hidden:true}],
      storage,sessionValues:{1:WSP_A},sessionAlive:false});
    await world.boot(); t.after(()=>world.teardown()); await world.idle();
    assert.deepEqual(world.record(WSP_A).tabs,[1]);
    assert.deepEqual(world.record(WSP_B).tabs,[2]);
  });

  test(`duplicate snapshot URLs match their original containers (${detected ? "detected restart" : "live repair"})`, async t => {
    const row=(container)=>({version:1,savedAt:1,tabs:[{url:SHARED,title:SHARED,cookieStoreId:container,groupKey:null}],groups:[]});
    const storage=restartStorage(detected ? 7 : 1,[
      {id:WSP_A,name:"A",active:true,tabs:[51],tabSnapshot:[SHARED],recoverySnapshot:row("firefox-container-1")},
      {id:WSP_B,name:"B",tabs:[52],tabSnapshot:[SHARED],recoverySnapshot:row("firefox-container-2")},
    ],detected);
    const world=makeWorld({tabs:[{id:1,url:SHARED,active:true,cookieStoreId:"firefox-container-2"},
      {id:2,url:SHARED,hidden:true,cookieStoreId:"firefox-container-1"}],storage,sessionAlive:false});
    await world.boot(); t.after(()=>world.teardown()); await world.idle();
    assert.deepEqual(world.record(WSP_A).tabs,[2]);
    assert.deepEqual(world.record(WSP_B).tabs,[1]);
  });
}

test("a failed pre-commit activation keeps the source index and workspace metadata for retry", async t=>{
  const storage=restartStorage(7,[
    {id:WSP_A,name:"Original A",icon:"home",color:"#123456",active:true,tabs:[51],tabSnapshot:["https://a.test/"]},
    {id:WSP_B,name:"Original B",tabs:[53],tabSnapshot:["https://b.test/"]},
  ],true);
  const world=makeWorld({tabs:[{id:1,url:"https://a.test/",active:true},{id:3,url:"https://b.test/",hidden:true}],
    sessionValues:{1:WSP_A,3:WSP_B},storage,sessionAlive:false});
  const query=world.overrides.tabs.query; let failed=false;
  world.overrides.tabs.query=async options=>{
    if(!failed && world.record(WSP_A).windowId===1 && world.storage["primary-window-id"]==null){
      failed=true; throw new Error("Transient activation read failure");
    }
    return query(options);
  };
  const env=await world.boot(); t.after(()=>world.teardown());
  assert.equal(failed,true);
  assert.equal(world.storage["primary-window-last-id"],7);
  assert.deepEqual(world.storage["ld-wsp-window-7"],[WSP_A,WSP_B]);
  await env.get("Brainer").initialize(); await world.idle();
  assert.equal(env.get("Brainer")._state,"ready");
  assert.equal(world.record(WSP_A).name,"Original A");
  assert.equal(world.record(WSP_A).icon,"home");
  assert.equal(world.record(WSP_A).color,"#123456");
  assert.equal(world.record(WSP_B).name,"Original B");
  assert.equal(world.storage["ld-wsp-window-7"],undefined);
});

test("old-index cleanup failure after commit leaves the completed restore ready", async t => {
  const world = makeWorld({
    tabs: [{ id: 1, url: "https://a.test/", active: true }],
    sessionValues: { 1: WSP_A }, sessionAlive: false,
    storage: restartStorage(7, [{ id: WSP_A, name: "Original", active: true,
      tabs: [51], tabSnapshot: ["https://a.test/"] }], true),
  });
  const area = makeStorageArea(world.storage);
  let failed = false;
  world.overrides.storage.local = { ...area, remove: async keys => {
    if ([].concat(keys).includes("ld-wsp-window-7")) {
      failed = true;
      throw new Error("Temporary old index cleanup failure");
    }
    return area.remove(keys);
  } };
  const env = await world.boot(); t.after(() => world.teardown());
  assert.equal(failed, true);
  assert.equal(env.get("Brainer")._state, "ready");
  assert.equal(world.storage["primary-window-id"], 1);
  assert.equal(world.storage["primary-window-last-id"], undefined);
  assert.equal(world.storage["ld-wsp-last-restore-error"], undefined);
  assert.equal(world.record(WSP_A).name, "Original");
});

test("a late onStartup backup failure pauses tracking and preserves snapshots", async t => {
  const world = makeWorld({ tabs: [{ id: 1, url: "https://unrelated.test/", active: true }],
    storage: seedWorkspaces(1, [{ id: WSP_A, name: "Original", active: true, tabs: [1] }]) });
  const env = await world.boot(); t.after(() => world.teardown());
  await env.get("WSPStorageManager").mutateWorkspace(WSP_A, wsp => {
    wsp.tabSnapshot = [...LOST]; wsp.recoverySnapshot = null;
  });
  await env.browser.sessions.removeTabValue(1, "wspId");
  env.browser.runtime.connectNative = () => { throw new Error("Backup unavailable"); };
  await env.browser.runtime.onStartup._listeners[0]();
  assert.equal(env.get("Brainer")._state, "uninitialized");
  assert.deepEqual(world.record(WSP_A).tabSnapshot, LOST);
  assert.equal(world.storage["ld-wsp-last-restore-error"].reason, "init-failure");
});

test("an unknown session tag still permits recovery from a saved URL", async t => {
  const world = makeWorld({ tabs: [{ id: 1, url: "https://b.test/", active: true }],
    sessionValues: { 1: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, sessionAlive: false,
    storage: restartStorage(7, [
      { id: WSP_A, name: "A", active: true, tabs: [51], tabSnapshot: ["https://a.test/"] },
      { id: WSP_B, name: "B", tabs: [52], tabSnapshot: ["https://b.test/"] },
    ], true),
  });
  await world.boot(); t.after(() => world.teardown());
  assert.deepEqual(world.record(WSP_B).tabs, [1]);
});

test("failed Give up keeps automatic recovery armed when saved content arrives", async t => {
  const url = "https://saved.test/";
  const world = makeWorld({ tabs: [{ id: 1, url: "about:blank", active: true }],
    sessionAlive: false,
    storage: restartStorage(1, [{ id: WSP_A, name: "Saved", active: true,
      tabs: [50], tabSnapshot: [url] }], true),
  });
  world.overrides.runtime = { connectNative: () => { throw new Error("Backup unavailable"); } };
  const env = await world.boot(); t.after(() => world.teardown());
  const brainer = env.get("Brainer");
  const pending = brainer._pendingRestore;
  assert.ok(pending);
  await assert.rejects(brainer.giveUpRestore(world.storage["ld-wsp-last-restore-error"].when), /backup/);
  assert.deepEqual(brainer._pendingRestore, pending);
  world.navigate(1, url);
  await world.idle(); await env.settle(650);
  assert.equal(brainer._state, "ready");
  assert.deepEqual(world.record(WSP_A).tabs, [1]);
});
