# Profile JSON backup helper (Windows)

Version history lives only in `<Firefox profile>/workspaces-backups/*.json`. Python 3.10+ and the standard library are required. Firefox starts the helper on demand through Native Messaging; no server or scheduled Windows task is needed.

## Setup

1. Install Python 3.10+ for the current Windows user.
2. Run `python native/install.py --profile "C:\FirefoxPortable\Data\profile"` from the repository, replacing the example with your profile directory. In the separate helper ZIP, use `python install.py --profile "C:\FirefoxPortable\Data\profile"`.
3. Backups connect automatically and are enabled by default. Open **Backup history** to see the first saved version, normally within a few seconds after startup. No connection file selection is required.

The installer creates the helper, launcher, configuration and native host manifest inside that profile. It registers a unique `org.hardfox.workspaces_<profile UUID>` host in `HKCU\Software\Mozilla\NativeMessagingHosts`. No administrator rights are needed. Only `workspaces@hardfox` may connect. `--no-register` prepares files without registration.

If Firefox Portable moves to another path or computer, rerun the installer. The Python path and registration belong to that Windows installation. Existing configuration keeps its profile UUID and JSON history. The helper matches the extension's profile-specific origin against installed profiles; ambiguous or unknown profiles are never guessed. An explicit pause is preserved across restarts. Existing connections remain supported.

Install the helper for every Firefox profile. Byte-for-byte copies retain both the extension UUID and backup identity, so they cannot be distinguished from their original by origin alone; use separately created Firefox profiles for independent backups. Updating from an older helper requires rerunning the installer once to register automatic discovery.

## Capture and restore

- Settled changes trigger capture after six seconds, following existing tab snapshot updates. Periodic checks run every five minutes while Firefox runs, starting one minute after extension startup.
- Keep 2..200 versions, default 50. Normal dedup compares the latest file, preserving A -> B -> A history. Emergency preservation verifies matching files across history. A reduced limit applies on the next successful backup check.
- Validate, flush a new temporary file, then publish a dated JSON atomically. Rotate only after publication or verification of the latest duplicate. Older emergency matches remain present when acknowledged. Unknown files and another profile's archives are preserved.
- Incomplete recovery, changing ownership, pending recovery warnings and placeholder-only sessions pause capture. Disk/helper failures appear in history. Give up retains old indexes and retry until complete snapshots have been saved successfully.
- Restore one tab into the active compatible workspace, one workspace or all as new workspaces. Existing tabs remain open. Original container identity metadata must match. Partial restoration is reported and pauses automatic backups until reviewed; inspect opened tabs before retrying to avoid duplicates.

Files contain URLs/titles, workspace appearance, containers and group metadata. They exclude cookies, passwords, page/form history and pinned tabs. Protected browser URLs cannot be reopened; select individual web tabs. Firefox's startup blank page reopens as `about:blank`.

Limits: 8 MiB / 10,000 tabs per archive, 1,000 tabs per restore. File reads use 64 KiB chunks. Losing the whole Firefox profile also loses its JSON backups.

Bookmark backup/restore has been removed. Existing bookmarks remain accessible through Firefox. Extension storage retains current workspace/recovery state and connection/status, with no copy of version history.

## Verification

Run `python -m unittest discover -s native -p "test_*.py"`. Node tests cover capture, scheduling, granular restore and failures. Integration verification uses an isolated real Firefox profile and removes only its own temporary registration.

Reference: [Mozilla Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging).
