"""Install a dedicated native host inside one Firefox profile (Windows)."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import uuid


def install(profile, register=True):
    profile = Path(profile).resolve(strict=True)
    if not profile.is_dir():
        raise ValueError('The profile must be an existing directory')
    directory = profile / 'workspaces-backups'
    helper = directory / 'helper'
    helper.mkdir(parents=True, exist_ok=True)
    # Refuse a junction/symlink that escapes the selected profile.
    if helper.resolve().parent.parent != profile:
        raise ValueError('Backup directory must stay inside the selected profile')
    config_file = helper / 'config.json'
    if config_file.exists():
        config = json.loads(config_file.read_text('utf-8'))
        profile_id = str(uuid.UUID(config['profileId']))
    else:
        profile_id = str(uuid.uuid4())
    name = 'org.hardfox.workspaces_' + profile_id.replace('-', '')
    python = Path(sys.executable).resolve()
    # Batch interpolation is never used with unvalidated user-supplied text.
    for path in (python, helper):
        if any(char in str(path) for char in '%!"\r\n'):
            raise ValueError('Unsupported characters in Python or profile path')
    source = Path(__file__).with_name('backup_host.py')
    if source.resolve() != (helper / 'backup_host.py').resolve():
        shutil.copy2(source, helper / 'backup_host.py')
    (helper / 'launch.bat').write_text(
        f'@echo off\nchcp 65001>nul\nsetlocal DisableDelayedExpansion\n"{python}" -I -u "{helper / "backup_host.py"}"\n',
        encoding='utf-8')
    config_file.write_text(json.dumps({'profileId': profile_id}, indent=2), encoding='utf-8')
    manifest = helper / (name + '.json')
    manifest.write_text(json.dumps({'name': name, 'description': 'Workspaces profile backups',
                                   'path': str(helper / 'launch.bat'), 'type': 'stdio',
                                   'allowed_extensions': ['workspaces@hardfox']}, indent=2), encoding='utf-8')
    (helper / 'discover.bat').write_text(
        f'@echo off\nchcp 65001>nul\nsetlocal DisableDelayedExpansion\n"{python}" -I -u "{helper / "backup_host.py"}" --discover\n',
        encoding='utf-8')
    discovery_manifest = helper / 'org.hardfox.workspaces.json'
    discovery_manifest.write_text(json.dumps({'name': 'org.hardfox.workspaces',
        'description': 'Workspaces automatic profile connection', 'path': str(helper / 'discover.bat'),
        'type': 'stdio', 'allowed_extensions': ['workspaces@hardfox']}, indent=2), encoding='utf-8')
    connection = directory / 'connection.json'
    connection.write_text(json.dumps({'format': 'workspaces-backup-connection', 'version': 1,
                                      'host': name, 'profileId': profile_id}, indent=2), encoding='utf-8')
    if register:
        if os.name != 'nt':
            raise ValueError('Registration is supported on Windows only')
        import winreg
        key_name = 'Software\\Mozilla\\NativeMessagingHosts\\' + name
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_name) as key:
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, str(manifest))
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, 'Software\\Mozilla\\NativeMessagingHosts\\org.hardfox.workspaces') as key:
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, str(discovery_manifest))
    return connection


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, help='Existing Firefox profile directory')
    parser.add_argument('--no-register', action='store_true', help='Prepare files without changing the registry')
    arguments = parser.parse_args()
    print(install(arguments.profile, register=not arguments.no_register))
