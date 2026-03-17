<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="icons/layered-light.svg">
    <source media="(prefers-color-scheme: light)" srcset="icons/layered-dark.svg">
    <img alt="Workspaces" src="icons/layered-dark.svg" width="96" height="96">
  </picture>

  <h1>Workspaces</h1>

  <p><strong>Tab workspaces for Firefox. Group tabs, switch instantly, keep your tab bar clean.</strong></p>

  <p>
    <img src="https://img.shields.io/badge/Firefox-140%2B-FF7139?style=flat-square&logo=firefox-browser&logoColor=white" alt="Firefox 140+">
    <img src="https://img.shields.io/badge/Manifest-V2-4A90D9?style=flat-square" alt="Manifest V2">
    <a href="https://github.com/acaprino/firefox-workspaces/stargazers"><img src="https://img.shields.io/github/stars/acaprino/firefox-workspaces?style=flat-square&color=FFD700" alt="Stars"></a>
  </p>

</div>

---

Workspaces lets you organize your browser tabs into named groups. Switch between workspaces to show one set of tabs and hide the rest -- no closing, no losing your place, no tab bar chaos.

- **Instant switching** -- `Alt+.` / `Alt+,` to cycle, `Alt+W` to open the popup
- **Container integration** -- bind a workspace to a Firefox Container; new tabs auto-reopen in the right container
- **Customizable** -- 32 Fluent UI icons, 8 colors, drag-and-drop reorder
- **Survives restarts** -- workspace-to-tab mapping persists via `browser.sessions`

## Quick Start

**Install from AMO** (recommended): search for "Workspaces" by hardfox on [addons.mozilla.org](https://addons.mozilla.org).

**Or load from source:**

```bash
npm install -g web-ext
git clone https://github.com/acaprino/firefox-workspaces.git
cd firefox-workspaces
web-ext run --firefox="path/to/firefox"
```

Or load temporarily via `about:debugging` -- click "Load Temporary Add-on" and select `manifest.json`.

## Usage

| Action | How |
|---|---|
| Open popup | Click the toolbar button or press `Alt+W` |
| Create workspace | Click **New workspace** at the bottom of the popup |
| Switch workspace | Click a workspace name in the popup |
| Next / Previous | `Alt+.` / `Alt+,` |
| Rename / edit | Click the pencil icon on a workspace row |
| Delete workspace | Click the trash icon (tabs are closed) |
| Assign container | Select a container in the create/rename dialog |
| Move tab | Right-click a tab -- *Move Tab to Another Workspace* -- pick target |
| Search tabs | Type in the search bar at the top of the popup |
| Reorder workspaces | Drag and drop workspace rows |
| Switch via address bar | Type `ws` + space + workspace name |

Keyboard shortcuts can be customized in `about:addons` -- gear icon -- **Manage Extension Shortcuts**.

<details>
<summary><strong>All Features</strong></summary>

- **Tab workspaces** -- create named workspaces to group related tabs; switch instantly with inactive tabs hidden, not closed
- **Keyboard shortcuts** -- `Alt+,` / `Alt+.` to cycle workspaces, `Alt+W` to open the popup
- **Custom icons and colors** -- 32 Fluent UI icons and 8 color options per workspace
- **Container integration** -- bind a workspace to a Firefox Container; new tabs auto-reopen in the assigned container
- **Drag-and-drop reorder** -- rearrange workspaces in the popup by dragging
- **Tab search** -- find any tab across all workspaces from the popup search bar
- **Context menu** -- right-click a tab to move it to another workspace
- **Omnibox** -- type `ws` + space + workspace name in the address bar to switch
- **Recently closed tabs** -- view and restore tabs closed within each workspace
- **Tab previews** -- hover a workspace to see a tooltip listing its tabs
- **Theme-aware UI** -- adapts to Firefox light, dark, and custom LWT themes
- **Session persistence** -- workspaces survive browser restarts via `browser.sessions`

</details>

## Placing the Button in the Tab Strip

The extension places its toolbar button in the tab strip area by default. If it ends up elsewhere:

1. Right-click the Firefox toolbar and select **Customize Toolbar...**
2. Find the **Workspaces** button (layered squares icon)
3. Drag it to the tab strip
4. Click **Done**

<details>
<summary><strong>Project Structure</strong></summary>

```
backend/                     # Background scripts (loaded in manifest order)
  storage.js                 # WSPStorageManager - storage.local wrapper + async mutex
  workspace.js               # Workspace entity - create, activate, hide, destroy
  ui-service.js              # Toolbar button icon, badge, SVG cache, theme detection
  menu-service.js            # Tab context menu ("Move Tab to...") + omnibox provider
  workspace-service.js       # Workspace CRUD, activate/deactivate, container binding
  tab-service.js             # Tab add/remove/move, search, closed tabs, container reopen
  brainer.js                 # Orchestrator - init, event listeners, restart recovery
  handler.js                 # Message router (popup -> background)

popup/                       # Browser action popup
  wsp.html
  css/wsp.css                # Theme-aware styles (CSS system colors + browser.theme)
  js/
    wsp.js                   # Main popup UI (WorkspaceUI class, theme detection)
    dialog.js                # Create/rename dialog (icon picker, color picker, container)
    tooltip.js               # Tab preview tooltips on workspace hover
    drag-drop.js             # Workspace reorder via drag and drop

icons/                       # Toolbar icons (light/dark SVG + PNG fallbacks)
```

**Load order matters.** The `background.scripts` array in `manifest.json` defines execution order. `storage.js` loads first (all services depend on `WSPStorageManager`). `brainer.js` and `handler.js` load last.

`WorkspaceService` and `TabService` have a bidirectional dependency -- both are singletons in the same MV2 background page scope. The popup communicates with the background via `browser.runtime.sendMessage()` using an `action` field dispatched in `handler.js`.

</details>

<details>
<summary><strong>Building and Signing</strong></summary>

```bash
# Package as unsigned .xpi
web-ext build

# Sign via AMO (requires API credentials)
web-ext sign --channel=unlisted
```

To sign: copy `.env.example` to `.env` and fill in your AMO API credentials from https://addons.mozilla.org/developers/addon/api/key/. Always bump the version in `manifest.json` before signing -- AMO rejects duplicate versions.

</details>

<details>
<summary><strong>Permissions Explained</strong></summary>

| Permission | Why it is needed |
|---|---|
| `tabs` | Query, show, hide, create, move, and close tabs across workspaces |
| `tabHide` | Hide tabs in inactive workspaces (`browser.tabs.hide`) |
| `tabGroups` | Reconstruct Firefox tab groups when activating a workspace |
| `storage` | Persist workspace state and tab mappings in `browser.storage.local` |
| `menus` | "Move Tab to Another Workspace" in the tab context menu |
| `sessions` | Tag tabs with workspace IDs for restart recovery |
| `contextualIdentities` | Read and use Firefox Containers for workspace-container binding |
| `cookies` | Required alongside `contextualIdentities` to access container information |
| `theme` | Detect current theme for toolbar icon selection and popup styling |

</details>

## Requirements

- Firefox **140** or later
- `tabHide` API enabled (default in Firefox 140+)
