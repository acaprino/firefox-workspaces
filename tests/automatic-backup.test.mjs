import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedWorkspaces, WSP_A } from './helpers/world.mjs';
import { makeEvent } from './helpers/load-backend.mjs';
import { CONNECTION } from './helpers/native-backup.mjs';

const ORIGIN = 'moz-extension://bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/';

async function fixture(t, settings = null, missing = false) {
  const storage = seedWorkspaces(1, [{ id: WSP_A, name: 'Home', active: true, tabs: [1] }]);
  if (settings) storage['ld-wsp-local-backup'] = structuredClone(settings);
  const world = makeWorld({ tabs: [{ id: 1, url: 'https://example.test/', active: true }],
    sessionValues: { 1: WSP_A }, storage });
  const calls = [], alarms = new Map(), onAlarm = makeEvent();
  const helper = { missing, connection: CONNECTION, rejected: false };
  world.overrides.alarms = { onAlarm, create: async (name, value) => alarms.set(name, value),
    clear: async name => alarms.delete(name) };
  world.overrides.runtime = { getURL: () => ORIGIN, connectNative(host) {
    if (helper.missing) throw new Error('Host missing');
    const port = { onMessage: makeEvent(), onDisconnect: makeEvent(), disconnect() {}, postMessage(message) {
      calls.push({ host, ...message });
      queueMicrotask(() => port.onMessage._listeners.forEach(fn => fn({ ok: !helper.rejected,
        connection: helper.connection, profileId: helper.connection.profileId, directory: 'profile/workspaces-backups',
        filename: 'workspaces-test.json', savedAt: message.archive?.createdAt || 1 })));
    } };
    return port;
  } };
  const env = await world.boot();
  t.after(() => world.teardown());
  await world.idle();
  const service = env.get('LocalBackupService');
  await service.start();
  return { world, env, service, calls, alarms, onAlarm, helper };
}

test('first startup connects the current profile and backs up automatically without a file', async t => {
  const { service, calls, alarms, onAlarm, world } = await fixture(t);
  assert.equal((await service.status()).enabled, true);
  assert.equal(calls.filter(c => c.operation === 'discover').length, 1);
  assert.equal(calls[0].host, 'org.hardfox.workspaces');
  assert.equal(calls[0].origin, ORIGIN);
  assert.equal(alarms.get(service.ALARM).delayInMinutes, .1);
  onAlarm._listeners.forEach(fn => fn({ name: service.ALARM }));
  await world.idle();
  assert.equal(calls.filter(c => c.operation === 'backup').length, 1);
  assert.equal((await service.status()).ok, true);
});

test('explicit pause survives startup and manual backups do not enable scheduling', async t => {
  const { service, calls, alarms } = await fixture(t, { ...CONNECTION, enabled: false });
  assert.equal((await service.status()).enabled, false);
  assert.equal(calls.length, 0);
  assert.equal(alarms.size, 0);
  assert.equal((await service.run({ manual: true })).ok, true);
  assert.equal((await service.status()).enabled, false);
});

test('a missing helper retries automatically and respects pause before first connection', async t => {
  const { service, helper, alarms, calls } = await fixture(t, null, true);
  assert.match((await service.status()).error, /helper/i);
  assert.equal((await service.status()).enabled, true);
  assert.ok(alarms.has(service.ALARM));
  await service.disable();
  helper.missing = false;
  await service.start();
  assert.equal((await service.status()).enabled, false);
  assert.equal(calls.length, 0);
  assert.equal(alarms.size, 0);
  await service.resume();
  assert.equal((await service.run()).ok, true);
  assert.equal((await service.status()).enabled, true);
});

test('an existing connection is verified once per startup and keeps its retention', async t => {
  const { service, calls } = await fixture(t, { ...CONNECTION, limit: 17 });
  assert.equal((await service.status()).limit, 17);
  assert.equal(calls.filter(c => c.operation === 'discover').length, 1);
  await service.run();
  assert.equal(calls.filter(c => c.operation === 'discover').length, 1);
});

test('manual backup after pausing before first connection preserves the pause', async t => {
  const { service, helper, alarms } = await fixture(t, null, true);
  await service.disable();
  helper.missing = false;
  assert.equal((await service.run({ manual: true })).ok, true);
  assert.equal((await service.status()).enabled, false);
  assert.equal(alarms.size, 0);
});

test('a copied connection cannot bypass refused profile discovery', async t => {
  const { service, helper, calls, env } = await fixture(t, { ...CONNECTION, enabled: false });
  await env.browser.storage.local.set({ [service.KEY]: { ...CONNECTION, enabled: true } });
  helper.rejected = true;
  const result = await service.run();
  assert.equal(result.ok, false);
  await assert.rejects(service.list(), /helper/i);
  await assert.rejects(service.read('workspaces-test.json'), /helper/i);
  assert.equal(calls.filter(c => c.operation === 'backup').length, 0);
});

test('startup replaces a stale connection with the discovered current profile', async t => {
  const oldId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const { service, calls } = await fixture(t, { ...CONNECTION, limit: 11, profileId: oldId,
    host: 'org.hardfox.workspaces_' + oldId.replaceAll('-', '') });
  assert.equal((await service.settings()).profileId, CONNECTION.profileId);
  assert.equal((await service.status()).limit, 11);
  await service.run();
  assert.equal(calls.at(-1).host, CONNECTION.host);
});
