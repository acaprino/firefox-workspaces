# Firefox Workspaces — Extension

**Type:** MV2 WebExtension for Firefox 140+
**Language:** Vanilla JavaScript (no build step, no bundler)
**ID:** `workspaces@hardfox`

---

## Architecture

```
backend/          # Background scripts (loaded in order by manifest.json)
├── storage.js    # WSPStorageManager — browser.storage.local wrapper
├── workspace.js  # Workspace entity (create, activate, hide, destroy)
├── ui-service.js       # Toolbar button icon, badge, SVG cache, theme detection
├── menu-service.js     # Tab context menu ("Move Tab to…") + omnibox
├── workspace-service.js # Workspace CRUD, activate/deactivate, container binding
├── tab-service.js      # Tab add/remove/move, search, closed tabs, sessions, container reopen
├── brainer.js          # Orchestrator — init, event listener registration, restart recovery
└── handler.js          # Message router (popup ↔ background)

popup/            # Browser action popup
├── wsp.html      # Popup markup
├── css/wsp.css   # Theme-aware stylesheet (CSS system colors + browser.theme API)
└── js/
    ├── wsp.js       # Main popup UI (WorkspaceUI class, theme detection)
    ├── dialog.js    # Create/rename dialog (icon picker, color picker, container select)
    ├── tooltip.js   # Tab preview tooltips on workspace hover
    └── drag-drop.js # Workspace reorder via drag & drop

icons/            # Toolbar icons (light/dark SVG + PNG fallbacks)
```

**Load order matters:** `manifest.json` → `background.scripts` array defines the order. `storage.js` must load first (others depend on `WSPStorageManager`). `brainer.js` and `handler.js` last.

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
1. `browser.theme.getCurrent()` → extract popup colors
2. CSS system colors (`-moz-Dialog`, `AccentColor`, etc.) as fallbacks
3. `-moz-Dialog` luminance probe for dark/light detection
4. Manual toggle (LWT colors vs system colors)

### Session Persistence
Workspace-to-tab mapping survives restarts via `browser.sessions.setTabValue()`. On restart, `Brainer.initialize()` detects the restart condition (`primaryWindowLastId` present, `primaryWindowId` absent) and restores workspaces.

---

## Messaging Protocol (popup ↔ background)

Messages use `browser.runtime.sendMessage({ msg, ... })`. Key message types:

| `msg` | Direction | Purpose |
|---|---|---|
| `getWorkspaces` | popup → bg | Get ordered workspace list |
| `activateWsp` | popup → bg | Switch to a workspace |
| `createWsp` | popup → bg | Create new workspace |
| `renameWsp` | popup → bg | Rename + update icon/color/container |
| `deleteWsp` | popup → bg | Destroy workspace and its tabs |
| `moveTabToWsp` | popup → bg | Move a tab between workspaces |
| `reorderWorkspaces` | popup → bg | Persist new workspace order |
| `searchTabs` | popup → bg | Search tabs across all workspaces |
| `getClosedTabs` | popup → bg | Get recently closed tabs for a workspace |
| `setDarkModeHint` | popup → bg | Forward popup's dark mode detection to background |

---

## Development

```bash
# Run with auto-reload
web-ext run --source-dir=. --firefox="path/to/firefox"

# Package for distribution
web-ext build
```

No build step required — load directly via `about:debugging` → "Load Temporary Add-on" → select `manifest.json`.

---

## Known Gotchas

1. **Extension signing:** Release Firefox ignores `xpinstall.signatures.required=false`. Must sign via AMO for distribution. Version in `manifest.json` must be bumped before each AMO submission (duplicates are rejected).
2. **`data_collection_permissions`:** Required in `manifest.json` for Firefox 140+. Omitting it causes AMO validation failure.
3. **`tabHide` API:** Must be enabled (default in Firefox 140+). Without it, inactive workspace tabs remain visible.
4. **Container reopen race:** `TabService._reopenInContainer()` uses `_isReopening` + `_forceReopenIds` guards to prevent `onCreated` from double-assigning tabs during the close→reopen window.
5. **Background page has no rendering context:** Theme dark/light detection via `-moz-Dialog` probe only works in the popup (which has a DOM). The popup forwards the result to background via `setDarkModeHint`.
6. **MV2 only:** This extension uses `browser_action`, `background.scripts`, and `tabHide` — all MV2 APIs. No MV3 migration planned (Firefox still supports MV2).

---

## Working Conventions

- Always bump the patch version in `manifest.json` before building/signing for AMO - AMO rejects re-submissions of the same version.
- Do NOT invent workarounds (enterprise policies, proxy files). Follow the established workflow.
- Always verify file paths exist before referencing them.
- NEVER use the `—` (em dash) character anywhere — in code, comments, commit messages, or documentation. Use a regular hyphen `-` or double hyphen `--` instead.
