# Firefox Workspaces - Extension

**Type:** MV2 WebExtension for Firefox 140+
**Language:** Vanilla JavaScript (no build step, no bundler)
**ID:** `workspaces@hardfox`

---

## Architecture

```
backend/          # Background scripts (loaded in order by manifest.json)
├── theme-utils.js # Shared theme helpers (accent keys, luminance) - also loaded by the popup
├── recovery-data.js # Pure validation and projection of versioned recovery records
├── storage.js    # WSPStorageManager - browser.storage.local wrapper
├── restore-matcher.js # Pure session-tag / URL / container assignment planner
├── workspace.js  # Workspace entity (create, activate, hide, destroy)
├── ui-service.js       # Toolbar button icon, badge, SVG cache, theme detection
├── menu-service.js     # Tab context menu ("Move Tab to…") + omnibox
├── workspace-service.js # Workspace CRUD, activate/deactivate, container binding
├── tab-service.js      # Tab add/remove/move, search, closed tabs, sessions, container reopen
├── snapshot-service.js # Strict snapshot capture, refresh and debounce ownership
├── local-backup-data.js # Pure JSON archive validation
├── local-backup-service.js # Capture, history, native messaging and granular restore
├── workspace-restore-service.js # Additive workspace restoration
├── brainer.js          # Orchestrator - init, event listener registration, restart recovery
└── handler.js          # Message router (popup <-> background)

popup/            # Browser action popup
├── wsp.html      # Popup markup
├── css/wsp.css   # Theme-aware stylesheet (CSS system colors + browser.theme API)
└── js/
    ├── wsp.js       # Main popup UI (WorkspaceUI class, theme detection)
    ├── recovery-banner.js # Pure recovery reason-to-message/action model
    ├── dialog.js    # Create/rename dialog (icon picker, color picker, container select)
    ├── tooltip.js   # Tab preview tooltips on workspace hover
    └── drag-drop.js # Workspace reorder via drag & drop

icons/            # layered-{light,dark}.svg = toolbar (theme_icons, setIcon)
                  # layered-{64,128}.png     = manifest `icons` key: AMO listing +
                  #   about:addons. AMO renders PNG/JPEG only, never SVG -- export
                  #   the PNGs from the SVG source, do not point `icons` at an SVG.
```

**Load order matters:** `manifest.json` `background.scripts` is authoritative; the backend test loader reads this same list. `RecoveryData` loads before storage; `brainer.js` and `handler.js` load last.

When changing snapshots, restart matching, container replacement, or recovery banners, read [docs/architecture.md](docs/architecture.md) for ownership and failure contracts.

---

## Key Concepts

### Workspace Lifecycle
- **Activate:** Show workspace tabs (`browser.tabs.show`), hide all other workspace tabs (`browser.tabs.hide`), update toolbar icon/badge.
- **Deactivate:** Snapshot current tab state, hide tabs belonging to this workspace.
- **Destroy:** Close all tabs in the workspace, remove from storage.

### Service Dependencies
`WorkspaceService` and `TabService` have a **bidirectional dependency** (both are singletons in the same MV2 background scope). `WorkspaceService` calls `TabService` for session tagging; `TabService` calls `WorkspaceService` for workspace CRUD.

### Container Integration
Each workspace can optionally bind to a Firefox Container (`contextualIdentities`). When bound, new tabs in that workspace are reopened in the container via `TabService._reopenInContainer()`.

### Theme Detection
The popup adapts to Firefox themes via a cascade:
1. `browser.theme.getCurrent()` -- extract popup colors
2. CSS system colors (`-moz-Dialog`, `AccentColor`, etc.) as fallbacks
3. `-moz-Dialog` luminance probe for dark/light detection
4. Manual toggle (LWT colors vs system colors)

### Session Persistence
Workspace-to-tab mapping survives restarts via `browser.sessions.setTabValue()`. On restart, `Brainer.initialize()` detects the restart condition (`primaryWindowLastId` present, `primaryWindowId` absent) and restores workspaces.

---

## Messaging Protocol (popup -> background)

Messages use `browser.runtime.sendMessage({ action, ... })`. Handler dispatches on `message.action`:

| `action` | Purpose |
|---|---|
| `getWorkspaces` | Get ordered workspace list for a window |
| `activateWorkspace` | Switch to a workspace |
| `createWorkspace` | Create new workspace |
| `createWorkspaceWithTab` | Create workspace and move a tab into it |
| `renameWorkspace` | Rename + update icon/color |
| `destroyWsp` | Destroy workspace and close its tabs |
| `getNumWorkspaces` | Get workspace count for a window |
| `getWorkspaceName` | Generate a default workspace name |
| `getPrimaryWindowId` | Get the tracked primary window ID |
| `hideInactiveWspTabs` | Hide tabs not in active workspace |
| `saveWorkspaceOrder` | Persist new workspace order (orderedIds array) |
| `getContainers` | List available Firefox containers |
| `setWorkspaceContainer` | Bind a workspace to a container |
| `getClosedTabs` | Get recently closed tabs for a workspace |
| `restoreClosedTab` | Reopen a closed tab in a workspace |
| `clearClosedTabs` | Clear closed-tab history for a workspace |
| `searchTabs` | Search tabs across all workspaces |
| `getTabPreviews` | Get tab title/URL previews for tooltip |
| `setDarkModeHint` | Forward popup's dark mode detection to background |
| `backupStatus` / `backupHistory` / `backupRead` | File status, chronology and contents |
| `backupConnect` / `backupLimit` / `backupDisable` / `backupResume` / `backupNow` | Configure and run JSON backups |
| `backupValidate` / `backupRestore` | Validate JSON and restore tab/workspace/all |
| `getLastRestoreError` | Read the pending restore-error/warning payload (banner) |
| `acknowledgeLastRestoreError` | Dismiss the banner (compare-and-clear via `when` echo; refreshes the "!" badge) |
| `giveUpRestoreRetry` | Drop the restore-retry signal; preserves complete snapshots in JSON first |
| `getDiagnostics` | Dump all ld-wsp-* storage keys for incident response |

---

## Development

```bash
# Run with auto-reload
web-ext run --source-dir=. --firefox="path/to/firefox"

# Package for distribution
web-ext build

# Sign for distribution (requires .env with WEB_EXT_API_KEY/WEB_EXT_API_SECRET)
# This addon is LISTED on AMO - use --channel=listed (see gotcha 1).
web-ext sign --channel=listed

# Run the test suite from the repo root (Node >= 20, no dependencies;
# `node --test tests/` does NOT work on Node 21+)
node --test
```

No build step required - load directly via `about:debugging` -> "Load Temporary Add-on" -> select `manifest.json`.

---

## Known Gotchas

1. **Extension signing - this addon is LISTED:** Release Firefox ignores `xpinstall.signatures.required=false`. Must sign via AMO for distribution. Version in `manifest.json` must be bumped before each AMO submission (duplicates are rejected). The channel is `listed` (public AMO page, `slug a5051d22878041c6be70`), NOT `unlisted` - older docs said `unlisted` and that mistake shipped 2.6.55/2.6.56 to the unlisted channel, so the public `current_version` stayed at 2.6.54. **AMO cannot move an already-uploaded version between channels and rejects duplicate version numbers**, so a version signed on the wrong channel is a dead end: you must bump again and re-sign on the right channel. Before signing, VERIFY the channel live rather than trusting docs, branch name, or `.amo-upload-uuid` (that file only records the LAST upload's channel): authenticated `GET /api/v5/addons/addon/workspaces%40hardfox/versions/?filter=all_with_unlisted` shows each version's `channel`, and `GET /api/v5/addons/addon/<slug>/` shows the public `current_version`. `scripts/sign.bat` maps `master -> listed`, `dev -> unlisted`; on `master` the listed channel is correct. After signing, re-read the public `current_version` to confirm the release actually landed on the listed page.
2. **`data_collection_permissions`:** Required in `manifest.json` for Firefox 140+. Omitting it causes AMO validation failure.
3. **`tabHide` API:** Must be enabled (default in Firefox 140+). Without it, inactive workspace tabs remain visible.
4. **Container reopen race:** `TabService._reopenInContainer()` uses `_reopeningCount` + `_forceReopenIds` guards to prevent `onCreated` from double-assigning tabs during the close-reopen window. Hold `withReopenGuard` when assigning replacements manually. A `retainedOriginal` result requires assigning both surviving tabs.
5. **Background page has no rendering context:** Theme dark/light detection via `-moz-Dialog` probe only works in the popup (which has a DOM). The popup forwards the result to background via `setDarkModeHint`.
6. **MV2 only:** This extension uses `browser_action`, `background.scripts`, and `tabHide` - all MV2 APIs. No MV3 migration planned (Firefox still supports MV2).
7. **Session-loss detection:** Brainer detects missing tags and low saved-URL survival. Complete snapshots must be acknowledged by the native JSON writer before destructive reconciliation. Incomplete snapshots or unavailable helper retain retry state and source indexes. Only actual files prove preservation, never legacy bookmark fingerprints. Current workspace/recovery snapshots stay in storage.local; JSON files are the sole version archive. See `native/README.md`. Legacy warnings describe earlier bookmark exports rather than claiming JSON exists.
8. **`lastRestoreError` write discipline:** every writer of the `ld-wsp-last-restore-error` key MUST go through `WSPStorageManager.setLastRestoreError`/`clearLastRestoreError` - they invalidate UIService's warn-badge cache at the single write point. A raw `browser.storage.local` write to that key silently desyncs the "!" toolbar badge.
9. **`_activeCache` write discipline:** anything that changes *which* workspace is active in a window MUST re-point `WorkspaceService._activeCache` (`_updateActiveCache`, or clear it) in the same operation - `activateWsp`, `createWorkspace` and `WorkspaceRestoreService.restore` all do. A cache still naming the previously active workspace is not merely slow: it carries that workspace's `containerId`, and `TabService.forceTabIntoActiveContainer` then reopens the new workspace's tabs in the *old* workspace's container and files them under it. `addTabToActiveCache(tabId, wspId)` therefore requires the owning workspace id and drops the cache on mismatch instead of extending it.
10. **AMO listing description is Markdown, and `amo-metadata.json` is its source:** `web-ext sign` uploads only the extension, never the listing metadata - the listing text is edited separately (Developer Hub, or `PATCH /api/v5/addons/addon/<slug>/` with the same `.env` JWT credentials). The `description` field takes **Markdown**, but a `GET` returns the **rendered HTML**. Feeding a GET response back into a PATCH escapes every tag (`&lt;strong&gt;` shown as literal text on the public page). Always PATCH the Markdown from `amo-metadata.json` (local only - the file is gitignored, so a fresh clone does not have it; recover the current text from the listing if it is missing). Unauthenticated API reads are cached, so verify with an authenticated GET or a cache-busted query.
11. **Native tab groups and tab ids:** a tab id lasts one browser run. Ids start over at every browser start, in practice by strip position, so a stored id soon names another tab: never persist one across a restart. A workspace's `groups[]` holds `key`, title, color and collapsed; membership is the per-tab session value `wspGroup` (`TabService.getGroupTags`). Firefox restores native groups itself, and `tabs.group` without a `groupId` always makes a new group and pulls the listed tabs out of any other, so `Workspace._rebuildGroups` leaves alone a group with a tab already in a native group: rebuilding on top of a restored group split it at every restart. `Workspace.updateTabGroups` records native groups under the workspace lock. A group not native right now stays while tabs carry its key (off screen, or a failed rebuild). A key is dropped in two places: a visible tab leaving a group, unless `TabService.ungroup` did it (`tabs.onUpdated` in Brainer), and a native group clearing its key from tabs outside it. A native group keeps a key only when it holds most of the tabs carrying it. Always ungroup through `TabService.ungroup`. Hiding a workspace records its native groups first (`_hideInactiveFromList`). Known limit: a group taken apart while the extension is disabled comes back, since the event was never seen.

---

## Working Conventions

- Always bump the patch version in `manifest.json` before building/signing for AMO - AMO rejects re-submissions of the same version.
- Do NOT invent workarounds (enterprise policies, proxy files). Follow the established workflow.
- Always verify file paths exist before referencing them.
- NEVER use the em dash character in NEW text - code, comments, commit messages, or documentation. Use a regular hyphen `-` or double hyphen `--` instead. (Older files still contain em dashes; do not mass-rewrite them, just keep new text clean.)
- In text users actually read - the AMO listing (`amo-metadata.json`), README, popup strings - use a SINGLE hyphen ` - ` as the aside separator. ` -- ` reads as a typo in rendered prose; keep it to code comments.
