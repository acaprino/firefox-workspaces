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

// Give a role="button" element the keyboard behaviour of a real <button>:
// Enter activates on keydown (never on auto-repeat), Space on keyup.
function _bindButtonKeys(el) {
  el.addEventListener("keydown", (e) => {
    if (e.target !== el || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.key === "Enter" && !e.repeat) el.click();
    }
  });
  el.addEventListener("keyup", (e) => {
    if (e.target !== el || e.key !== " ") return;
    e.preventDefault();
    el.click();
  });
}

// Storage keys the popup watches. The literals match STORAGE_KEYS in
// backend/storage.js (the popup does not load backend scripts).
const PRIMARY_WINDOW_KEY = "primary-window-id";
const LAST_RESTORE_ERROR_KEY = "ld-wsp-last-restore-error";

// How long a workspace click keeps the popup open for the reply. A refusal
// ("still starting up") comes back at once and must be shown before the
// popup closes; a switch still running after this finishes in the
// background page without the popup.
const ACTIVATE_REPLY_GRACE_MS = 200;

// Workspace names are capped at the limit the background enforces
// (handler.js _sanitizeName, bookmark folder titles): 200 UTF-16 code units.
// Cutting at the same limit here means a name is never cut again there, and
// the cut never ends on the first half of a surrogate pair (half an emoji is
// stored, and exported to bookmarks, as U+FFFD). Keep in sync with the
// maxlength of #custom-dialog-input in wsp.html.
const WSP_NAME_MAX = 200;
function _clampWspName(name) {
  let s = String(name).trim().slice(0, WSP_NAME_MAX);
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  return s.trimEnd();
}

// The diagnostic dump is every ld-wsp-* storage key, including saved tab
// addresses (tabSnapshot, lastActiveTabUrl) and recently closed tabs with
// their titles and icons. The default copy keeps structure and counts but
// cuts every web address down to its site and drops titles and icons, so a
// dump pasted into a public bug report carries no browsing history or
// tokens from URLs. Equal addresses get equal tags (salted per copy, so a
// tag cannot be matched against a guessed address), which still shows
// which saved entries point at the same page.
const _DIAG_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*|\b(?:about|data|blob|javascript|view-source|mailto):[^\s"'<>]*/gi;
function _redactDiagnostics(dump) {
  const salt = Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join("");
  const tag = (s) => {
    let h = 0x811c9dc5;
    const t = salt + s;
    for (let i = 0; i < t.length; i++) {
      h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const redactUrl = (u) => {
    let url;
    try { url = new URL(u); } catch { return `[url ${tag(u)}]`; }
    if (/^(https?|wss?|ftp):$/.test(url.protocol)) {
      const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
      return `${url.protocol}//${url.host}/` + (bare ? "" : `[${tag(u)}]`);
    }
    // about:home / about:newtab say something about the session; a query
    // (about:reader?url=...) can hold a full address.
    if (url.protocol === "about:") {
      return `about:${url.pathname}` + (url.search || url.hash ? `[${tag(u)}]` : "");
    }
    return `${url.protocol}[${tag(u)}]`;
  };
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    if (typeof v !== "string" || v === "") return v;
    if (key === "title") return "[title removed]";
    if (key === "favIconUrl") return "[icon removed]";
    return v.replace(_DIAG_URL_RE, redactUrl);
  };
  return walk(dump, null);
}

class WorkspaceUI {
  constructor() {
    this.workspaces = [];
    this.containers = [];
    this.currentWindowId = null;
    this._dragDrop = null;
    this._tooltip = null;
    this._fullUi = false;
    this._activating = false;
    this._copyingDiagnostics = false;
    this._closedTabsSeq = 0;
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
    // Re-forward the recomputed hint after every re-apply: the background
    // cannot probe -moz-Dialog itself, and without this a theme switch while
    // the popup is open would leave the toolbar icon on the stale variant.
    let _themeUpdateTimer = null;
    browser.theme.onUpdated.addListener(({ theme }) => {
      clearTimeout(_themeUpdateTimer);
      _themeUpdateTimer = setTimeout(() => {
        const dark = applyTheme(theme);
        browser.runtime.sendMessage({ action: "setDarkModeHint", isDark: dark })
          .catch(e => console.debug("[WSP] setDarkModeHint failed:", e?.message));
      }, 80);
    });

    // OS scheme flips do not fire theme.onUpdated when the System theme is
    // active -- re-detect with fresh theme data and re-forward the hint.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
      try {
        const freshTheme = await browser.theme.getCurrent();
        const dark = applyTheme(freshTheme);
        browser.runtime.sendMessage({ action: "setDarkModeHint", isDark: dark })
          .catch(e => console.debug("[WSP] setDarkModeHint failed:", e?.message));
      } catch (e) {
        console.warn("[WSP] scheme-change re-apply failed:", e);
      }
    });

    // The recovery surface (banner, diagnostics link) needs messaging only
    // and works in every state, including the restricted view: a failed or
    // aborted restore leaves NO primary window at all. Start it first and in
    // parallel, so a warning written while the popup loads is not missed.
    this._setupDiagnosticsLink();
    const bannerReady = this._setupRestoreErrorBanner();

    await this._watchPrimaryWindow();
    await bannerReady;
    console.log("[WorkspaceUI][initialize] done");
  }

  // Show the workspace UI when this window is the primary one, a notice
  // otherwise. A restart restore claims the primary window last, possibly
  // while the popup is open, so follow storage.onChanged and switch to the
  // full UI then. The listener is registered before the first read, so a
  // claim landing in between is not lost.
  async _watchPrimaryWindow() {
    let changes = 0;
    const apply = (primaryWindowId) => {
      if (this._fullUi) return undefined; // once shown, the list stays
      if (primaryWindowId === this.currentWindowId) {
        this._fullUi = true;
        browser.storage.onChanged.removeListener(onChanged);
        return this._showWorkspaces();
      }
      this._showRestricted(primaryWindowId ?? null);
      return undefined;
    };
    const onChanged = (c, area) => {
      if (area !== "local" || !(PRIMARY_WINDOW_KEY in c)) return;
      changes++;
      Promise.resolve(apply(c[PRIMARY_WINDOW_KEY].newValue))
        .catch(e => console.warn("[WorkspaceUI][_watchPrimaryWindow] switch failed:", e));
    };
    browser.storage.onChanged.addListener(onChanged);

    const seen = changes;
    const primaryWindowId = await this._callBackgroundTask("getPrimaryWindowId");
    console.log("[WorkspaceUI][initialize] primaryWindowId:", primaryWindowId,
      "currentWindowId:", this.currentWindowId,
      "isPrimary:", primaryWindowId === this.currentWindowId);
    // A change event during the read already applied a newer value.
    if (changes === seen) await apply(primaryWindowId);
  }

  _showRestricted(primaryWindowId) {
    console.log("[WorkspaceUI][initialize] not primary window -- showing restricted UI, primary:", primaryWindowId);
    document.getElementById("createNewWsp").style.display = "none";
    document.getElementById("restoreFromBookmarks").style.display = "none";
    document.getElementById("wsp-search").hidden = true;
    const noWspLi = document.createElement("li");
    noWspLi.className = "no-wsp";
    // No primary window at all: a restart restore claims it last, and a
    // failed or paused restore leaves none (the banner explains that case).
    noWspLi.textContent = primaryWindowId == null
      ? "Workspaces are not active yet - right after Firefox starts, they appear here once the previous session is restored."
      : "Workspaces are only available in the primary window.";
    document.getElementById("wsp-list").replaceChildren(noWspLi);
  }

  async _showWorkspaces() {
    // Undo the restricted view (this window became the primary while the
    // popup was open).
    document.getElementById("createNewWsp").style.display = "";
    document.getElementById("restoreFromBookmarks").style.display = "";
    document.getElementById("wsp-search").hidden = false;

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
    const wspList = document.getElementById("wsp-list");
    wspList.replaceChildren();
    if (Array.isArray(workspaces)) {
      this.workspaces.push(...workspaces);
    } else {
      // A failed read is not an empty list: say so instead of showing none.
      const errLi = document.createElement("li");
      errLi.className = "no-wsp";
      errLi.textContent = "Could not load the workspaces - close and reopen this popup to try again.";
      wspList.appendChild(errLi);
    }
    console.log("[WorkspaceUI][initialize] containers:", this.containers.length,
      "workspaces:", this.workspaces.length,
      this.workspaces.map(w => `"${w.name}"(${w.tabs.length}t,active:${w.active})`));
    this.displayWorkspaces();
    this._bindArrowNavigation(wspList, ".wsp-row-main");
    this._setupCreateButton();
    this._setupRestoreButton();
    this.setupSearch();
    this.showClosedTabs();
  }

  // Render an inline banner when a restore-error payload is pending (see
  // backend/brainer.js: refuse-to-wipe, phase4-failure, session-not-restored).
  // Also render persisted tabs-closed-at-startup payloads from older versions.
  //
  // User actions:
  //   - Dismiss (acknowledgeLastRestoreError): clears the banner. For the two
  //     retry-able reasons the restart-retry signal stays armed.
  //   - Give up (giveUpRestoreRetry): clears the banner AND the retry signal
  //     (destructive; old workspaces become orphaned). Confirms first. Hidden
  //     for session-not-restored and tabs-closed-at-startup, where there is
  //     no retry to give up on.
  // Both actions echo the displayed payload's `when` so the background can
  // refuse a stale dismiss (compare-and-clear): if a fresh warning replaced
  // the displayed one mid-popup, the newer payload survives and is re-shown.
  // The banner stays in sync with the background via storage.onChanged.
  async _setupRestoreErrorBanner() {
    const banner = document.getElementById("wsp-error-banner");
    const text = document.getElementById("wsp-error-banner-text");
    const copyBtn = document.getElementById("wsp-error-copy");
    const ackBtn = document.getElementById("wsp-error-acknowledge");
    const giveUpBtn = document.getElementById("wsp-error-give-up");
    if (!banner || !text || !copyBtn || !ackBtn || !giveUpBtn) return;

    // Storage values can be edited via about:debugging; validate before
    // formatting them into user-visible text.
    const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
    // `when` of the payload currently rendered; echoed with dismiss/give-up.
    let displayedWhen = null;
    // Bumped on every render. A fetched payload is rendered only if nothing
    // rendered while it was in flight: a change event is always newer.
    let renderSeq = 0;

    const render = (payload) => {
      renderSeq++;
      if (!payload) {
        displayedWhen = null;
        banner.hidden = true;
        return;
      }
      displayedWhen = isFiniteNum(payload.when) ? payload.when : null;
      const when = isFiniteNum(payload.when) ? new Date(payload.when).toLocaleString() : "earlier";
      const wspCount = isFiniteNum(payload.wspCount) ? payload.wspCount : "?";
      const urlCount = isFiniteNum(payload.snapshotUrlCount) ? payload.snapshotUrlCount : "?";
      const exportedUrls = isFiniteNum(payload.exportedUrls) ? payload.exportedUrls : null;
      const exportedNote = (folders) => {
        if (folders <= 0) return `No tab list could be exported to bookmarks. `;
        // Honest counts: the export filters non-bookmarkable URLs and can
        // partially fail, so prefer the actual exported-URL count when the
        // background provided it.
        const counts = exportedUrls != null && exportedUrls !== urlCount
          ? `${exportedUrls} of ${urlCount} URL(s)`
          : `${urlCount} URL(s)`;
        return `The saved tab lists (${counts}) were exported to bookmarks under ` +
          `"Workspaces", use "Restore from bookmarks" to reopen them. `;
      };
      if (payload.reason === "session-not-restored" || payload.reason === "tabs-closed-at-startup") {
        // Missing tabs and fresh undo entries do not prove when or why a tab
        // was closed. Keep recovery voluntary and describe only known facts.
        const exported = isFiniteNum(payload.exportedWorkspaces) ? payload.exportedWorkspaces : 0;
        const legacyRecovery = payload.reason === "tabs-closed-at-startup";
        const restoredCount = isFiniteNum(payload.restoredCount) ? payload.restoredCount : 0;
        const outcome = legacyRecovery
          ? (restoredCount > 0
            ? `An earlier automatic recovery reopened ${restoredCount} tab(s). `
            : `An earlier automatic recovery did not report any reopened tabs. `)
          : `Closed tabs were not reopened automatically. `;
        text.textContent =
          `Workspace tabs were not fully restored when the browser started at ${when}. ` +
          `Saved tab lists for ${wspCount} workspace(s) contained ${urlCount} URL(s). ` +
          outcome + exportedNote(exported) +
          `Review the saved lists before restoring - they may include tabs you intentionally closed. ` +
          `You can also check History > Recently closed tabs in Firefox.`;
        giveUpBtn.hidden = true;
      } else {
        const reason = payload.reason === "phase4-failure"
          ? `A previous restore attempt failed mid-way at ${when}.`
          : `Workspace restore was paused at ${when} to prevent data loss.`;
        // A failed commit after incomplete recovery may already have a
        // bookmark backup. Report the export counts, not a presumed cause.
        const lossNote = payload.sessionLost === true
          ? ` Some workspace tabs were missing during startup. ` +
            exportedNote(isFiniteNum(payload.exportedWorkspaces) ? payload.exportedWorkspaces : 0)
          : ` Try restarting Firefox to retry the restore. `;
        text.textContent =
          `${reason} ${wspCount} workspace(s) had ${urlCount} previously open URL(s) recorded. ` +
          `User data was left untouched.` + lossNote +
          `Use "Give up" only if you no longer need the workspaces from before the failed restart.`;
        giveUpBtn.hidden = false;
      }
      banner.hidden = false;
    };

    // Re-read the pending payload. False when the background could not be
    // asked; the banner then keeps what it shows.
    const refresh = async () => {
      const seq = renderSeq;
      let payload;
      try {
        payload = await this._request("getLastRestoreError");
      } catch (e) {
        console.debug("[WSP][_setupRestoreErrorBanner] getLastRestoreError failed:", e?.message);
        return false;
      }
      if (seq === renderSeq) render(payload || null);
      return true;
    };

    // Keep the banner in sync with the background for the popup's lifetime:
    // a warning raised or replaced after open (slow session-loss export, a
    // restore committing mid-popup) re-renders instead of going stale.
    // Registered BEFORE the first read: a warning written between the
    // background's read and a later registration would never reach this popup.
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(LAST_RESTORE_ERROR_KEY in changes)) return;
      render(changes[LAST_RESTORE_ERROR_KEY].newValue || null);
    });

    // Bind the action listeners BEFORE the first render: a warning can arrive
    // after open via storage.onChanged, and its banner must have live buttons.
    copyBtn.addEventListener("click", () => {
      this._copyDiagnostics();
    });
    ackBtn.addEventListener("click", async () => {
      // Optimistic UI: hide the banner immediately so the user sees feedback
      // even if the background storage write is slow. On failure or a stale
      // ack (payload changed since display) re-sync from storage so the
      // banner and the toolbar badge cannot disagree.
      const when = displayedWhen;
      banner.hidden = true;
      let result;
      let error = null;
      try {
        result = await this._request("acknowledgeLastRestoreError", { when });
      } catch (e) {
        console.debug("[WSP][acknowledge] failed:", e?.message);
        error = e;
      }
      if (!error && !result?.stale) return;
      if (!(await refresh())) banner.hidden = false;
      if (error?.userFacing) await this._showFailure(error, null);
    });
    giveUpBtn.addEventListener("click", async () => {
      // The confirm hides the banner while it is open, and the payload can
      // change meanwhile (a restore committing, a session-loss warning):
      // act only on the payload that was displayed when the user clicked.
      const whenAtClick = displayedWhen;
      // showCustomDialog returns true on OK, false on Cancel for no-input dialogs.
      const ok = await showCustomDialog({
        message:
          "Give up the automatic restore retry?\n\n" +
          "Where possible, the saved tab lists of the old workspaces will first be " +
          "exported to bookmarks (under \"Workspaces\"), so you can bring them back " +
          "later via \"Restore from bookmarks\". The next Firefox start will create " +
          "a fresh default workspace.\n\n" +
          "If you have not copied the diagnostic dump yet, do that first."
      });
      if (!ok) return;
      const showChanged = () => showCustomDialog({
        message: "The restore status changed while this dialog was open, so nothing was given up." +
          (banner.hidden ? "" : " The banner shows the current status."),
        infoOnly: true
      });
      if (banner.hidden || displayedWhen !== whenAtClick) {
        await showChanged();
        return;
      }
      banner.hidden = true;
      let result;
      let error = null;
      try {
        result = await this._request("giveUpRestoreRetry", { when: whenAtClick });
      } catch (e) {
        console.debug("[WSP][giveUpRestoreRetry] failed:", e?.message);
        error = e;
      }
      if (error || result?.stale) {
        if (!(await refresh())) banner.hidden = false;
        if (error) {
          await this._showFailure(error, "Could not give up the restore retry. Please try again.");
        } else {
          await showChanged();
        }
        return;
      }
      if (result?.exportedWorkspaces > 0) {
        await showCustomDialog({
          message: `Saved ${result.exportedWorkspaces} workspace(s) to bookmarks ` +
            `under "Workspaces". Restore them any time via "Restore from bookmarks".`,
          infoOnly: true
        });
      } else if (result?.alreadyExported) {
        await showCustomDialog({
          message: `The workspace tab lists were already saved to bookmarks under ` +
            `"Workspaces". Restore them any time via "Restore from bookmarks".`,
          infoOnly: true
        });
      }
    });

    await refresh();
  }

  _setupDiagnosticsLink() {
    const link = document.getElementById("wsp-copy-diagnostics");
    if (!link) return;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      this._copyDiagnostics();
    });
  }

  // Ask first, then copy: by default a redacted dump (see
  // _redactDiagnostics), the full one only when the user ticks the box.
  async _copyDiagnostics() {
    // The banner button and the footer link share this; one dialog at a time.
    if (this._copyingDiagnostics) return;
    this._copyingDiagnostics = true;
    try {
      const choice = await showCustomDialog({
        message:
          "Copy a diagnostic dump to the clipboard?\n\n" +
          "It lists your workspaces (names, icons, colors, containers, window and tab ids, " +
          "tab counts) and the saved restore state. Web addresses are cut down to their " +
          "site, for example https://example.com/, and tab titles and icons are left out.\n\n" +
          "Tick the box only if you were asked for the full dump: it also holds the complete " +
          "address of every saved and recently closed tab - including any login or session " +
          "tokens in them - and their titles.",
        showCheckbox: true,
        checkboxLabel: "Include full web addresses and tab titles",
        checkboxDefault: false
      });
      if (!choice) return;
      const full = !!choice.checked;

      let dump;
      try {
        dump = await this._request("getDiagnostics");
      } catch (e) {
        console.warn("[WSP][_copyDiagnostics] failed:", e?.message);
      }
      if (!dump || typeof dump !== "object") {
        await showCustomDialog({
          message: "Could not read the diagnostic data. Close and reopen this popup, then try again.",
          infoOnly: true
        });
        return;
      }
      const json = JSON.stringify(full ? dump : _redactDiagnostics(dump), null, 2);
      try {
        await navigator.clipboard.writeText(json);
      } catch (e) {
        console.warn("[WSP][_copyDiagnostics] clipboard write failed:", e?.message);
        await showCustomDialog({ message: "Clipboard write blocked. JSON length: " + json.length, infoOnly: true });
        return;
      }
      console.log("[WSP][_copyDiagnostics] copied", json.length, "chars, full:", full);
      await showCustomDialog({
        message: full
          ? `Full diagnostic dump copied to the clipboard (${json.length} characters). ` +
            `It contains complete web addresses and tab titles - review it before sharing.`
          : `Diagnostic dump copied to the clipboard (${json.length} characters). ` +
            `Web addresses were cut down to their site and tab titles were left out - ` +
            `review it before sharing.`,
        infoOnly: true
      });
    } finally {
      this._copyingDiagnostics = false;
    }
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
      const btn = e.currentTarget;
      // Re-entrancy guard: a double-click used to open two dialogs on the
      // same singleton DOM, and one OK click then fired two create calls.
      if (btn.dataset.busy) return;
      btn.dataset.busy = "1";
      try {
        const windowId = this.currentWindowId;
        console.log("[WorkspaceUI][createNewWsp] clicked, windowId:", windowId);

        const result = await showCustomDialog({
          message: "Create workspace:",
          withInput: true,
          defaultValue: (await this._callBackgroundTask("getWorkspaceName")) || "",
          showContainerPicker: this.containers.length > 0,
          containers: this.containers,
          showColorPicker: true
        });
        if (result === false) {
          console.log("[WorkspaceUI][createNewWsp] dialog cancelled");
          return;
        }

        const wspName = _clampWspName(result.name);
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

        let created;
        try {
          created = await this._request("createWorkspaceWithTab", wsp);
        } catch (err) {
          console.log("[WorkspaceUI][createNewWsp] create failed");
          await this._showFailure(err, "Could not create the workspace. Please try again.");
          return;
        }
        if (!created?.wspId) {
          console.log("[WorkspaceUI][createNewWsp] create returned no workspace id");
          return;
        }

        wsp.id = created.wspId;
        wsp.tabs.push(created.tabId);
        this.workspaces.push(wsp);
        console.log("[WorkspaceUI][createNewWsp] workspace created -- wspId:", wsp.id, "tabId:", created.tabId);

        this._addWorkspace(wsp);
        // The new workspace is the active one now: move the flag in the
        // model too, and show its (empty) Recently Closed list instead of
        // the previous workspace's, whose Restore / Clear would act there.
        this._setActiveWorkspace(wsp.id);
        this.showClosedTabs();
      } finally {
        delete btn.dataset.busy;
      }
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

        let folders;
        try {
          folders = await this._request("getBookmarkWorkspaces");
        } catch (err) {
          await this._showFailure(err, "Could not read the saved workspaces from bookmarks.");
          return;
        }
        if (!folders || folders.length === 0) {
          await showCustomDialog({ message: "No saved workspaces found in bookmarks.", infoOnly: true });
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
        let restored;
        try {
          restored = await this._request("restoreWorkspaceFromBookmarks", {
            folderId: result.folderId,
            windowId: this.currentWindowId
          });
        } catch (err) {
          console.log("[WorkspaceUI][restoreFromBookmarks] restore failed");
          await this._showFailure(err, "Could not restore the workspace from bookmarks.");
          return;
        }

        console.log("[WorkspaceUI][restoreFromBookmarks] restored:", restored?.name, "tabs:", restored?.tabCount);
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
    let searchSeq = 0;
    let pendingSearch = null;

    const runSearch = async () => {
      const seq = ++searchSeq;
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
      // Drop a stale reply: a newer search started, or the box changed
      // (for example was cleared, and its own debounced run is still
      // pending) while this one was in flight.
      if (seq !== searchSeq || searchInput.value.trim() !== query) return;

      searchResults.replaceChildren();
      wspList.hidden = true;
      closedTabs.hidden = true;

      if (!results || results.length === 0) {
        const empty = document.createElement("div");
        empty.className = "wsp-search-empty";
        // null is a failed search, not an empty result.
        empty.textContent = results === null ? "Search is not available right now" : "No matching tabs found";
        searchResults.replaceChildren(empty);
        searchResults.hidden = false;
        return;
      }

      for (const r of results) {
        const item = document.createElement("div");
        item.classList.add("wsp-search-result");
        item.dataset.wspId = r.wspId;
        item.dataset.tabId = r.tabId;
        item.setAttribute("role", "button");
        item.tabIndex = 0;
        _bindButtonKeys(item);

        const titleEl = document.createElement("span");
        titleEl.classList.add("wsp-search-result-title");
        titleEl.textContent = r.title;
        item.appendChild(titleEl);

        const wspEl = document.createElement("span");
        wspEl.classList.add("wsp-search-result-wsp");
        wspEl.textContent = r.wspName;
        item.appendChild(wspEl);

        item.addEventListener("click", () => {
          if (this._activating) return;
          this._activateWorkspace({
            wspId: r.wspId,
            windowId: this.currentWindowId,
            tabId: r.tabId
          });
        });

        searchResults.appendChild(item);
      }
      searchResults.hidden = false;
    };

    searchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        pendingSearch = runSearch();
      }, 150);
    });

    // Enter opens the first hit; Down moves into the results (or the list).
    searchInput.addEventListener("keydown", async (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.repeat) {
        e.preventDefault();
        // Run a still-debounced search now, so the hit matches what was typed.
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
          pendingSearch = runSearch();
        }
        await pendingSearch;
        if (!searchResults.hidden) searchResults.querySelector(".wsp-search-result")?.click();
      } else if (e.key === "ArrowDown") {
        const first = searchResults.hidden
          ? wspList.querySelector(".wsp-row-main")
          : searchResults.querySelector(".wsp-search-result");
        if (first) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    this._bindArrowNavigation(searchResults, ".wsp-search-result");

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
    // Only the latest render may paint: an older one can still be waiting
    // for the list of a workspace that is no longer active.
    const seq = ++this._closedTabsSeq;

    const activeWsp = this.workspaces.find(w => w.active);
    if (!activeWsp) {
      console.log("[WorkspaceUI][showClosedTabs] no active workspace -- hiding section");
      container.hidden = true;
      return;
    }

    const closedTabs = await this._callBackgroundTask("getClosedTabs", { wspId: activeWsp.id });
    if (seq !== this._closedTabsSeq) return;
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
      restoreBtn.setAttribute("aria-label", `Restore "${tab.title || tab.url}"`);

      li.addEventListener("click", async () => {
        // Disable all closed-tab items to prevent double clicks
        const allItems = list.querySelectorAll(".wsp-closed-tab-item");
        for (const item of allItems) item.style.pointerEvents = "none";

        // Address the entry by identity (url + closedAt), not by index: the
        // stored array mutates while the popup is open (new closures
        // unshift), so a render-time index can restore the wrong tab.
        console.log("[WorkspaceUI][restoreClosedTab] restoring:", tab.url);
        try {
          // A null reply is not a failure: the entry was already restored
          // or cleared, and the re-render below drops it.
          await this._request("restoreClosedTab", {
            wspId: activeWsp.id,
            url: tab.url,
            closedAt: tab.closedAt,
            windowId: this.currentWindowId
          });
        } catch (err) {
          await this._showFailure(err, "Could not restore the tab. Please try again.");
        }
        this.showClosedTabs();
      });

      li.appendChild(restoreBtn);
      list.appendChild(li);
    }

    // Clear all handler
    clearBtn.onclick = async () => {
      try {
        await this._request("clearClosedTabs", { wspId: activeWsp.id });
      } catch (err) {
        await this._showFailure(err, "Could not clear the recently closed tabs. Please try again.");
        return;
      }
      container.hidden = true;
    };
  }

  // Up/Down move focus between the items of a list (workspace rows, search
  // results); Up from the first item returns to the search box.
  _bindArrowNavigation(container, itemSelector) {
    container.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = [...container.querySelectorAll(itemSelector)];
      const i = items.indexOf(e.target);
      if (i === -1) return;
      e.preventDefault();
      const next = items[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        next.focus();
      } else if (e.key === "ArrowUp" && !document.getElementById("wsp-search").hidden) {
        document.getElementById("wsp-search-input").focus();
      }
    });
  }

  // Send `action` to the background and resolve with its reply. Rejects on
  // a messaging failure (e.g. background not ready on a cold start) and on
  // an `_error` reply; `err.userFacing` marks a deliberate refusal ("Cannot
  // destroy the last workspace", "still starting up", ...) whose message is
  // written for the user. Callers that must tell a failure from a null
  // reply, or report the failure themselves, use this.
  async _request(action, args) {
    const message = { action, ...args };
    if (WSP_DEBUG) {
      console.log("[WorkspaceUI][_request] ->", action,
        args ? JSON.stringify(args) : "");
    }
    let result;
    try {
      result = await browser.runtime.sendMessage(message);
    } catch (e) {
      console.error(`[Workspaces] ${action} failed:`, e?.message);
      throw e instanceof Error ? e : new Error(String(e));
    }
    if (result && result._error) {
      console.error(`[Workspaces] ${action} failed:`, result.message);
      const err = new Error(result.message || "An internal error occurred");
      err.userFacing = !!(result._userFacing && result.message);
      throw err;
    }
    if (WSP_DEBUG) {
      console.log("[WorkspaceUI][_request] <-", action, "result:",
        result === null ? "null" :
        Array.isArray(result) ? `[array len=${result.length}]` :
        typeof result === "object" ? `{${Object.keys(result).join(",")}}` : result);
    }
    return result;
  }

  // Fail-soft variant for reads and fire-and-forget calls: resolves with the
  // reply, or null on any failure. A refusal meant for the user is still
  // shown (fire-and-forget, so a caller is not blocked by the notice); a
  // caller that gets null must not show a dialog of its own.
  async _callBackgroundTask(action, args) {
    try {
      return await this._request(action, args);
    } catch (e) {
      if (e.userFacing) showCustomDialog({ message: e.message, infoOnly: true }).catch(() => {});
      return null;
    }
  }

  // Tell the user that an action failed: in the background's own words for
  // a deliberate refusal, else `fallback` (nothing when it is null).
  async _showFailure(err, fallback) {
    const message = err?.userFacing ? err.message : fallback;
    if (!message) return;
    await showCustomDialog({ message, infoOnly: true }).catch(() => {});
  }

  // Ask the background to switch workspaces, then close the popup. The
  // switch is not awaited in full (on large windows the hide/show cascade
  // takes seconds, and the persistent background page finishes it without
  // the popup), but a refusal comes back at once - the handler refuses
  // while Firefox is still restoring the session - so wait briefly for it
  // and keep the popup open to show it, instead of closing on a click that
  // did nothing. `onFailed` undoes the caller's optimistic UI.
  async _activateWorkspace(args, onFailed = null) {
    this._activating = true;
    const PENDING = {};
    let timer;
    const grace = new Promise((resolve) => { timer = setTimeout(() => resolve(PENDING), ACTIVATE_REPLY_GRACE_MS); });
    const reply = this._request("activateWorkspace", args).then(() => null, (e) => e);
    const early = await Promise.race([reply, grace]);
    clearTimeout(timer);
    if (early === PENDING || early === null) {
      console.log("[WorkspaceUI][switchWorkspace] done -- closing popup");
      window.close();
      return;
    }
    console.log("[WorkspaceUI][switchWorkspace] refused:", early.message);
    this._activating = false;
    if (onFailed) onFailed();
    await this._showFailure(early, "Could not switch workspaces. Please try again.");
  }

  _createWorkspaceItem(workspace) {
    const li = document.createElement("li");
    li.classList.add("wsp-list-item");
    if (workspace.active) li.classList.add("active");
    li.dataset.wspId = workspace.id;
    li.draggable = true;

    // Row body: the keyboard and screen-reader target for switching, holding
    // the dot, icon, name and tab count. A role="button" element, not a
    // <button>, so dragging the row still works (Firefox does not start a
    // drag from a <button>). The action buttons stay outside it: a button's
    // children are presentational to assistive technology.
    const main = document.createElement("div");
    main.classList.add("wsp-row-main");
    main.setAttribute("role", "button");
    main.tabIndex = 0;
    main.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    if (workspace.active) main.setAttribute("aria-current", "true");
    _bindButtonKeys(main);
    li.appendChild(main);

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
    main.appendChild(dot);

    let iconEl = null;
    if (workspace.icon) {
      iconEl = _createIconElement(workspace.icon, "wsp-icon");
      iconEl.alt = ""; // decorative: the name follows
      main.appendChild(iconEl);
    }

    const span1 = document.createElement("span");
    span1.classList.add("wsp-name");
    span1.spellcheck = false;
    span1.textContent = workspace.name;
    span1.title = workspace.name;
    main.appendChild(span1);

    const span2 = document.createElement("span");
    span2.classList.add("tabs-qty");
    span2.textContent = workspace.tabs.length + " tabs";
    main.appendChild(span2);

    // Icon-only actions, in visual order (export, rename, delete) so Tab
    // follows what the user sees. aria-label names the workspace.
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.classList.add("edit-btn", "export-btn");
    exportBtn.title = "Export to bookmarks";
    li.appendChild(exportBtn);

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.classList.add("edit-btn", "rename-btn");
    renameBtn.title = "Rename workspace";
    li.appendChild(renameBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.classList.add("edit-btn", "delete-btn");
    deleteBtn.title = "Delete workspace";
    li.appendChild(deleteBtn);

    const labelActions = (name) => {
      exportBtn.setAttribute("aria-label", `Export workspace "${name}" to bookmarks`);
      renameBtn.setAttribute("aria-label", `Rename workspace "${name}"`);
      deleteBtn.setAttribute("aria-label", `Delete workspace "${name}"`);
    };
    labelActions(workspace.name);

    li.dataset.originalText = span1.textContent;
    li.dataset.wspIcon = workspace.icon || "";

    // Apply workspace color bar
    this._applyColorBar(li, workspace);

    // ── Drag and Drop (Tier 3) ──
    this._dragDrop.attach(li, workspace.id);

    // ── Tab preview tooltip on hover (Tier 3) ──
    this._tooltip.attach(li, workspace.id, () => this._dragDrop.dragSrcEl !== null);

    // Keyboard alternative to drag and drop: Alt+Up / Alt+Down.
    main.addEventListener("keydown", (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      this._dragDrop.moveBy(li, e.key === "ArrowUp" ? -1 : 1);
    });

    // Switch workspace
    li.addEventListener("click", async () => {
      if (li.classList.contains("active")) {
        console.log("[WorkspaceUI][switchWorkspace] already active:", workspace.id, "-- no-op");
        return;
      }
      // One switch at a time while the popup waits for the reply.
      if (this._activating) return;
      console.log("[WorkspaceUI][switchWorkspace] activating:", workspace.id, workspace.name);

      // Optimistic: mark the row now, and put the mark back if refused.
      const previousId = this.workspaces.find(w => w.active)?.id ?? null;
      this._setActiveWorkspace(workspace.id);
      await this._activateWorkspace(
        { wspId: workspace.id, windowId: workspace.windowId },
        () => this._setActiveWorkspace(previousId)
      );
    });

    // Export to bookmarks
    // Re-entrancy guards use data-busy, not `disabled`: a disabled button
    // cannot take focus back when the dialog closes.
    exportBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (exportBtn.dataset.busy) return;
      exportBtn.dataset.busy = "1";
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
        let exportResult;
        let exportError = null;
        try {
          exportResult = await this._request("exportWorkspaceToBookmarks", {
            wspId: workspace.id,
            windowId: this.currentWindowId,
            destroyAfter: !!result.checked
          });
        } catch (err) {
          exportError = err;
        }
        if (exportError || !exportResult) {
          console.log("[WorkspaceUI][exportBtn] export failed");
          await this._showFailure(exportError, "Could not export the workspace to bookmarks.");
          return;
        }
        console.log("[WorkspaceUI][exportBtn] exported", exportResult.exported,
          "of", exportResult.total, "tabs to:", exportResult.folderTitle);

        // Surface partial exports and destroy refusals: silently closing (or
        // silently not closing) tabs the user believes are backed up is the
        // data-loss path this dialog exists to prevent.
        if (result.checked && !exportResult.destroyed && exportResult.destroyRefusedMessage) {
          await showCustomDialog({ message: exportResult.destroyRefusedMessage, infoOnly: true });
        } else if (exportResult.exported < exportResult.total) {
          await showCustomDialog({
            message: `Exported ${exportResult.exported} of ${exportResult.total} tabs. ` +
              `${exportResult.total - exportResult.exported} tab(s) could not be bookmarked ` +
              `(pages like about:, file: or reader view cannot be saved as bookmarks).`,
            infoOnly: true
          });
        }

        if (exportResult.destroyed) {
          this._dropWorkspace(li, workspace, exportResult.activatedWspId);
        }
      } finally {
        delete exportBtn.dataset.busy;
      }
    });

    // Rename
    renameBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      // Re-entrancy guard: same double-dialog hazard as the create button.
      if (renameBtn.dataset.busy) return;
      renameBtn.dataset.busy = "1";
      try {
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
        const originalName = li.dataset.originalText;
        // An untouched name is kept as it is, never cut again (a name
        // restored from a bookmark folder title can be longer than what
        // the popup lets you type).
        const wspName = result.name === originalName ? originalName : _clampWspName(result.name);
        if (wspName.length === 0) return;
        const wspIcon = result.icon || "";

        const wspColor = result.color;
        const nameChanged = wspName !== originalName;
        const iconChanged = wspIcon !== (li.dataset.wspIcon || "");
        const colorChanged = wspColor !== (workspace.color || null);
        const containerChanged = result.containerId !== undefined && result.containerId !== (workspace.containerId || null);
        console.log("[WorkspaceUI][renameBtn] changes -- name:", nameChanged,
          "icon:", iconChanged, "color:", colorChanged, "container:", containerChanged,
          "| new values: name:", wspName, "icon:", wspIcon, "color:", wspColor,
          "containerId:", result.containerId);

        if (!nameChanged && !iconChanged && !containerChanged && !colorChanged) {
          console.log("[WorkspaceUI][renameBtn] no changes detected -- skipping");
          return;
        }

        // Show the new values only once the background stored them.
        try {
          await this._request("renameWorkspace", { wspId: workspace.id, wspName, wspIcon, wspColor });
        } catch (err) {
          await this._showFailure(err, "Could not save the workspace changes. Please try again.");
          return;
        }

        workspace.name = wspName;
        workspace.icon = wspIcon;
        li.dataset.originalText = wspName;
        li.dataset.wspIcon = wspIcon;
        span1.textContent = wspName;
        span1.title = wspName;
        labelActions(wspName);

        // Update icon element
        if (iconEl && iconEl.parentElement) iconEl.remove();
        if (wspIcon) {
          iconEl = _createIconElement(wspIcon, "wsp-icon");
          iconEl.alt = "";
          // Between the container dot and the name
          span1.before(iconEl);
        } else {
          iconEl = null;
        }

        // Update color bar
        if (colorChanged) {
          workspace.color = wspColor;
          this._applyColorBar(li, workspace);
        }

        // Update container if changed
        if (containerChanged) {
          try {
            await this._request("setWorkspaceContainer", {
              wspId: workspace.id,
              containerId: result.containerId
            });
          } catch (err) {
            await this._showFailure(err, "Could not change the workspace's container. Please try again.");
            return;
          }
          workspace.containerId = result.containerId;

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
      } finally {
        delete renameBtn.dataset.busy;
      }
    });

    // Delete
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (deleteBtn.dataset.busy) return;
      deleteBtn.dataset.busy = "1";
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

        let destroyResult;
        try {
          destroyResult = await this._request("destroyWsp", {
            wspId: workspace.id,
            windowId: this.currentWindowId,
          });
        } catch (err) {
          console.log("[WorkspaceUI][deleteBtn] destroy failed");
          await this._showFailure(err, "Could not delete the workspace. Please try again.");
          return;
        }

        this._dropWorkspace(li, workspace, destroyResult?.activatedWspId);
        console.log("[WorkspaceUI][deleteBtn] done");
      } finally {
        delete deleteBtn.dataset.busy;
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
    // A "could not load" notice is stale once a row exists.
    wspList.querySelector("li.no-wsp")?.remove();
    wspList.appendChild(li);
    // No sorting — order is now controlled by drag-and-drop / backend order
    return li;
  }

  // Make `wspId` the active workspace in the popup's model and rows (null:
  // none). Recently Closed and its Restore / Clear follow the model, so every
  // popup action that changes the active workspace goes through here.
  _setActiveWorkspace(wspId) {
    for (const w of this.workspaces) w.active = w.id === wspId;
    for (const row of document.querySelectorAll("#wsp-list li.wsp-list-item")) {
      this._setRowActive(row, row.dataset.wspId === wspId);
    }
  }

  // A workspace was destroyed (delete, or export + close): drop its row and
  // its model entry. When it was the active one, the background activated
  // `activatedWspId`, so move the active mark there and show that
  // workspace's Recently Closed list.
  _dropWorkspace(li, workspace, activatedWspId) {
    const wasActive = workspace.active || li.classList.contains("active");
    if (li.parentNode) this._removeRow(li);
    const i = this.workspaces.indexOf(workspace);
    if (i !== -1) this.workspaces.splice(i, 1);
    if (wasActive) {
      console.log("[WorkspaceUI][_dropWorkspace] marking activated:", activatedWspId ?? null);
      this._setActiveWorkspace(activatedWspId ?? null);
      this.showClosedTabs();
    }
  }

  // Keep the visual "active" class and the screen-reader state in step.
  _setRowActive(li, active) {
    li.classList.toggle("active", active);
    const main = li.querySelector(".wsp-row-main");
    if (!main) return;
    if (active) main.setAttribute("aria-current", "true");
    else main.removeAttribute("aria-current");
  }

  // Remove a workspace row. If it held keyboard focus, hand focus to the
  // neighbouring row instead of letting it fall to <body>.
  _removeRow(li) {
    const neighbour = li.nextElementSibling || li.previousElementSibling;
    const hadFocus = li.contains(document.activeElement);
    li.remove();
    if (hadFocus) neighbour?.querySelector(".wsp-row-main")?.focus();
  }
}

(async () => {
  const wsp = new WorkspaceUI();
  await wsp.initialize();
})();
