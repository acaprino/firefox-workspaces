import json
from pathlib import Path
import tempfile
import unittest

from install import install
from backup_host import discover

ORIGIN = 'moz-extension://bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/'


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def profile(self, name, origin=ORIGIN):
        root = self.root / name
        root.mkdir()
        connection = json.loads(install(root, register=False).read_text())
        uuids = json.dumps({'workspaces@hardfox': origin.split('/')[2]})
        (root / 'prefs.js').write_text('user_pref("extensions.webextensions.uuids", ' + json.dumps(uuids) + ');\n')
        manifest = root / 'workspaces-backups/helper' / (connection['host'] + '.json')
        return root, manifest, connection

    def test_selects_matching_profile_among_registered_profiles(self):
        _, other, _ = self.profile('other', 'moz-extension://cccccccc-cccc-4ccc-8ccc-cccccccccccc/')
        root, manifest, connection = self.profile('selected')
        reply = discover(ORIGIN, [other, manifest])
        self.assertEqual(reply['connection'], connection)
        self.assertEqual(reply['directory'], str(root / 'workspaces-backups'))
        self.assertTrue(reply['ok'])

    def test_refuses_missing_unknown_and_ambiguous_origins(self):
        _, first, _ = self.profile('first')
        _, second, _ = self.profile('clone')
        for origin, manifests in [(ORIGIN, []), ('moz-extension://unknown/', [first]),
                                  (ORIGIN, [first, second])]:
            with self.subTest(origin=origin, manifests=manifests), self.assertRaises(ValueError):
                discover(origin, manifests)

    def test_skips_unreadable_and_wrong_profile_registrations(self):
        _, manifest, connection = self.profile('good')
        _, wrong, _ = self.profile('wrong')
        value = json.loads(wrong.read_text())
        value['name'] = 'org.hardfox.workspaces_invalid'
        wrong.write_text(json.dumps(value))
        self.assertEqual(discover(ORIGIN, [self.root / 'missing', wrong, manifest])['connection'], connection)

    def test_installer_prepares_bootstrap_and_keeps_existing_identity(self):
        root, _, connection = self.profile('selected')
        install(root, register=False)
        helper = root / 'workspaces-backups/helper'
        manifest = json.loads((helper / 'org.hardfox.workspaces.json').read_text())
        self.assertEqual(manifest['allowed_extensions'], ['workspaces@hardfox'])
        self.assertIn('--discover', (helper / 'discover.bat').read_text())
        self.assertEqual(json.loads((root / 'workspaces-backups/connection.json').read_text()), connection)
