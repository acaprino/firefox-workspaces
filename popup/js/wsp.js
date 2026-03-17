/* ============================================================
   Firefox Workspaces — Popup Script
   (theme-agnostic, styled via CSS custom properties)
   ============================================================ */

// ── Theme detection ──────────────────────────────────────────

// Normalize a theme API color value (string or [R,G,B] / [R,G,B,A] array)
// to a CSS color string, or null if absent.
function _toCSSColor(v) {
  if (!v) return null;
  if (Array.isArray(v)) {
    const a = +(Math.min(1, Math.max(0, v[3] / 255))).toFixed(3);
    return v.length >= 4
      ? `rgba(${v[0]},${v[1]},${v[2]},${a})`
      : `rgb(${v[0]},${v[1]},${v[2]})`;
  }
  if (typeof v === 'string') return v;
  return null;
}

function _getLuminance(colorVal) {
  if (!colorVal) return null;
  if (Array.isArray(colorVal)) {
    const [r, g, b] = colorVal;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const s = String(colorVal).trim();
  // Handle hex colors: #RGB, #RRGGBB, #RRGGBBAA
  const hex = s.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const h = hex[1];
    let r, g, b;
    if (h.length <= 4) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
    } else {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    }
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  // Handle rgb()/rgba() strings
  const m = s.match(/\d+/g);
  if (!m || m.length < 3) return null;
  const [r, g, b] = m.map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function _isFirefoxThemeDark(theme) {
  console.log("[WSP][_isFirefoxThemeDark] full theme.colors:", JSON.stringify(theme?.colors ?? null));
  // Prefer toolbar_text (light text = dark theme)
  const toolbar_text = theme?.colors?.toolbar_text ?? theme?.colors?.bookmark_text;
  const textLum = _getLuminance(toolbar_text);
  console.log("[WSP][_isFirefoxThemeDark] toolbar_text:", toolbar_text, "lum:", textLum);
  if (textLum !== null) {
    const result = textLum > 128;
    console.log("[WSP][_isFirefoxThemeDark] branch=toolbar_text lum:", textLum.toFixed(1), "-> isDark:", result);
    return result;
  }
  // Fallback: dark frame/toolbar background = dark theme
  const bgSource = theme?.colors?.frame ?? theme?.colors?.toolbar;
  const bgLum = _getLuminance(bgSource);
  console.log("[WSP][_isFirefoxThemeDark] frame/toolbar:", bgSource, "lum:", bgLum);
  if (bgLum !== null) {
    const result = bgLum < 128;
    console.log("[WSP][_isFirefoxThemeDark] branch=bg lum:", bgLum.toFixed(1), "-> isDark:", result);
    return result;
  }
  // Probe -moz-Dialog system color: reflects real OS dark/light mode even when
  // privacy.resistFingerprinting spoofs prefers-color-scheme to 'light'.
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
  // Last resort: OS preference (may be spoofed by resistFingerprinting)
  const result = window.matchMedia('(prefers-color-scheme: dark)').matches;
  console.log("[WSP][_isFirefoxThemeDark] branch=matchMedia -> isDark:", result);
  return result;
}

const _FF_POPUP_PROPS = [
  '--ff-popup-bg', '--ff-popup-text', '--ff-popup-border',
  '--ff-popup-highlight', '--ff-popup-highlight-text',
];

// mode: 'auto' (inject LWT colors) | 'system' (skip LWT, use CSS system colors)
// Returns isDark boolean so callers can forward it to the background.
function applyColorMode(theme, mode) {
  const dark = _isFirefoxThemeDark(theme);
  console.log("[WSP][applyColorMode] mode:", mode, "isDark:", dark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';

  const s = document.documentElement.style;
  if (mode === 'system') {
    // Remove all LWT overrides → -moz-Dialog / system colors take control
    _FF_POPUP_PROPS.forEach(p => s.removeProperty(p));
    return dark;
  }

  // 'auto': inject popup colors from the Firefox LWT theme API.
  // Cascade: popup_* keys (explicit) → toolbar_* keys (derived) → remove var
  // so the stylesheet's -moz-Dialog/-moz-DialogText fallbacks kick in.
  const c = theme?.colors ?? {};
  const map = {
    '--ff-popup-bg':             _toCSSColor(c.popup)             ?? _toCSSColor(c.toolbar),
    '--ff-popup-text':           _toCSSColor(c.popup_text)        ?? _toCSSColor(c.toolbar_text) ?? _toCSSColor(c.bookmark_text),
    '--ff-popup-border':         _toCSSColor(c.popup_border),
    '--ff-popup-highlight':      _toCSSColor(c.popup_highlight),
    '--ff-popup-highlight-text': _toCSSColor(c.popup_highlight_text),
  };
  for (const [k, v] of Object.entries(map)) {
    if (v) s.setProperty(k, v); else s.removeProperty(k);
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
    // Parallelize the three independent startup API calls
    const [currentWindow, currentTheme, stored] = await Promise.all([
      browser.windows.getCurrent(),
      browser.theme.getCurrent(),
      browser.storage.local.get('colorMode'),
    ]);
    this.currentWindowId = currentWindow.id;
    console.log("[WorkspaceUI][initialize] windowId:", this.currentWindowId);

    // Apply color mode before rendering anything
    let colorMode = stored.colorMode ?? 'auto';
    console.log("[WorkspaceUI][initialize] colorMode:", colorMode);
    const isDark = applyColorMode(currentTheme, colorMode);
    // Forward dark-mode result to background so menu icons use correct variant.
    // The popup has a real rendered document where -moz-Dialog probe works,
    // unlike the hidden background page. Ignore errors (background may not be ready).
    browser.runtime.sendMessage({ action: "setDarkModeHint", isDark }).catch(() => {});

    // Color mode toggle button
    const toggleBtn = document.getElementById('wsp-color-toggle');
    toggleBtn.classList.toggle('active', colorMode === 'system');
    toggleBtn.title = colorMode === 'system' ? 'Using system colors' : 'Use system colors';
    toggleBtn.addEventListener('click', async () => {
      const prev = colorMode;
      colorMode = colorMode === 'system' ? 'auto' : 'system';
      console.log("[WorkspaceUI][colorToggle] colorMode:", prev, "->", colorMode);
      await browser.storage.local.set({ colorMode });
      const newDark = applyColorMode(currentTheme, colorMode);
      browser.runtime.sendMessage({ action: "setDarkModeHint", isDark: newDark }).catch(() => {});
      toggleBtn.classList.toggle('active', colorMode === 'system');
      toggleBtn.title = colorMode === 'system' ? 'Using system colors' : 'Use system colors';
    });

    browser.theme.onUpdated.addListener(({ theme }) => applyColorMode(theme, colorMode));

    const primaryWindowId = await this._callBackgroundTask("getPrimaryWindowId");
    console.log("[WorkspaceUI][initialize] primaryWindowId:", primaryWindowId,
      "currentWindowId:", this.currentWindowId,
      "isPrimary:", primaryWindowId === this.currentWindowId);
    if (primaryWindowId !== this.currentWindowId) {
      console.log("[WorkspaceUI][initialize] not primary window — showing restricted UI");
      document.getElementById("createNewWsp").style.display = "none";
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
        console.log("[WorkspaceUI][restoreClosedTab] restoring index:", idx, "url:", tab.url);
        // Tab creation happens in the background handler (respects container)
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
      console.log("[WorkspaceUI][deleteBtn] clicked for workspace:", workspace.id, workspace.name);

      const deleteConfirmed = await showCustomDialog({
        message: `Delete "${li.dataset.originalText}"?`
      });
      if (!deleteConfirmed) {
        console.log("[WorkspaceUI][deleteBtn] delete cancelled");
        return;
      }

      const wasActive = li.classList.contains("active");
      console.log("[WorkspaceUI][deleteBtn] confirmed — wasActive:", wasActive, "wspId:", workspace.id);
      const liParent = li.parentElement;
      li.parentNode.removeChild(li);

      // Destroy first to avoid deactivateCurrentWsp saving state for a doomed workspace
      await this._callBackgroundTask("destroyWsp", { wspId: workspace.id });

      if (wasActive) {
        const firstChild = liParent.children[0];
        if (firstChild) {
          console.log("[WorkspaceUI][deleteBtn] activating next workspace:", firstChild.dataset.wspId);
          firstChild.classList.add("active");
          await this._callBackgroundTask("activateWorkspace", {
            wspId: firstChild.dataset.wspId,
            windowId: workspace.windowId
          });
        } else {
          console.log("[WorkspaceUI][deleteBtn] no remaining workspaces to activate");
        }
      }
      console.log("[WorkspaceUI][deleteBtn] done");
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
