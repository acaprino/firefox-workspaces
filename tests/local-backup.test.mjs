import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedWorkspaces, WSP_A } from './helpers/world.mjs';
import { makeEvent } from './helpers/load-backend.mjs';

const PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTION = { format: 'workspaces-backup-connection', version: 1,
  profileId: PROFILE, host: 'org.hardfox.workspaces_' + PROFILE.replaceAll('-', '') };
const URL = 'https://example.test/shared';

async function fixture(t) {
  const world = makeWorld({
    tabs: [{ id: 1, url: URL, active: true, cookieStoreId: 'firefox-container-1' },
      { id: 2, url: URL, cookieStoreId: 'firefox-container-2' }],
    containers: [1, 2].map(i => ({ cookieStoreId: `firefox-container-${i}`, name: `Account ${i}`, color: 'blue', icon: 'circle' })),
    sessionValues: { 1: { wspId: WSP_A, wspGroup: 'trading' }, 2: { wspId: WSP_A, wspGroup: 'trading' } },
    storage: seedWorkspaces(1, [{ id: WSP_A, name: 'Home', active: true, tabs: [1, 2],
      tabSnapshot: [URL, URL], groups: [{ key: 'trading', title: 'Trading', color: 'blue', collapsed: false }] }]),
  });
  const messages = [];
  const alarms = new Map();
  const onAlarm = makeEvent();
  world.overrides.alarms = { onAlarm, create: (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name) };
  world.overrides.runtime = { getManifest: () => ({ version: '2.6.61' }), connectNative: () => {
    const port = { onMessage: makeEvent(), onDisconnect: makeEvent(), disconnect() {}, postMessage(message) {
      messages.push(structuredClone(message));
      queueMicrotask(() => port.onMessage._listeners.forEach(fn => fn({ ok: true, connection: CONNECTION, profileId: PROFILE,
        directory: 'test-profile/workspaces-backups', filename: 'workspaces-test.json', savedAt: message.archive?.createdAt })));
    } };
    return port;
  } };
  const env = await world.boot();
  t.after(() => world.teardown());
  await world.idle();
  const service = env.get('LocalBackupService');
  await service.configure(CONNECTION);
  return { world, env, service, messages, alarms, onAlarm };
}

test('automatic backup keeps duplicate URLs, containers and native Trading group', async t => {
  const { service, messages, env } = await fixture(t);
  const result = await service.run();
  assert.equal(result.ok, true);
  const archive = messages.find(m => m.operation === 'backup').archive;
  assert.equal(env.get('LocalBackupData').read(archive), archive);
  assert.deepEqual(archive.workspaces[0].snapshot.tabs.map(t => t.cookieStoreId), ['firefox-container-1', 'firefox-container-2']);
  assert.equal(archive.workspaces[0].snapshot.groups[0].title, 'Trading');
  assert.equal(archive.workspaces[0].snapshot.tabs[0].groupKey, archive.workspaces[0].snapshot.tabs[1].groupKey);
});

test('startup and recovery warning prevent automatic file writes', async t => {
  const { service, messages, env, world } = await fixture(t);
  env.get('Brainer')._state = 'restoring';
  assert.equal((await service.run()).ok, false);
  env.get('Brainer')._state = 'ready';
  world.storage['ld-wsp-last-restore-error'] = { reason: 'session-not-restored', when: 1 };
  assert.equal((await service.run()).ok, false);
  assert.equal(messages.filter(m => m.operation === 'backup').length, 0);
});

test('session read failure never falls back to a stale snapshot', async t => {
  const { service, messages, env } = await fixture(t);
  env.browser.sessions.getTabValue = async () => { throw new Error('unavailable'); };
  assert.equal((await service.run()).ok, false);
  assert.equal(messages.filter(m => m.operation === 'backup').length, 0);
});

test('five minute alarm is rearmed, reports failures and disable stops it', async t => {
  const { service, alarms, env } = await fixture(t);
  assert.equal(alarms.get(service.ALARM).periodInMinutes, 5);
  alarms.clear();
  await service.start();
  assert.equal(alarms.get(service.ALARM).periodInMinutes, 5);
  env.browser.runtime.connectNative = () => { throw new Error('host missing'); };
  const failed = await service.run();
  assert.equal(failed.ok, false);
  assert.match((await service.status()).error, /helper/i);
  await service.disable();
  assert.equal(alarms.size, 0);
  assert.equal((await service.status()).enabled, false);
});

test('changing retention while paused does not restart backups, explicit resume does', async t => {
  const { service, alarms } = await fixture(t);
  await service.disable();
  await service.setLimit(10);
  assert.equal((await service.status()).enabled, false);
  assert.equal((await service.status()).limit, 10);
  assert.equal(alarms.size, 0);
  await service.resume();
  assert.equal((await service.status()).enabled, true);
  assert.equal(alarms.get(service.ALARM).periodInMinutes, 5);
});

test('manual backup remains available while automatic scheduling is paused', async t => {
  const { service, alarms, messages, env } = await fixture(t);
  await service.disable();
  const result = await env.get('_handleMessage')({ action: 'backupNow' });
  assert.equal(result.ok, true);
  assert.equal(messages.filter(m => m.operation === 'backup').length, 1);
  assert.equal((await service.status()).enabled, false);
  assert.equal(alarms.size, 0);
});

test('JSON import reuses group/container restore without bookmarks', async t => {
  const { service, messages, world } = await fixture(t);
  await service.run();
  const value = messages.find(m => m.operation === 'backup').archive;
  const restored = await service.restore(value, 0, 1);
  await world.idle();
  const record = world.record(restored.wspId);
  assert.deepEqual([...record.tabs].map(id => world.tab(id).cookieStoreId), ['firefox-container-1', 'firefox-container-2']);
  assert.equal(record.groups[0].title, 'Trading');
  assert.notEqual(record.groups[0].key, value.workspaces[0].snapshot.groups[0].key);
});

test('JSON import rejects wrong identity or unsafe URLs before opening tabs', async t => {
  const { service, messages, world, env } = await fixture(t);
  await service.run();
  const value = messages.find(m => m.operation === 'backup').archive;
  const before = world.order(1);
  value.workspaces[0].snapshot.tabs[0].url = 'javascript:alert(1)';
  await assert.rejects(service.restore(value, 0, 1), /URL/);
  value.workspaces[0].snapshot.tabs[0].url = URL;
  env.browser.contextualIdentities.get = async () => ({ name: 'Other account', color: 'blue', icon: 'circle' });
  await assert.rejects(service.restore(value, 0, 1), /container/i);
  assert.deepEqual(world.order(1), before);
});

test('single-tab restore adds only that tab to the current workspace with its container', async t => {
  const { service, messages, world } = await fixture(t);
  await service.run();
  const value = messages.find(m => m.operation === 'backup').archive;
  const before = [...world.order(1)];
  const restored = await service.restoreTab(value, 0, 1, 1);
  await world.idle();
  assert.equal(world.order(1).length, before.length + 1);
  assert.equal(world.tab(restored.tabId).cookieStoreId, 'firefox-container-2');
  assert.equal(restored.wspId, WSP_A);
  assert.ok(world.record(WSP_A).tabs.includes(restored.tabId));
  assert.ok(before.every(id => world.tab(id)));
});

test('restore-all keeps open workspaces and restores empty workspaces too', async t => {
  const { service, messages, world } = await fixture(t);
  await service.run();
  const value = messages.find(m => m.operation === 'backup').archive;
  value.workspaces.push({ ...structuredClone(value.workspaces[0]), sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Empty', active: false, snapshot: { version: 1, savedAt: 1, tabs: [], groups: [] } });
  const result = await service.restoreAll(value, 1);
  await world.idle();
  assert.equal(result.complete, true);
  assert.equal(result.results.length, 2);
  assert.equal(world.record(result.results[1].wspId).name, 'Empty');
  assert.ok(world.record(WSP_A));
  assert.equal(world.order(1).length, 4);
});

test('the Firefox startup blank page restores as about:blank in restore-all', async t => {
  const { service, messages, world } = await fixture(t);
  await service.run();
  const archive = messages.find(m => m.operation === 'backup').archive;
  archive.workspaces[0].snapshot.tabs[0].url = 'chrome://browser/content/blanktab.html';
  const result = await service.restoreAll(archive, 1);
  assert.equal(result.complete, true);
  assert.equal(world.tab(world.record(result.results[0].wspId).tabs[0]).url, 'about:blank');
});

test('old bookmark fingerprints never satisfy the JSON backup commit guard', async t => {
  const { service, env, world } = await fixture(t);
  const wsp = await env.get('WSPStorageManager').getWorkspace(WSP_A);
  world.storage['ld-wsp-session-loss-export'] = ['legacy-success'];
  env.browser.runtime.connectNative = () => { throw new Error('host missing'); };
  const result = await env.get('Brainer')._exportSnapshotsSafe([wsp]);
  assert.equal(result.complete, false);
  assert.equal(result.deduped, false);
  assert.ok(world.record(WSP_A));
});

test('malformed emergency snapshots cannot be committed as complete JSON', async t => {
  const { service, messages, world } = await fixture(t);
  const wsp = structuredClone(world.record(WSP_A));
  wsp.recoverySnapshot = { version: 1 };
  await assert.rejects(service.exportSnapshots([wsp]), /complete recovery snapshot/);
  assert.equal(messages.filter(m => m.operation === 'backup').length, 0);
  assert.ok(world.record(WSP_A));
});

test('concurrent emergency preservation verifies files and deduplicates repeated content', async t => {
  const { nativeBackup } = await import('./helpers/native-backup.mjs');
  const { service, env } = await fixture(t);
  await service.run();
  const native = nativeBackup();
  env.browser.runtime.connectNative = native.runtime.connectNative;
  const first = await env.get('WSPStorageManager').getWorkspace(WSP_A);
  const second = { ...first, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Other' };
  const results = await Promise.all([service.exportSnapshots([first]), service.exportSnapshots([second]), service.exportSnapshots([first])]);
  assert.deepEqual(results.map(r => r.deduped), [false, false, true]);
  assert.equal(native.archives.length, 2);
});

for (const key of ['wspId', 'wspGroup']) {
  for (const scope of ['workspace', 'tab']) {
    test(`${scope} restore reports incomplete metadata when ${key} cannot be saved`, async t => {
      const { service, messages, world, env } = await fixture(t);
      await service.run();
      const archive = messages.find(m => m.operation === 'backup').archive;
      const original = env.browser.sessions.setTabValue;
      env.browser.sessions.setTabValue = async (id, name, value) => {
        if (name === key) throw new Error('Metadata unavailable');
        return original(id, name, value);
      };
      const result = scope === 'tab' ? await service.restoreTab(archive, 0, 0, 1) : await service.restore(archive, 0, 1);
      assert.equal(result.complete, false);
      assert.match(result.error, /metadata|Metadata/);
      assert.ok(world.record(WSP_A), 'existing workspace retained');
      assert.ok(world.tab(1) && world.tab(2), 'existing tabs retained');
    });
  }
}

for (const scope of ['workspace', 'tab', 'all']) {
  test(`${scope} restore preserves group metadata and reports partial when native group update fails`, async t => {
    const { service, messages, world, env } = await fixture(t);
    await service.run();
    const archive = messages.find(m => m.operation === 'backup').archive;
    const update = env.browser.tabGroups.update;
    env.browser.tabGroups.update = async () => { throw new Error('Group metadata unavailable'); };
    const result = scope === 'tab' ? await service.restoreTab(archive, 0, 0, 1)
      : scope === 'all' ? await service.restoreAll(archive, 1) : await service.restore(archive, 0, 1);
    assert.equal(result.complete, false);
    assert.equal(world.storage['ld-wsp-last-restore-error'].reason, 'manual-restore-incomplete');
    await world.idle();
    const restored = scope === 'all' ? result.results[0] : result;
    assert.equal(world.record(restored.wspId).groups.at(-1).title, 'Trading');
    env.browser.tabGroups.update = update;
    const workspace = await env.get('WSPStorageManager').getWorkspace(restored.wspId);
    await workspace._rebuildGroups();
    assert.ok((await env.browser.tabGroups.query({ windowId: 1 })).some(g => g.title === 'Trading'));
  });
}
