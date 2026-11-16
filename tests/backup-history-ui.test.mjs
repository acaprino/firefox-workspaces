import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPopup } from './helpers/popup-dom.mjs';

const archive = { format: 'firefox-workspaces-backup', version: 1, createdAt: 1,
  containers: [], workspaces: [{ name: 'Home', snapshot: { groups: [], tabs: [
    { title: 'Trading', url: 'https://example.test/', cookieStoreId: 'firefox-default', groupKey: null },
  ] } }] };
const files = [{ id: 'workspaces-20261116T140000000000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json', bytes: 200 }];

async function open(replies = {}) {
  const p = loadPopup({ page: 'backups.html', replies: {
    backupStatus: { enabled: true, limit: 50, directory: 'profile/workspaces-backups' },
    backupHistory: files, backupRead: archive, ...replies,
  } });
  await p.settle(20);
  return p;
}

test('history previews the first available file and enables granular restore', async () => {
  const p = await open();
  assert.equal(p.$('workspaces').options.length, 1);
  assert.equal(p.$('tabs').options.length, 1);
  assert.equal(p.$('restore-all').disabled, false);
  assert.match(p.$('summary').textContent, /1 workspaces.*1 tabs/);
});

test('a failed file selection clears the old preview and disables every restore action', async () => {
  let fail = false;
  const p = await open({ backupRead: () => fail ? { _error: true, message: 'File unavailable' } : archive });
  fail = true;
  p.fire(p.$('versions'), 'change');
  await p.settle();
  assert.match(p.$('status').textContent, /File unavailable/);
  for (const scope of ['tab', 'workspace', 'all']) assert.equal(p.$('restore-' + scope).disabled, true);
  assert.equal(p.$('tabs').options.length, 0);
});

test('native history failure is reported without claiming there are no saved files', async () => {
  const p = await open({ backupHistory: { _error: true, message: 'Helper unavailable' } });
  assert.match(p.$('status').textContent, /Helper unavailable/);
  assert.equal(p.$('restore-all').disabled, true);
});

test('history remains reachable from the main popup while startup has no primary window', async () => {
  const p = loadPopup({ replies: { getPrimaryWindowId: null } });
  await p.settle(20);
  assert.notEqual(p.$('backupHistory').style.display, 'none');
  assert.equal(p.$('backupHistory').getAttribute('href'), 'backups.html');
});
