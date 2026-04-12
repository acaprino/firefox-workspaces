/* ============================================================
   Firefox Workspaces — Popup Script
   (theme-agnostic, styled via CSS custom properties)
   ============================================================ */

// ── Theme detection ──────────────────────────────────────────

// Strict CSS color validator. Mirror of backend/ui-service.js's _isSafeCssColor
// so both sites accept exactly the same shape. Rejects anything containing
// ;, }, {, <, >, url(, or backslash to prevent a malicious/malformed LWT
// theme from feeding arbitrary CSS tokens into style.setProperty.
const _WSP_NAMED_COLOR_RE = /^(transparent|currentcolor|black|white|red|green|blue|yellow|cyan|magenta|gray|grey|orange|purple|pink|brown)$/i;
const _WSP_HEX_COLOR_RE   = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const _WSP_FUNC_COLOR_RE  = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^;{}<>\\]*\)$/i;
function _isSafeCssColor(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s.length === 0 || s.length > 128) return false;
  if (/[;{}<>\\]/.test(s)) return false;
  return _WSP_HEX_COLOR_RE.test(s) || _WSP_FUNC_COLOR_RE.test(s) || _WSP_NAMED_COLOR_RE.test(s);
}

// Normalize a theme API color value (string or [R,G,B] / [R,G,B,A] array)
// to a CSS color string, or null if absent/untrusted. String values pass
// through _isSafeCssColor to reject injection-shaped tokens that a hostile
// LWT theme could supply (themes on AMO are low-trust; any installed theme
// could provide arbitrary strings).
function _toCSSColor(v) {
  if (!v) return null;
  if (Array.isArray(v)) {
    if (v.length < 3) return null;
    const [r, g, b] = v;
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    if (v.length >= 4) {
      const a = +(Math.min(1, Math.max(0, v[3] / 255))).toFixed(3);
      return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
    }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }
  if (typeof v === 'string' && _isSafeCssColor(v)) return v.trim();
  return null;
}

// Detect dark theme. Tries the shared pure detector first (same candidate
// chain as the backend, avoids drift). If the theme doesn't expose any
// useful color (Firefox built-in themes return theme.colors = {}), fall
// back to a -moz-Dialog DOM probe which reflects the actual OS dark mode
// even when privacy.resistFingerprinting spoofs prefers-color-scheme.
function _isFirefoxThemeDark(theme) {
  const colors = theme?.colors ?? null;
  console.log("[WSP][_isFirefoxThemeDark] colors:", JSON.stringify(colors));

  const fromColors = detectDarkFromThemeColors(colors);
  if (fromColors !== null) {
    console.log("[WSP][_isFirefoxThemeDark] branch=themeColors -> isDark:", fromColors);
    return fromColors;
  }
  try {
    const probe = document.createElement("div");
    document.documentElement.appendChild(probe);
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;background:-moz-Dialog";
    const bg = getComputedStyle(probe).backgroundColor;
    document.documentElement.removeChild(probe);
    console.log("[WSP][_isFirefoxThemeDark] branch=mozDialog bg:", bg);
    if (bg) {
      const m = bg.match(/\d+/g);
      if (m && m.length >= 3) {
        const [r, g, b] = m.map(Number);
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const result = lum < 128;
        console.log("[WSP][_isFirefoxThemeDark] branch=mozDialog lum:", lum.toFixed(1), "-> isDark:", result);
        return result;
      }
    }
  } catch (e) {
    console.warn("[WSP][_isFirefoxThemeDark] mozDialog probe failed:", e);
  }
  const result = window.matchMedia('(prefers-color-scheme: dark)').matches;
  console.log("[WSP][_isFirefoxThemeDark] branch=matchMedia -> isDark:", result);
  return result;
}

// Each entry: [cssVar, [theme.colors keys in priority order]]
// The first non-null resolved color from the priority chain is injected as
// a --ff-popup-* CSS var. When a custom LWT theme is active, the popup can
// match its palette exactly. When the user is on a Firefox built-in theme
// (Default / Dark / System), theme.colors is empty and these vars stay
// unset — the CSS falls through to CSS system colors (Canvas, CanvasText,
// AccentColor, ...) which the browser resolves to the active theme/OS
// palette on its own.
// NOTE: --ff-popup-accent MUST stay in sync with THEME_ACCENT_KEYS in
// backend/theme-utils.js so the toolbar badge color matches the popup accent.
const _FF_POPUP_PROPS = [
  ['--ff-popup-bg',             ['popup', 'frame', 'toolbar']],
  ['--ff-popup-text',           ['popup_text', 'toolbar_text', 'bookmark_text']],
  ['--ff-popup-border',         ['popup_border', 'toolbar_field_border']],
  ['--ff-popup-highlight',      ['popup_highlight', 'toolbar_field_focus', 'tab_selected']],
  ['--ff-popup-highlight-text', ['popup_highlight_text', 'toolbar_field_highlight_text']],
  ['--ff-popup-accent',         ['accentcolor', 'toolbar_field_focus_border', 'icons_attention', 'tab_loading', 'popup_highlight']],
  ['--ff-popup-input-bg',       ['toolbar_field', 'popup', 'frame']],
  ['--ff-popup-input-text',     ['toolbar_field_text', 'popup_text', 'toolbar_text']],
  ['--ff-popup-input-border',   ['toolbar_field_border', 'popup_border']],
];

// Apply theme colors from the Firefox LWT theme API.
// If the theme provides colors (only custom LWT themes do; built-ins return
// an empty object), inject them as --ff-popup-* CSS vars. Otherwise the CSS
// falls through to CSS system colors (Canvas, CanvasText, AccentColor, ...)
// which Firefox resolves to the active theme/OS palette automatically.
// Returns isDark boolean so callers can forward it to the background.
function applyTheme(theme) {
  const dark = _isFirefoxThemeDark(theme);
  console.log("[WSP][applyTheme] isDark:", dark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';

  const s = document.documentElement.style;
  // Always clear previously injected vars so stale values can't linger.
  for (const [cssVar] of _FF_POPUP_PROPS) s.removeProperty(cssVar);

  // Walk each cssVar's priority chain and inject the first resolved color.
  const c = theme?.colors ?? {};
  for (const [cssVar, keys] of _FF_POPUP_PROPS) {
    for (const k of keys) {
      const v = _toCSSColor(c[k]);
      if (v) {
        s.setProperty(cssVar, v);
        console.log(`[WSP][applyTheme] ${cssVar} <- theme.colors.${k} = ${v}`);
        break;
      }
    }
  }
  return dark;
}
// ─────────────────────────────────────────────────────────────

class WorkspaceUI {
  constructor() {
    this.workspaces = [];
    this.containers = [];
    this.currentWindowId = null;
    this._dragDrop = null;
    this._tooltip = null;
  }

  async initialize() {
    console.log("[WorkspaceUI][initialize] starting");
    // Parallelize the two independent startup API calls
    const [currentWindow, currentTheme] = await Promise.all([
      browser.windows.getCurrent(),
      browser.theme.getCurrent(),
    ]);
    this.currentWindowId = currentWindow.id;
    console.log("[WorkspaceUI][initialize] windowId:", this.currentWindowId);

    // Apply theme colors before rendering anything
    const isDark = applyTheme(currentTheme);
    // Forward dark-mode result to background so menu icons use correct variant.
    // The popup has a real rendered document where -moz-Dialog probe works,
    // unlike the hidden background page. Soft-log failures (background may not
    // be ready on cold start — this is expected, logged at debug level only).
    browser.runtime.sendMessage({ action: "setDarkModeHint", isDark })
      .catch(e => console.debug("[WSP] setDarkModeHint failed:", e?.message));

    // Debounce theme.onUpdated: dynamic themes can re-fire many events per
    // second, and each applyTheme() call writes ~9 CSS custom properties and
    // may trigger a -moz-Dialog DOM probe (forced reflow). 80ms coalescing
    // is below the perception threshold but absorbs bursts.
    let _themeUpdateTimer = null;
    browser.theme.onUpdated.addListener(({ theme }) => {
      clearTimeout(_themeUpdateTimer);
      _themeUpdateTimer = setTimeout(() => applyTheme(theme), 80);
    });

    const primaryWindowId = await this._callBackgroundTask("getPrimaryWindowId");
    console.log("[WorkspaceUI][initialize] primaryWindowId:", primaryWindowId,
      "currentWindowId:", this.currentWindowId,
      "isPrimary:", primaryWindowId === this.currentWindowId);
    if (primaryWindowId !== this.currentWindowId) {
      console.log("[WorkspaceUI][initialize] not primary window — showing restricted UI");
      document.getElementById("createNewWsp").style.display = "none";
      document.getElementById("restoreFromBookmarks").style.display = "none";
      document.getElementById("wsp-search").hidden = true;
      const noWspLi = document.createElement("li");
      noWspLi.className = "no-wsp";
      noWspLi.textContent = "Workspaces are only available in the primary window.";
      document.getElementById("wsp-list").replaceChildren(noWspLi);
      return;
    }

    this._dragDrop = new DragDropHandler(
      this._callBackgroundTask.bind(this),
      this.currentWindowId
    );
    this._tooltip = new TabPreviewTooltip(this._callBackgroundTask.bind(this));

    // Fetch containers and workspaces in parallel
    const [containers, workspaces] = await Promise.all([
      this._callBackgroundTask("getContainers"),
      this.getWorkspaces(this.currentWindowId)
    ]);
    this.containers = containers || [];
    this.workspaces.push(...(workspaces || []));
    console.log("[WorkspaceUI][initialize] containers:", this.containers.length,
      "workspaces:", this.workspaces.length,
      this.workspaces.map(w => `"${w.name}"(${w.tabs.length}t,active:${w.active})`));
    this.displayWorkspaces();
    this._setupCreateButton();
    this._setupRestoreButton();
    this.setupSearch();
    this.showClosedTabs();
    console.log("[WorkspaceUI][initialize] done");
  }

  async getWorkspaces(currentWindowId) {
    // Workspaces are already ordered by the background (getOrderedWorkspaces)
    return await this._callBackgroundTask("getWorkspaces", { windowId: currentWindowId });
  }

  displayWorkspaces() {
    this.workspaces.forEach(workspace => this._addWorkspace(workspace));
  }

  _setupCreateButton() {
    document.getElementById("createNewWsp").addEventListener("click", async (e) => {
      const windowId = this.currentWindowId;
      console.log("[WorkspaceUI][createNewWsp] clicked, windowId:", windowId);

      const result = await showCustomDialog({
        message: "Create workspace:",
        withInput: true,
        defaultValue: await this._callBackgroundTask("getWorkspaceName"),
        showContainerPicker: this.containers.length > 0,
        containers: this.containers,
        showColorPicker: true
      });
      if (result === false) {
        console.log("[WorkspaceUI][createNewWsp] dialog cancelled");
        return;
      }

      const wspName = result.name.trim().slice(0, 100);
      if (wspName.length === 0) return;
      console.log("[WorkspaceUI][createNewWsp] creating workspace:", wspName,
        "icon:", result.icon || "(none)", "color:", result.color || null,
        "containerId:", result.containerId || null);

      const wsp = {
        name: wspName,
        icon: result.icon || "",
        color: result.color || null,
        active: true,
        tabs: [],
        windowId: windowId,
        containerId: result.containerId || null
      };

      const created = await this._callBackgroundTask("createWorkspaceWithTab", wsp);

      wsp.id = created.wspId;
      wsp.tabs.push(created.tabId);
      this.workspaces.push(wsp);
      console.log("[WorkspaceUI][createNewWsp] workspace created — wspId:", wsp.id, "tabId:", created.tabId);

      this._removePreviouslyActiveLi();
      this._addWorkspace(wsp);
    });
  }

  _setupRestoreButton() {
    const restoreLink = document.getElementById("restoreFromBookmarks");
    restoreLink.addEventListener("click", async (e) => {
      e.preventDefault();
      if (restoreLink.dataset.busy) return;
      restoreLink.dataset.busy = "1";
      try {
        console.log("[WorkspaceUI][restoreFromBookmarks] clicked");

        const folders = await this._callBackgroundTask("getBookmarkWorkspaces");
        if (!folders || folders.length === 0) {
          await showCustomDialog({ message: "No saved workspaces found in bookmarks." });
          return;
        }

        const result = await showCustomDialog({
          message: "Restore workspace from bookmarks:",
          showFolderPicker: true,
          folders
        });

        if (!result) {
          console.log("[WorkspaceUI][restoreFromBookmarks] cancelled");
          return;
        }

        console.log("[WorkspaceUI][restoreFromBookmarks] restoring folder:", result.folderId);
        const restored = await this._callBackgroundTask("restoreWorkspaceFromBookmarks", {
          folderId: result.folderId,
          windowId: this.currentWindowId
        });

        if (!restored) {
          console.log("[WorkspaceUI][restoreFromBookmarks] restore failed");
          return;
        }

        console.log("[WorkspaceUI][restoreFromBookmarks] restored:", restored.name, "tabs:", restored.tabCount);
        window.close();
      } finally {
        delete restoreLink.dataset.busy;
      }
    });
  }

  // ── Tab Search (Tier 3) ──

  setupSearch() {
    const searchInput = document.getElementById("wsp-search-input");
    const searchResults = document.getElementById("wsp-search-results");
    const wspList = document.getElementById("wsp-list");
    const closedTabs = document.getElementById("wsp-closed-tabs");
    let debounceTimer = null;

    searchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const query = searchInput.value.trim();
        if (query.length === 0) {
          searchResults.hidden = true;
          searchResults.replaceChildren();
          wspList.hidden = false;
          closedTabs.hidden = false;
          this.showClosedTabs();
          return;
        }

        const results = await this._callBackgroundTask("searchTabs", {
          query,
          windowId: this.currentWindowId
        });

        searchResults.replaceChildren();
        wspList.hidden = true;
        closedTabs.hidden = true;

        if (!results || results.length === 0) {
          const empty = document.createElement("div");
          empty.className = "wsp-search-empty";
          empty.textContent = "No matching tabs found";
          searchResults.replaceChildren(empty);
          searchResults.hidden = false;
          return;
        }

        for (const r of results) {
          const item = document.createElement("div");
          item.classList.add("wsp-search-result");
          item.dataset.wspId = r.wspId;
          item.dataset.tabId = r.tabId;

          const titleEl = document.createElement("span");
          titleEl.classList.add("wsp-search-result-title");
          titleEl.textContent = r.title;
          item.appendChild(titleEl);

          const wspEl = document.createElement("span");
          wspEl.classList.add("wsp-search-result-wsp");
          wspEl.textContent = r.wspName;
          item.appendChild(wspEl);

          item.addEventListener("click", async () => {
            await this._callBackgroundTask("activateWorkspace", {
              wspId: r.wspId,
              windowId: this.currentWindowId,
              tabId: r.tabId
            });
            window.close();
          });

          searchResults.appendChild(item);
        }
        searchResults.hidden = false;
      }, 150);
    });

    // Focus search on Ctrl+F
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    });
  }

  // ── Closed Tabs (Tier 2) ──

  async showClosedTabs() {
    const container = document.getElementById("wsp-closed-tabs");
    const list = document.getElementById("wsp-closed-tabs-list");
    const clearBtn = document.getElementById("wsp-closed-tabs-clear");

    const activeWsp = this.workspaces.find(w => w.active);
    if (!activeWsp) {
      console.log("[WorkspaceUI][showClosedTabs] no active workspace — hiding section");
      container.hidden = true;
      return;
    }

    const closedTabs = await this._callBackgroundTask("getClosedTabs", { wspId: activeWsp.id });
    console.log("[WorkspaceUI][showClosedTabs] activeWsp:", activeWsp.id, activeWsp.name,
      "closedTabs:", closedTabs?.length ?? 0);
    if (!closedTabs || closedTabs.length === 0) {
      container.hidden = true;
      return;
    }

    list.replaceChildren();
    container.hidden = false;

    for (let i = 0; i < closedTabs.length; i++) {
      const tab = closedTabs[i];
      const li = document.createElement("li");
      li.classList.add("wsp-closed-tab-item");

      const titleSpan = document.createElement("span");
      titleSpan.classList.add("wsp-closed-tab-title");
      titleSpan.textContent = tab.title || tab.url;
      titleSpan.title = tab.url;
      li.appendChild(titleSpan);

      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.classList.add("wsp-closed-tab-restore");
      restoreBtn.title = "Restore tab";

      const idx = i;
      li.addEventListener("click", async () => {
        // Disable all closed-tab items to prevent stale-index clicks
        const allItems = list.querySelectorAll(".wsp-closed-tab-item");
        for (const item of allItems) item.style.pointerEvents = "none";

        console.log("[WorkspaceUI][restoreClosedTab] restoring index:", idx, "url:", tab.url);
        await this._callBackgroundTask("restoreClosedTab", {
          wspId: activeWsp.id,
          index: idx,
          windowId: this.currentWindowId
        });
        this.showClosedTabs();
      });

      li.appendChild(restoreBtn);
      list.appendChild(li);
    }

    // Clear all handler
    clearBtn.onclick = async () => {
      await this._callBackgroundTask("clearClosedTabs", { wspId: activeWsp.id });
      container.hidden = true;
    };
  }

  async _callBackgroundTask(action, args) {
    const message = { action, ...args };
    console.log("[WorkspaceUI][_callBackgroundTask] ->", action,
      args ? JSON.stringify(args) : "");
    const result = await browser.runtime.sendMessage(message);
    if (result && result._error) {
      console.error(`[Workspaces] ${action} failed:`, result.message);
      return null;
    }
    console.log("[WorkspaceUI][_callBackgroundTask] <-", action, "result:",
      result === null ? "null" :
      Array.isArray(result) ? `[array len=${result.length}]` :
      typeof result === "object" ? `{${Object.keys(result).join(",")}}` : result);
    return result;
  }

  _createWorkspaceItem(workspace) {
    const li = document.createElement("li");
    li.classList.add("wsp-list-item");
    if (workspace.active) li.classList.add("active");
    li.dataset.wspId = workspace.id;
    li.draggable = true;

    // Container color dot (Tier 2) — always reserve space for alignment
    const dot = document.createElement("span");
    dot.classList.add("wsp-container-dot");
    if (workspace.containerId) {
      const container = this.containers.find(c => c.cookieStoreId === workspace.containerId);
      if (container) {
        dot.style.backgroundColor = container.colorCode || container.color || "#888";
        dot.title = container.name;
      }
    } else {
      dot.style.visibility = "hidden";
    }
    li.appendChild(dot);

    let iconEl = null;
    if (workspace.icon) {
      iconEl = _createIconElement(workspace.icon, "wsp-icon");
      li.appendChild(iconEl);
    }

    const span1 = document.createElement("span");
    span1.classList.add("wsp-name");
    span1.spellcheck = false;
    span1.textContent = workspace.name;
    span1.title = workspace.name;
    li.appendChild(span1);

    const span2 = document.createElement("span");
    span2.classList.add("tabs-qty");
    span2.textContent = workspace.tabs.length + " tabs";
    li.appendChild(span2);

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.classList.add("edit-btn", "export-btn");
    exportBtn.title = "Export to bookmarks";
    li.appendChild(exportBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.classList.add("edit-btn", "delete-btn");
    li.appendChild(deleteBtn);

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.classList.add("edit-btn", "rename-btn");
    li.appendChild(renameBtn);

    li.dataset.originalText = span1.textContent;
    li.dataset.wspIcon = workspace.icon || "";

    // Apply workspace color bar
    this._applyColorBar(li, workspace);

    // ── Drag and Drop (Tier 3) ──
    this._dragDrop.attach(li, workspace.id);

    // ── Tab preview tooltip on hover (Tier 3) ──
    this._tooltip.attach(li, workspace.id, () => this._dragDrop.dragSrcEl !== null);

    // Switch workspace
    li.addEventListener("click", async () => {
      if (li.classList.contains("active")) {
        console.log("[WorkspaceUI][switchWorkspace] already active:", workspace.id, "— no-op");
        return;
      }
      console.log("[WorkspaceUI][switchWorkspace] activating:", workspace.id, workspace.name);

      const lis = document.querySelectorAll("li.wsp-list-item.active");
      for (const activeLi of lis) {
        activeLi.classList.remove("active");
      }
      li.classList.add("active");

      await this._callBackgroundTask("activateWorkspace", {
        wspId: workspace.id,
        windowId: workspace.windowId
      });
      console.log("[WorkspaceUI][switchWorkspace] done — closing popup");
      window.close();
    });

    // Export to bookmarks
    exportBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (exportBtn.disabled) return;
      exportBtn.disabled = true;
      try {
        console.log("[WorkspaceUI][exportBtn] clicked for workspace:", workspace.id, workspace.name);

        const result = await showCustomDialog({
          message: `Export "${li.dataset.originalText}" to bookmarks?`,
          showCheckbox: true,
          checkboxLabel: "Close workspace after export",
          checkboxDefault: false
        });

        if (!result) {
          console.log("[WorkspaceUI][exportBtn] export cancelled");
          return;
        }

        // Single background call handles both export and optional destroy
        const exportResult = await this._callBackgroundTask("exportWorkspaceToBookmarks", {
          wspId: workspace.id,
          windowId: this.currentWindowId,
          destroyAfter: !!result.checked
        });
        if (!exportResult) {
          console.log("[WorkspaceUI][exportBtn] export failed");
          return;
        }
        console.log("[WorkspaceUI][exportBtn] exported", exportResult.exported, "tabs to:", exportResult.folderTitle);

        if (exportResult.destroyed) {
          const wasActive = li.classList.contains("active");
          if (li.parentNode) {
            const liParent = li.parentElement;
            li.parentNode.removeChild(li);
            if (wasActive && exportResult.activatedWspId) {
              const targetLi = liParent.querySelector(`[data-wsp-id="${exportResult.activatedWspId}"]`);
              if (targetLi) targetLi.classList.add("active");
            }
          }
        }
      } finally {
        exportBtn.disabled = false;
      }
    });

    // Rename
    renameBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      console.log("[WorkspaceUI][renameBtn] clicked for workspace:", workspace.id, workspace.name);

      const result = await showCustomDialog({
        message: "Rename workspace:",
        withInput: true,
        defaultValue: li.dataset.originalText,
        defaultIcon: li.dataset.wspIcon || "",
        showContainerPicker: this.containers.length > 0,
        defaultContainerId: workspace.containerId || null,
        containers: this.containers,
        showColorPicker: true,
        defaultColor: workspace.color || null
      });

      if (result !== false) {
        const wspName = result.name.trim().slice(0, 100);
        if (wspName.length === 0) return;
        const wspIcon = result.icon || "";

        const wspColor = result.color;
        const nameChanged = wspName !== li.dataset.originalText;
        const iconChanged = wspIcon !== (li.dataset.wspIcon || "");
        const colorChanged = wspColor !== (workspace.color || null);
        const containerChanged = result.containerId !== undefined && result.containerId !== (workspace.containerId || null);
        console.log("[WorkspaceUI][renameBtn] changes — name:", nameChanged,
          "icon:", iconChanged, "color:", colorChanged, "container:", containerChanged,
          "| new values: name:", wspName, "icon:", wspIcon, "color:", wspColor,
          "containerId:", result.containerId);

        if (!nameChanged && !iconChanged && !containerChanged && !colorChanged) {
          console.log("[WorkspaceUI][renameBtn] no changes detected — skipping");
          return;
        }

        li.dataset.originalText = wspName;
        li.dataset.wspIcon = wspIcon;
        span1.textContent = wspName;

        // Update icon element
        if (iconEl && iconEl.parentElement) iconEl.remove();
        if (wspIcon) {
          iconEl = _createIconElement(wspIcon, "wsp-icon");
          // Insert after container dot if present
          const firstSpan = li.querySelector("span:not(.wsp-container-dot)");
          if (firstSpan) {
            li.insertBefore(iconEl, firstSpan);
          } else {
            li.appendChild(iconEl);
          }
        } else {
          iconEl = null;
        }

        await this._callBackgroundTask("renameWorkspace", { wspId: workspace.id, wspName, wspIcon, wspColor });

        // Update color bar
        if (colorChanged) {
          workspace.color = wspColor;
          this._applyColorBar(li, workspace);
        }

        // Update container if changed
        if (containerChanged) {
          workspace.containerId = result.containerId;
          await this._callBackgroundTask("setWorkspaceContainer", {
            wspId: workspace.id,
            containerId: result.containerId
          });

          // Update container dot (always keep element for alignment)
          const existingDot = li.querySelector(".wsp-container-dot");
          if (result.containerId) {
            const container = this.containers.find(c => c.cookieStoreId === result.containerId);
            if (container) {
              existingDot.style.backgroundColor = container.colorCode || container.color || "#888";
              existingDot.style.visibility = "";
              existingDot.title = container.name;
            }
          } else {
            existingDot.style.backgroundColor = "";
            existingDot.style.visibility = "hidden";
            existingDot.title = "";
          }
        }

      }
    });

    // Delete
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (deleteBtn.disabled) return;
      deleteBtn.disabled = true;
      try {
        console.log("[WorkspaceUI][deleteBtn] clicked for workspace:", workspace.id, workspace.name);

        const deleteConfirmed = await showCustomDialog({
          message: `Delete "${li.dataset.originalText}"?`
        });
        if (!deleteConfirmed) {
          console.log("[WorkspaceUI][deleteBtn] delete cancelled");
          return;
        }

        const wasActive = li.classList.contains("active");
        console.log("[WorkspaceUI][deleteBtn] confirmed -- wasActive:", wasActive, "wspId:", workspace.id);

        const destroyResult = await this._callBackgroundTask("destroyWsp", {
          wspId: workspace.id,
          windowId: this.currentWindowId,
        });
        if (!destroyResult) {
          console.log("[WorkspaceUI][deleteBtn] destroy failed");
          return;
        }

        if (li.parentNode) {
          const liParent = li.parentElement;
          li.parentNode.removeChild(li);

          if (wasActive && destroyResult.activatedWspId) {
            const targetLi = liParent.querySelector(`[data-wsp-id="${destroyResult.activatedWspId}"]`);
            if (targetLi) {
              console.log("[WorkspaceUI][deleteBtn] marking activated:", destroyResult.activatedWspId);
              targetLi.classList.add("active");
            }
          }
        }
        console.log("[WorkspaceUI][deleteBtn] done");
      } finally {
        deleteBtn.disabled = false;
      }
    });

    return li;
  }

  _applyColorBar(li, workspace) {
    if (workspace.color) {
      li.style.borderLeftColor = workspace.color;
      li.classList.add("has-color");
    } else {
      li.style.borderLeftColor = "";
      li.classList.remove("has-color");
    }
  }

  _addWorkspace(workspace) {
    const wspList = document.getElementById("wsp-list");
    const li = this._createWorkspaceItem(workspace);
    wspList.appendChild(li);
    // No sorting — order is now controlled by drag-and-drop / backend order
    return li;
  }

  _removePreviouslyActiveLi() {
    const lis = document.querySelectorAll(".wsp-list-item.active");
    for (const li of lis) {
      li.classList.remove("active");
    }
  }
}

(async () => {
  const wsp = new WorkspaceUI();
  await wsp.initialize();
})();
