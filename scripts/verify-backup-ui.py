"""Check the packaged backup entry point in real Firefox on an isolated profile."""
import argparse
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time


class Marionette:
    def __init__(self, port):
        deadline = time.monotonic() + 40
        while True:
            try:
                self.socket = socket.create_connection(('127.0.0.1', port), timeout=30)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(.2)
        self.stream = self.socket.makefile('rb')
        self.sequence = 0
        self.receive()

    def receive(self):
        length = bytearray()
        while True:
            char = self.stream.read(1)
            if not char:
                raise EOFError('Firefox closed the Marionette connection')
            if char == b':':
                break
            length.extend(char)
        return json.loads(self.stream.read(int(length)))

    def command(self, name, parameters=None):
        self.sequence += 1
        payload = json.dumps([0, self.sequence, name, parameters or {}]).encode()
        self.socket.sendall(str(len(payload)).encode() + b':' + payload)
        while True:
            response = self.receive()
            if response[0] == 1 and response[1] == self.sequence:
                if response[2]:
                    raise RuntimeError(f'{name}: {response[2]}')
                return response[3]

    def script(self, body, *arguments):
        source = ('const done = arguments[arguments.length - 1];'
                  '(async (...args) => {' + body + '})(...Array.from(arguments).slice(0,-1))'
                  '.then(value => done(JSON.stringify(value ?? null)),'
                  'error => done(JSON.stringify({error: String(error)})));')
        result = self.command('WebDriver:ExecuteAsyncScript',
                              {'script': source, 'args': list(arguments), 'sandbox': 'system'})
        value = json.loads(result['value'])
        if isinstance(value, dict) and 'error' in value:
            raise RuntimeError(value['error'])
        return value

    def close(self):
        try:
            self.command('Marionette:Quit')
        finally:
            self.stream.close()
            self.socket.close()


def verify(firefox, artifact, screenshot=None):
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='workspaces-release-ui-') as directory:
        profile = Path(directory)
        preferences = {'marionette.port': port, 'browser.startup.homepage': 'about:blank',
                       'browser.aboutwelcome.enabled': False, 'browser.shell.checkDefaultBrowser': False,
                       'browser.startup.homepage_override.mstone': 'ignore',
                       'extensions.update.enabled': False, 'app.update.auto': False}
        (profile / 'user.js').write_text('\n'.join(
            f'user_pref({json.dumps(key)}, {json.dumps(value)});' for key, value in preferences.items()))
        client = None
        with open(os.devnull, 'wb') as log:
            process = subprocess.Popen([str(firefox), '--headless', '--marionette', '--no-remote',
                                        '--new-instance', '--profile', str(profile)], stdout=log,
                                       stderr=subprocess.STDOUT,
                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                                       env={**os.environ, 'MOZ_HEADLESS': '1',
                                            'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS': '1'})
            try:
                client = Marionette(port)
                client.command('WebDriver:NewSession', {'capabilities': {'alwaysMatch': {}}})
                client.command('Marionette:SetContext', {'value': 'chrome'})
                identity = client.script('''
const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
file.initWithPath(args[0]);
const addon = await AddonManager.installTemporaryAddon(file);
return {version: addon.version, base: WebExtensionPolicy.getByID(addon.id).extension.baseURI.spec};
''', str(artifact))
                client.command('Marionette:SetContext', {'value': 'content'})
                client.command('WebDriver:Navigate', {'url': identity['base'] + 'popup/wsp.html'})
                entry = client.script('''
const link = document.getElementById('backupHistory'); link.focus();
return {display: getComputedStyle(link).display, width: link.getBoundingClientRect().width,
        focused: document.activeElement === link, href: link.getAttribute('href')};
''')
                assert entry['display'] != 'none' and entry['width'] > 0 and entry['focused'], entry
                assert entry['href'] == 'backups.html', entry
                element = client.command('WebDriver:FindElement', {'using': 'css selector',
                                                                  'value': '#backupHistory'})
                element_id = element['value']['element-6066-11e4-a52e-4f735466cecf']
                client.command('WebDriver:ElementClick', {'id': element_id})
                settings = client.script('''
document.querySelector('details').open = true;
return {title: document.title, automaticConnection: !document.getElementById('connection'),
        settingsVisible: document.getElementById('limit').getClientRects().length > 0,
        backupVisible: document.getElementById('backup-now').getClientRects().length > 0};
''')
                assert settings['title'] == 'Workspaces backup history' and settings['automaticConnection'] and settings['settingsVisible'] and settings['backupVisible'], settings
                if screenshot:
                    picture = client.command('WebDriver:TakeScreenshot', {'full': False})
                    screenshot.write_bytes(base64.b64decode(picture['value']))
                print(json.dumps({'version': identity['version'], 'entry': entry, 'settings': settings}))
            finally:
                if client:
                    try:
                        client.close()
                    except (OSError, EOFError, RuntimeError):
                        pass
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=10)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--firefox', required=True, type=Path)
    parser.add_argument('--artifact', required=True, type=Path)
    parser.add_argument('--screenshot', type=Path)
    options = parser.parse_args()
    verify(options.firefox.resolve(strict=True), options.artifact.resolve(strict=True), options.screenshot)
