"""Profile-scoped native messaging writer. Stdout contains framed JSON only."""
import copy
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import uuid

MAX_MESSAGE = 8 * 1024 * 1024
UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$', re.I)
CONTAINER = re.compile(r'^firefox-container-\d+$')
FILENAME = re.compile(r'^workspaces-\d{8}T\d{12}Z-[0-9a-f]{32}\.json$')
DISCOVERY_HOST = 'org.hardfox.workspaces'


def require(condition, message='Invalid backup archive'):
    if not condition:
        raise ValueError(message)


def text(value, maximum=32768):
    return isinstance(value, str) and len(value) <= maximum


def timestamp(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def validate_archive(value, profile_id):
    require(isinstance(value, dict))
    require(value.get('format') == 'firefox-workspaces-backup' and value.get('version') == 1)
    require(value.get('profileId') == profile_id, 'Backup belongs to a different profile')
    require(timestamp(value.get('createdAt')) and text(value.get('extensionVersion'), 100))
    containers = value.get('containers')
    require(isinstance(containers, list) and len(containers) <= 1000)
    ids = {'firefox-default'}
    for row in containers:
        require(isinstance(row, dict) and isinstance(row.get('cookieStoreId'), str))
        cid = row['cookieStoreId']
        require(CONTAINER.fullmatch(cid) and cid not in ids)
        require(all(text(row.get(key), 500) for key in ('name', 'color', 'icon')))
        ids.add(cid)
    workspaces = value.get('workspaces')
    require(isinstance(workspaces, list) and 0 < len(workspaces) <= 500)
    seen = set()
    count = 0
    for wsp in workspaces:
        require(isinstance(wsp, dict) and text(wsp.get('sourceId'), 100))
        require(UUID.fullmatch(wsp['sourceId']) and wsp['sourceId'] not in seen)
        seen.add(wsp['sourceId'])
        require(text(wsp.get('name'), 200) and bool(wsp['name']))
        require(text(wsp.get('icon'), 100) and type(wsp.get('active')) is bool)
        require(wsp.get('color') is None or (text(wsp['color'], 7) and re.fullmatch(r'#?[0-9a-fA-F]{6}', wsp['color'])))
        require(wsp.get('containerId') is None or wsp['containerId'] in ids - {'firefox-default'})
        snapshot = wsp.get('snapshot')
        require(isinstance(snapshot, dict) and snapshot.get('version') == 1 and timestamp(snapshot.get('savedAt')))
        groups, tabs = snapshot.get('groups'), snapshot.get('tabs')
        require(isinstance(groups, list) and isinstance(tabs, list))
        keys = set()
        for group in groups:
            require(isinstance(group, dict) and text(group.get('key'), 100) and bool(group['key']))
            require(group['key'] not in keys and text(group.get('title'), 500) and text(group.get('color'), 100))
            require(type(group.get('collapsed')) is bool)
            keys.add(group['key'])
        for tab in tabs:
            require(isinstance(tab, dict) and text(tab.get('url')) and bool(tab['url']) and text(tab.get('title')))
            require(tab.get('cookieStoreId') in ids)
            require('groupKey' in tab and (tab['groupKey'] is None or tab['groupKey'] in keys))
        count += len(tabs)
    require(0 < count <= 10000, 'Empty or oversized backup')
    return value


def content_key(value):
    content = copy.deepcopy(value)
    content.pop('createdAt', None)
    for wsp in content['workspaces']:
        wsp['snapshot'].pop('savedAt', None)
    return json.dumps(content, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


class BackupHost:
    def __init__(self, directory, profile_id):
        require(isinstance(profile_id, str) and UUID.fullmatch(profile_id), 'Invalid profile configuration')
        self.directory = Path(directory).resolve(strict=True)
        self.profile_id = profile_id

    def handle(self, request):
        require(isinstance(request, dict) and request.get('profileId') == self.profile_id,
                'Connection belongs to a different profile')
        base = {'ok': True, 'profileId': self.profile_id, 'directory': str(self.directory)}
        if request.get('operation') == 'status':
            return base
        if request.get('operation') == 'list':
            return {**base, 'files': [{'id': p.name, 'bytes': p.stat().st_size}
                                    for p in self.files()[:200]]}
        if request.get('operation') == 'read':
            filename = request.get('filename')
            require(isinstance(filename, str) and FILENAME.fullmatch(filename), 'Invalid backup filename')
            path = self.directory / filename
            require(not path.is_symlink() and path.resolve().parent == self.directory)
            require(path.stat().st_size <= MAX_MESSAGE, 'Backup exceeds 8 MiB')
            offset = request.get('offset', 0)
            require(type(offset) is int and 0 <= offset <= MAX_MESSAGE)
            raw = path.read_text('ascii')
            chunk = raw[offset:offset + 65536]
            return {**base, 'text': chunk, 'nextOffset': offset + len(chunk),
                    'done': offset + len(chunk) >= len(raw)}
        require(request.get('operation') == 'backup', 'Unknown operation')
        limit = request.get('limit', 50)
        require(type(limit) is int and 2 <= limit <= 200, 'Version limit must be 2..200')
        value = validate_archive(request.get('archive'), self.profile_id)
        encoded = json.dumps(value, ensure_ascii=True, indent=2, allow_nan=False).encode('utf-8')
        require(len(encoded) <= MAX_MESSAGE, 'Backup exceeds 8 MiB')
        # Normal history records A -> B -> A. Emergency preservation also
        # checks older files so recurring orphan sets cannot flood the history.
        candidates = self.files()
        for previous in candidates:
            try:
                require(previous.stat().st_size <= MAX_MESSAGE)
                saved = validate_archive(json.loads(previous.read_text('utf-8')), self.profile_id)
                if content_key(saved) == content_key(value):
                    # A normal latest-file duplicate can apply a reduced limit.
                    # An older emergency match must survive its acknowledgement.
                    warning = None if request.get('emergency') is True else self.prune(limit)
                    return {**base, 'filename': previous.name, 'savedAt': saved['createdAt'],
                            'unchanged': True, 'retentionWarning': warning}
                if request.get('emergency') is not True:
                    break
            except (ValueError, OSError, TypeError, KeyError):
                pass  # An unreadable previous file is preserved, never replaced.
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        filename = f'workspaces-{stamp}-{uuid.uuid4().hex}.json'
        target = self.directory / filename
        temporary = self.directory / (filename + '.tmp')
        try:
            with temporary.open('xb') as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            # Random names prevent collision; no existing dated backup is a target.
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return {**base, 'filename': filename, 'savedAt': value['createdAt'], 'unchanged': False,
                'retentionWarning': self.prune(limit)}

    def files(self):
        return sorted((p for p in self.directory.glob('workspaces-*.json')
                       if FILENAME.fullmatch(p.name) and not p.is_symlink() and p.is_file()), reverse=True)

    def prune(self, limit):
        warning = None
        # Rotate only after a successful write or verified duplicate. Unknown
        # files and backups for another profile are never deletion candidates.
        valid_count = 0
        for path in self.files():
            try:
                require(path.resolve().parent == self.directory and path.stat().st_size <= MAX_MESSAGE)
                validate_archive(json.loads(path.read_text('utf-8')), self.profile_id)
                valid_count += 1
                if valid_count > limit:
                    path.unlink()
            except (ValueError, OSError, TypeError, KeyError):
                warning = 'Some older files could not be rotated; the current backup is saved.'
        return warning


def read_exact(stream, size):
    parts = bytearray()
    while len(parts) < size:
        chunk = stream.read(size - len(parts))
        if not chunk:
            raise ValueError('Truncated native message')
        parts.extend(chunk)
    return bytes(parts)


def read_message(stream):
    first = stream.read(1)
    if not first:
        return None
    length = struct.unpack('=I', first + read_exact(stream, 3))[0]
    require(0 < length <= MAX_MESSAGE, 'Invalid native message size')
    return json.loads(read_exact(stream, length).decode('utf-8'))


def write_message(stream, value):
    raw = json.dumps(value, ensure_ascii=True, allow_nan=False).encode('utf-8')
    stream.write(struct.pack('=I', len(raw)))
    stream.write(raw)
    stream.flush()


def registered_manifests():
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Mozilla\NativeMessagingHosts') as root:
        for index in range(winreg.QueryInfoKey(root)[0]):
            name = winreg.EnumKey(root, index)
            if not name.startswith(DISCOVERY_HOST + '_'):
                continue
            try:
                with winreg.OpenKey(root, name) as key:
                    yield Path(winreg.QueryValueEx(key, '')[0])
            except OSError:
                continue


def discover(origin, manifests=None):
    match = re.fullmatch(r'moz-extension://([0-9a-f-]{36})/', origin or '', re.I)
    require(match and UUID.fullmatch(match[1]), 'Invalid extension origin')
    matches = {}
    for manifest_path in registered_manifests() if manifests is None else manifests:
        try:
            helper = manifest_path.resolve(strict=True).parent
            profile = helper.parent.parent
            require(helper == profile / 'workspaces-backups' / 'helper')
            config = json.loads((helper / 'config.json').read_text('utf-8'))
            profile_id = config['profileId']
            require(isinstance(profile_id, str) and UUID.fullmatch(profile_id))
            manifest = json.loads(manifest_path.read_text('utf-8'))
            name = DISCOVERY_HOST + '_' + profile_id.replace('-', '')
            require(manifest['name'] == name and manifest['allowed_extensions'] == ['workspaces@hardfox'])
            require(Path(manifest['path']).resolve().parent == helper)
            prefs = (profile / 'prefs.js').read_text('utf-8')
            values = re.findall(r'user_pref\("extensions\.webextensions\.uuids",\s*("(?:\\.|[^"\\])*")\s*\);', prefs)
            if not values:
                continue
            identities = json.loads(json.loads(values[-1]))
            if identities.get('workspaces@hardfox', '').lower() != match[1].lower():
                continue
            matches[str(profile)] = {'format': 'workspaces-backup-connection', 'version': 1,
                                     'profileId': profile_id, 'host': name}
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            continue
    require(len(matches) == 1, 'No unique installed backup helper matches this Firefox profile')
    profile, connection = next(iter(matches.items()))
    return {'ok': True, 'profileId': connection['profileId'], 'connection': connection,
            'directory': str(Path(profile) / 'workspaces-backups')}


def main():
    try:
        request = read_message(sys.stdin.buffer)
        if request is None:
            return
        if '--discover' in sys.argv:
            require(isinstance(request, dict) and request.get('operation') == 'discover')
            reply = discover(request.get('origin'))
            write_message(sys.stdout.buffer, reply)
            return
        folder = Path(__file__).resolve().parent
        config = json.loads((folder / 'config.json').read_text('utf-8'))
        # The destination comes from the installed location, never a message.
        host = BackupHost(folder.parent, config['profileId'])
        reply = host.handle(request)
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        reply = {'ok': False, 'error': 'Backup not saved: invalid data, configuration or filesystem error.'}
    write_message(sys.stdout.buffer, reply)


if __name__ == '__main__':
    main()
