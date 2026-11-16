# Architecture and recovery contracts

The extension runs plain JavaScript in one Firefox MV2 background page. The manifest owns script order; the test harness loads the same scripts. There is no bundler or external runtime dependency.

## Ownership

| Module | Owns | Leaves to callers |
|---|---|---|
| `RecoveryData` | Current snapshot validation and legacy projection | Browser reads and persistence |
| `SnapshotService` | Strict capture, best-effort background refresh, debounce and window cancellation | Workspace locking and lifecycle decisions |
| `RestoreMatcher` | Pure assignment from session tags, URL occurrences and containers | Mutating workspaces or opening tabs |
| `Brainer` | Startup state, restore/retry sequencing, browser event coordination | Schema validation and matching policy |
| `recovery-banner.js` | Recovery reason to message and available actions | DOM updates, timestamps and backend requests |

`WSPStorageManager.mutateWorkspace` remains the single workspace mutation boundary. `WorkspaceService` owns activation and container migration sequencing. `TabService` owns live tab operations and their compensation. Their existing bidirectional dependency remains explicit; splitting it without a lifecycle redesign would only move coupling between files.

## Data and failure boundaries

1. `wspId` is the live tab's workspace session tag. `wspGroup` is its stable group key. Persist group identity and appearance, never runtime tab/group IDs as durable membership.
2. Rich snapshots contain individual URL, title, cookie store and group-key rows. `RecoveryData` validates the whole shape; invalid or legacy metadata stays URL-only. JSON history stores complete tab rows and container metadata, verified before restoration.
3. Explicit exports use strict live capture. A failed group/session read fails the export rather than relabeling an old snapshot as current. Background refresh retains its previous snapshot on acquisition failure. URL and rich snapshots change together under the workspace lock.
4. Startup preservation requires a complete automatic export before destructive reconciliation. Old-window cleanup follows the new primary-pointer commit. Failed Give up preserves retry state. A backup within this profile is not an independent copy of the profile.
5. Restore matching first reserves occurrences already claimed by authoritative session tags, then consumes remaining exact URL/container rows, then legacy URL-only rows. Identical legacy URLs without tags or container metadata remain ambiguous.

## Browser side effects

Container replacement creates a tab before attempting to close the original. A failed close triggers compensation. If the original and replacement both survive, `retainedOriginal` requires each caller to retain both IDs in workspace ownership. A resolved close promise alone is insufficient evidence that a tab disappeared: Firefox can handle a `beforeunload` prompt without closing it. See [Mozilla's tabs.remove contract](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/remove).

Creating a tab resolves before its page necessarily finishes loading; snapshot callers must retain the existing navigation refresh path. Container identity is supplied through `cookieStoreId`. See [Mozilla's tabs.create contract](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/create).

Recently closed-tab restoration serializes lookup, creation and history consumption per workspace. Failure before creation keeps the history entry retryable. A memory receipt prevents duplicate creation when history consumption fails after a successful creation; this does not provide crash durability while persistent storage is unavailable.

## UI operation ownership

Dialogs have one owner until their closing animation and focus cleanup finish. Closed-tab restore buttons hold an in-flight guard including keyboard activation. Drag reorder requests queue user intent and recompute against settled order after a prior request succeeds or rolls back. Recovery actions retain timestamp checks so an old response cannot dismiss a newer warning.

## Verification

Run `node --test --test-concurrency=1` from the repository root. Failure-injection tests exercise backup rejection, metadata read/write failures, failed browser closes, retries and overlapping user actions. The stateful browser model checks ownership and event interleavings; an isolated real Firefox profile separately checks native groups, container identity, export/restore and restart. Neither proves resilience to every crash or storage failure.

## JSON history ownership

LocalBackupData validates archives. LocalBackupService owns capture, scheduling, native messaging, history and restore preflight. WorkspaceRestoreService creates workspaces under the activation chain/reopen guard, uses strict metadata writes and reports partial restoration. Partial restoration pauses automatic file backups until reviewed.

native/backup_host.py owns atomic publication, file reading and retention. native/install.py installs a unique profile host; requests cannot supply filesystem paths. Extension storage holds connection/settings/status and live state, not version archives. Bookmark I/O, permission and picker are removed; existing bookmarks and legacy metadata are not destructively purged.
