import copy
import io
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backup_host import BackupHost, read_message, write_message, MAX_MESSAGE

PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'


def archive():
    return {'format': 'firefox-workspaces-backup', 'version': 1,
            'profileId': PROFILE, 'createdAt': 1234, 'extensionVersion': '2.6.61',
            'containers': [{'cookieStoreId': 'firefox-container-1', 'name': 'Trading',
                            'color': 'blue', 'icon': 'circle'}],
            'workspaces': [{'sourceId': PROFILE, 'name': 'Home', 'icon': 'home',
                            'color': None, 'containerId': None, 'active': True,
                            'snapshot': {'version': 1, 'savedAt': 1234,
                                         'groups': [{'key': 'group1', 'title': 'Trading',
                                                     'color': 'blue', 'collapsed': False}],
                                         'tabs': [{'url': 'https://example.test/', 'title': 'Example',
                                                   'cookieStoreId': 'firefox-container-1', 'groupKey': 'group1'}]}}]}


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.host = BackupHost(self.root, PROFILE)

    def write(self, value=None):
        return self.host.handle({'operation': 'backup', 'profileId': PROFILE,
                                 'archive': value if value is not None else archive()})

    def test_roundtrip_and_dedup_ignore_timestamps(self):
        result = self.write()
        path = self.root / result['filename']
        self.assertEqual(json.loads(path.read_text('utf-8')), archive())
        later = archive()
        later['createdAt'] += 200
        later['workspaces'][0]['snapshot']['savedAt'] += 200
        duplicate = self.write(later)
        self.assertTrue(duplicate['unchanged'])
        self.assertEqual(duplicate['filename'], result['filename'])
        self.assertEqual(len(list(self.root.glob('workspaces-*.json'))), 1)

    def test_changed_state_keeps_previous_file(self):
        original = self.write()['filename']
        value = archive()
        value['workspaces'][0]['snapshot']['tabs'][0]['url'] += 'changed'
        self.write(value)
        self.assertEqual(json.loads((self.root / original).read_text('utf-8')), archive())
        self.assertEqual(len(list(self.root.glob('workspaces-*.json'))), 2)

    def test_emergency_dedup_checks_existing_files_but_normal_history_records_return_to_old_state(self):
        first = self.write()['filename']
        changed = archive()
        changed['workspaces'][0]['name'] = 'Changed'
        self.write(changed)
        result = self.host.handle({'operation': 'backup', 'profileId': PROFILE,
                                  'archive': archive(), 'emergency': True})
        self.assertTrue(result['unchanged'])
        self.assertEqual(result['filename'], first)
        self.assertEqual(len(self.host.files()), 2)
        self.assertFalse(self.write()['unchanged'])
        self.assertEqual(len(self.host.files()), 3)
        (self.root / first).unlink()
        self.write(changed)
        for path in self.host.files():
            if json.loads(path.read_text())['workspaces'][0]['name'] == 'Home':
                path.unlink()
        self.assertFalse(self.host.handle({'operation': 'backup', 'profileId': PROFILE,
                                          'archive': archive(), 'emergency': True})['unchanged'])

    def test_chunked_unicode_roundtrip_stays_below_native_reply_limit(self):
        value = archive()
        value['workspaces'][0]['snapshot']['tabs'] *= 800
        value['workspaces'][0]['snapshot']['tabs'][0]['title'] = 'Caffè ☕'
        filename = self.write(value)['filename']
        text, offset = '', 0
        while True:
            reply = self.host.handle({'operation': 'read', 'profileId': PROFILE,
                                     'filename': filename, 'offset': offset})
            self.assertLess(len(json.dumps(reply).encode()), 1024 * 1024)
            text += reply['text']
            offset = reply['nextOffset']
            if reply['done']:
                break
        self.assertGreater(offset, 65536)
        self.assertEqual(json.loads(text), value)

    def test_failed_atomic_publish_keeps_old_backup(self):
        original = self.write()['filename']
        value = archive()
        value['workspaces'][0]['name'] = 'Changed'
        with patch('backup_host.os.replace', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError, 'disk full'):
                self.write(value)
        self.assertTrue((self.root / original).is_file())
        self.assertEqual(len(list(self.root.glob('workspaces-*.json'))), 1)
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_refuses_other_profile_and_unknown_operations(self):
        for request in [{'operation': 'backup', 'profileId': 'other', 'archive': archive()},
                        {'operation': '../../outside', 'profileId': PROFILE}]:
            with self.assertRaises(ValueError):
                self.host.handle(request)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_invalid_or_empty_archive_never_written(self):
        for change in [lambda a: a.update(version=99),
                       lambda a: a.update(workspaces=[]),
                       lambda a: a.update(containers=[]),
                       lambda a: a.update(profileId='other'),
                       lambda a: a['workspaces'][0]['snapshot']['tabs'][0].update(groupKey='missing'),
                       lambda a: a['workspaces'][0]['snapshot'].update(tabs=[])]:
            value = copy.deepcopy(archive())
            change(value)
            with self.assertRaises(ValueError):
                self.write(value)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_framing_handles_unicode_and_truncated_or_oversized_input(self):
        stream = io.BytesIO()
        write_message(stream, {'title': 'Caffè 日本語'})
        stream.seek(0)
        self.assertEqual(read_message(stream), {'title': 'Caffè 日本語'})
        self.assertIsNone(read_message(io.BytesIO()))
        for data in [b'\x00', struct.pack('=I', 99) + b'{}', struct.pack('=I', MAX_MESSAGE + 1)]:
            with self.assertRaises(ValueError):
                read_message(io.BytesIO(data))

    def test_history_rotation_and_chunked_read_only_touch_owned_files(self):
        unknown = self.root / 'user-notes.json'
        unknown.write_text('keep me')
        for i in range(4):
            value = archive()
            value['workspaces'][0]['name'] = f'Home {i}'
            self.host.handle({'operation': 'backup', 'profileId': PROFILE, 'archive': value, 'limit': 2})
        listing = self.host.handle({'operation': 'list', 'profileId': PROFILE})
        self.assertEqual(len(listing['files']), 2)
        newest = listing['files'][0]['id']
        result = self.host.handle({'operation': 'read', 'profileId': PROFILE, 'filename': newest, 'offset': 0})
        self.assertTrue(result['done'])
        self.assertEqual(json.loads(result['text'])['workspaces'][0]['name'], 'Home 3')
        self.assertEqual(unknown.read_text(), 'keep me')
        with self.assertRaises(ValueError):
            self.host.handle({'operation': 'read', 'profileId': PROFILE, 'filename': '../outside.json'})

    def test_failed_write_does_not_rotate(self):
        for i in range(3):
            value = archive()
            value['workspaces'][0]['name'] = str(i)
            self.write(value)
        with patch('backup_host.os.replace', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.host.handle({'operation': 'backup', 'profileId': PROFILE, 'archive': archive(), 'limit': 2})
        self.assertEqual(len(self.host.files()), 3)

    def test_reduced_limit_applies_to_verified_latest_duplicate(self):
        for i in range(5):
            value = archive()
            value['workspaces'][0]['name'] = str(i)
            self.write(value)
        result = self.host.handle({'operation': 'backup', 'profileId': PROFILE, 'archive': value, 'limit': 2})
        self.assertTrue(result['unchanged'])
        self.assertEqual(len(self.host.files()), 2)

    def test_invalid_files_do_not_consume_valid_history_slots(self):
        invalid = self.root / ('workspaces-99991231T235959000000Z-' + 'f' * 32 + '.json')
        invalid.write_text('not JSON')
        for i in range(4):
            value = archive()
            value['workspaces'][0]['name'] = str(i)
            self.host.handle({'operation': 'backup', 'profileId': PROFILE, 'archive': value, 'limit': 2})
        self.assertTrue(invalid.exists())
        self.assertEqual(len([p for p in self.host.files() if p != invalid]), 2)

    def test_installer_is_profile_scoped_and_reuses_identity(self):
        from install import install
        first = install(self.root, register=False)
        connection = json.loads(first.read_text('utf-8'))
        self.assertEqual(connection, json.loads(install(self.root, register=False).read_text('utf-8')))
        helper = self.root / 'workspaces-backups/helper'
        manifest = json.loads((helper / (connection['host'] + '.json')).read_text('utf-8'))
        self.assertEqual(manifest['allowed_extensions'], ['workspaces@hardfox'])
        self.assertEqual(Path(manifest['path']).parent, helper)


if __name__ == '__main__':
    unittest.main()
