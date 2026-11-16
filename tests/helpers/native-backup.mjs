import { makeEvent } from './load-backend.mjs';
export const PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const CONNECTION = { format: 'workspaces-backup-connection', version: 1, profileId: PROFILE,
  host: 'org.hardfox.workspaces_' + PROFILE.replaceAll('-', ''), enabled: true, limit: 50 };

// Explicit fixture upgrade: old recovery tests supplied only URL snapshots.
// Their simulated file backup now has complete per-tab metadata before boot.
export function completeSnapshots(storage) {
  storage['ld-wsp-local-backup'] = { ...CONNECTION };
  for (const [key, value] of Object.entries(storage)) {
    if (!/^ld-wsp-[0-9a-f-]{36}$/.test(key) || value.recoverySnapshot) continue;
    value.recoverySnapshot = { version: 1, savedAt: 1, groups: [], tabs: (value.tabSnapshot || []).map(url =>
      ({ url, title: url, cookieStoreId: value.containerId || 'firefox-default', groupKey: null })) };
  }
  return storage;
}

export function nativeBackup({ onWrite = async () => {} } = {}) {
  const archives = [];
  let failing = false;
  const connectNative = () => {
    const port = { onMessage: makeEvent(), onDisconnect: makeEvent(), disconnect() {}, postMessage(request) {
      queueMicrotask(async () => {
        try {
          if (failing) throw new Error('Disk unavailable');
          const archive = request.archive;
          let filename = 'workspaces-test.json';
          let unchanged = false;
          if (request.operation === 'backup') {
            const key = a => JSON.stringify({ ...a, createdAt: 0, workspaces: a.workspaces.map(w =>
              ({ ...w, snapshot: { ...w.snapshot, savedAt: 0 } })) });
            unchanged = (request.emergency ? archives : archives.slice(-1)).some(a => key(a) === key(archive));
            if (!unchanged) { await onWrite(archive); archives.push(structuredClone(archive)); }
          }
          port.onMessage._listeners.forEach(fn => fn({ ok: true, connection: CONNECTION, profileId: PROFILE, directory: 'fixture',
            filename, savedAt: archive?.createdAt || 1, unchanged }));
        } catch (error) {
          port.onMessage._listeners.forEach(fn => fn({ ok: false, error: error.message }));
        }
      });
    } };
    return port;
  };
  return { archives, runtime: { connectNative }, fail(value) { failing = value; } };
}
