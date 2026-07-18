// Default badge background when no theme accent is available.
// Note: the shared THEME_ACCENT_KEYS list and pickAccentFromThemeColors()
// live in backend/theme-utils.js (loaded first via manifest background.scripts).
const BADGE_FALLBACK_COLOR = "#0078D4";
// Badge background while a restore-error / session-loss warning is pending.
const BADGE_WARNING_COLOR = "#d70022";

// Strict CSS color validator. Accepts hex (#abc / #aabbcc / #aabbccdd),
// rgb()/rgba()/hsl()/hsla() with numeric args, and a small named-color
// whitelist. Rejects anything containing ;, }, {, <, >, url(, or backslash
// to prevent a malicious/malformed LWT theme from feeding arbitrary CSS
// tokens into setBadgeBackgroundColor or style.setProperty.
const _NAMED_COLOR_RE = /^(transparent|currentcolor|black|white|red|green|blue|yellow|cyan|magenta|gray|grey|orange|purple|pink|brown)$/i;
const _HEX_COLOR_RE   = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const _FUNC_COLOR_RE  = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^;{}<>\\]*\)$/i;
function _isSafeCssColor(value) {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (s.length === 0 || s.length > 128) return false;
  if (/[;{}<>\\]/.test(s)) return false;
  return _HEX_COLOR_RE.test(s) || _FUNC_COLOR_RE.test(s) || _NAMED_COLOR_RE.test(s);
}

// Toolbar button icon, badge, and SVG handling
class UIService {
  // Cache SVG data URLs keyed by "iconName:fillColor" to avoid repeated fetch+encode
  static _svgCache = new Map();
  static _SVG_CACHE_MAX = 100;
  // Cached isDark result — invalidated by theme.onUpdated via clearThemeCache()
  static _isDarkCache = null;
  // Cached badge color string — invalidated alongside _isDarkCache. Without
  // this, updateToolbarButton would issue a browser.theme.getCurrent() IPC
  // round-trip on every focus change, tab create, and tab remove, adding
  // sustained background traffic for users with high tab churn.
  static _cachedBadgeColor = null;
  // Cached presence of the lastRestoreError surface, read on every toolbar
  // update (hot path). null = unknown (re-read from storage on next update);
  // reset to null via invalidateWarnBadgeCache() from
  // WSPStorageManager.setLastRestoreError/clearLastRestoreError.
  static _warnBadgeCache = null;

  // Monotonic counter bumped whenever the warn state changes. updateToolbarButton
  // snapshots it at entry and skips its badge writes if it changed mid-flight:
  // without this, an in-flight update that captured the pre-warning state could
  // overwrite a freshly raised "!" with a stale tab count (last-write-wins).
  // Every bump site is followed by a refreshWarnBadge/updateToolbarButton call,
  // so a skipped write is always repainted by the newer pass.
  static _warnGeneration = 0;

  // Accessor for the warn-badge cache so other layers (storage.js write
  // points) don't touch the private field directly -- same precedent as
  // Brainer.setRefuseToWipeActive.
  static invalidateWarnBadgeCache() {
    UIService._warnBadgeCache = null;
    UIService._warnGeneration++;
  }

  // Force the warn badge on without a storage read. Used when storing the
  // warning payload itself failed: the banner is lost for this session, but
  // the toolbar can still signal that something happened. Self-corrects at
  // the next invalidation (which re-reads storage).
  static forceWarnBadge() {
    UIService._warnBadgeCache = true;
    UIService._warnGeneration++;
  }

  // Refresh the toolbar badge after a lastRestoreError write or clear.
  // Resolves the target window (explicit -> primary -> last focused) so the
  // refresh also works in the no-primary recovery states (refuse-to-wipe /
  // phase4-failure), where getPrimaryWindowId() is null. Never throws.
  static async refreshWarnBadge(windowId = null) {
    try {
      let target = windowId;
      if (target == null) target = await WSPStorageManager.getPrimaryWindowId();
      if (target == null) {
        const win = await browser.windows.getLastFocused().catch(() => null);
        target = win?.id ?? null;
      }
      if (target != null) await UIService.updateToolbarButton(target);
    } catch (e) {
      console.debug("[UIService][refreshWarnBadge] failed:", e?.message);
    }
  }
  // Dark-mode hint forwarded from the popup (popup has a real rendering context
  // where -moz-Dialog resolves correctly, unlike the hidden background page).
  // Set via "setDarkModeHint" message. null = no hint yet.
  static _darkModeHint = null;

  static _VALID_ICONS = new Set([
    "airplane", "beaker", "book", "briefcase", "camera", "cart", "chart",
    "code", "database", "document", "fire", "flash", "folder", "food",
    "games", "globe", "graduation", "heart", "home", "laptop", "lightbulb",
    "lock", "mail", "money", "music", "paint-brush", "phone", "rocket",
    "star", "target", "video", "wrench"
  ]);

  // Pick the theme's accent color. Thin wrapper around the shared
  // pickAccentFromThemeColors (backend/theme-utils.js): re-runs the same
  // canonical chain, then validates string values via _isSafeCssColor
  // before they reach the setBadgeBackgroundColor API.
  static _pickAccentColor(colors) {
    const raw = pickAccentFromThemeColors(colors);
    if (raw === null) return null;
    // Arrays are already serialized into `rgb(...)` form by the shared
    // helper — trust that output. Strings must still pass the validator.
    if (raw.startsWith("rgb(")) return raw;
    return _isSafeCssColor(raw) ? raw.trim() : null;
  }

  // Detect dark theme from theme.colors. Thin wrapper around the shared
  // detectDarkFromThemeColors so the backend and popup stay in sync on
  // the threshold + candidate chain.
  static _detectDarkFromColors(colors) {
    return detectDarkFromThemeColors(colors);
  }

  static clearThemeCache() {
    console.log("[UIService][clearThemeCache] invalidating _isDarkCache (was:", UIService._isDarkCache,
      ") _darkModeHint (was:", UIService._darkModeHint,
      ") _cachedBadgeColor (was:", UIService._cachedBadgeColor, ")");
    UIService._isDarkCache = null;
    UIService._darkModeHint = null;
    UIService._cachedBadgeColor = null;
    // Also clear persisted hint so stale value doesn't override fresh theme detection.
    browser.storage.local.remove("ld-wsp-dark-hint").catch(() => {});
  }

  // Full theme-cache invalidation (SVG data URLs + dark/badge caches).
  // Callers used to clear _svgCache directly alongside clearThemeCache(),
  // reaching into private state from other modules.
  static invalidateThemeCaches() {
    UIService._svgCache.clear();
    UIService.clearThemeCache();
  }

  // Record a dark-mode hint and persist it so the correct toolbar icon can
  // be drawn after a restart before any popup opens.
  //  - authoritative=false (background prefers-color-scheme listener): only
  //    seeds _darkModeHint; theme colors still win at the next detection.
  //  - authoritative=true (popup DOM probe via setDarkModeHint message):
  //    also overwrites _isDarkCache and, when the value flipped, drops the
  //    cached badge color so the next toolbar update redraws.
  // Returns whether the value differed from the cached detection.
  static setDarkModeHint(isDark, { authoritative = false } = {}) {
    const changed = UIService._isDarkCache !== isDark;
    UIService._darkModeHint = isDark;
    if (authoritative) {
      UIService._isDarkCache = isDark;
      if (changed) UIService._cachedBadgeColor = null;
    }
    browser.storage.local.set({ "ld-wsp-dark-hint": isDark }).catch(() => {});
    return changed;
  }

  static async _isThemeDark(themeColors) {
    if (UIService._isDarkCache !== null) {
      console.log("[UIService][_isThemeDark] returning cached result:", UIService._isDarkCache);
      return UIService._isDarkCache;
    }
    console.log("[UIService][_isThemeDark] cache miss -- detecting theme...");
    let result;
    // 1. Theme colors are ground truth and come first. Hints rank BELOW color
    // detection on purpose: a stale persisted hint (saved while the previous
    // theme was active) must never override what the current theme's colors
    // say -- the toolbar icon used to stay white after a dark -> light theme
    // switch exactly because the old hint won this race.
    // If the caller supplied theme colors (e.g. from theme.onUpdated callback),
    // use them directly instead of re-querying browser.theme.getCurrent().
    if (themeColors) {
      result = UIService._detectDarkFromColors(themeColors) ?? undefined;
      console.log("[UIService][_isThemeDark] branch=callerColors -> isDark:", result);
    }
    if (result === undefined) {
      try {
        const theme = await browser.theme.getCurrent();
        const colors = theme?.colors ?? null;
        console.log("[UIService][_isThemeDark] queried theme.colors:", JSON.stringify(colors));
        const detected = UIService._detectDarkFromColors(colors);
        if (detected !== null) {
          result = detected;
          console.log("[UIService][_isThemeDark] branch=getCurrent -> isDark:", result);
        }
      } catch (e) {
        console.warn("[UIService][_isThemeDark] browser.theme.getCurrent() threw:", e);
      }
    }
    // 2. Color detection was inconclusive (System/"Automatic" theme returns
    // empty colors). Fall back to the popup-sourced hint: the popup has a real
    // rendering context where -moz-Dialog resolves correctly (the hidden
    // background page does not -- see the probes further down).
    if (result === undefined && UIService._darkModeHint !== null) {
      result = UIService._darkModeHint;
      console.log("[UIService][_isThemeDark] branch=popupHint -> isDark:", result);
    }
    // Persisted hint (set by popup via setDarkModeHint). Survives popup
    // closings and browser restarts, available before the popup is opened.
    if (result === undefined) {
      try {
        const stored = await browser.storage.local.get("ld-wsp-dark-hint");
        const storedHint = stored["ld-wsp-dark-hint"];
        if (storedHint !== undefined && storedHint !== null) {
          console.log("[UIService][_isThemeDark] branch=storedHint -> isDark:", storedHint);
          UIService._darkModeHint = storedHint;
          result = storedHint;
        }
      } catch (e) {
        console.warn("[UIService][_isThemeDark] storage read failed:", e);
      }
    }
    // Before matchMedia (which privacy.resistFingerprinting forces to 'light'),
    // probe the OS dialog background via the -moz-Dialog system color.
    // This reflects actual OS dark/light mode even when resistFingerprinting is on.
    if (result === undefined) {
      try {
        const probe = document.createElement("div");
        document.documentElement.appendChild(probe);
        probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;background:-moz-Dialog";
        const bg = getComputedStyle(probe).backgroundColor;
        document.documentElement.removeChild(probe);
        console.log("[UIService][_isThemeDark] branch=mozDialog  bg:", bg);
        if (bg && bg !== "") {
          const m = bg.match(/\d+/g);
          if (m && m.length >= 3) {
            const [r, g, b] = m.map(Number);
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            result = lum < 128;
            console.log("[UIService][_isThemeDark] branch=mozDialog  lum:", lum.toFixed(1), "-> isDark:", result);
          }
        }
      } catch (e) {
        console.warn("[UIService][_isThemeDark] mozDialog probe failed:", e);
      }
    }

    if (result === undefined) {
      const mq = self.matchMedia?.("(prefers-color-scheme: dark)");
      if (mq) {
        result = mq.matches;
        console.log("[UIService][_isThemeDark] branch=matchMedia  matches:", mq.matches, "-> isDark:", result);
      } else {
        // Cannot determine theme at all -- default to dark (safer: white icon
        // on light toolbar is visible; dark icon on dark toolbar is invisible).
        result = true;
        console.log("[UIService][_isThemeDark] branch=fallback -> isDark: true (safe default)");
      }
    }
    console.log("[UIService][_isThemeDark] final result:", result, "— caching.");
    UIService._isDarkCache = result;
    return result;
  }

  static async _setDefaultIcon(themeColors) {
    // Explicitly pick the correct layered icon for the current theme.
    // path:null should delegate to theme_icons, but Firefox does not always
    // re-evaluate theme_icons after a runtime setIcon() call, so we resolve
    // it ourselves -- same approach used for custom workspace icons.
    try {
      const isDark = await UIService._isThemeDark(themeColors);
      const iconPath = isDark ? "icons/layered-dark.svg" : "icons/layered-light.svg";
      console.log("[UIService][_setDefaultIcon] isDark:", isDark, "-> iconPath:", iconPath);
      await browser.browserAction.setIcon({ path: { 16: iconPath, 32: iconPath, 64: iconPath } });
    } catch (e) {
      console.warn("[UIService][_setDefaultIcon] failed, falling back to path:null:", e);
      await browser.browserAction.setIcon({ path: null });
    }
    console.log("[UIService][_setDefaultIcon] done");
  }

  // Resolve the badge color for the current theme. Memoized via
  // _cachedBadgeColor (invalidated in clearThemeCache on theme.onUpdated),
  // so the hot-path callers (onFocusChanged, onTabCreated/Removed, etc.) do
  // NOT make a browser.theme.getCurrent() IPC round-trip every invocation.
  static async _resolveBadgeColor(themeColors) {
    if (UIService._cachedBadgeColor !== null) return UIService._cachedBadgeColor;
    let colorsForBadge = themeColors;
    if (!colorsForBadge) {
      try {
        const theme = await browser.theme.getCurrent();
        colorsForBadge = theme?.colors ?? null;
      } catch (e) {
        console.warn("[UIService][_resolveBadgeColor] theme.getCurrent() failed:", e);
      }
    }
    UIService._cachedBadgeColor = UIService._pickAccentColor(colorsForBadge) ?? BADGE_FALLBACK_COLOR;
    console.log("[UIService][_resolveBadgeColor] resolved:", UIService._cachedBadgeColor);
    return UIService._cachedBadgeColor;
  }

  static async updateToolbarButton(windowId, themeColors) {
    console.log("[UIService][updateToolbarButton] called for windowId:", windowId);
    // Fast path: this runs on every tab create/remove/focus change; the
    // cache-backed lookup avoids a window-list + batch storage read per event.
    const activeWsp = await WorkspaceService.getActiveWspFast(windowId);
    const badgeColor = await UIService._resolveBadgeColor(themeColors);

    // Warning badge: while a restore-error / session-loss banner is pending,
    // show "!" instead of the tab count so the user notices even without
    // opening the popup. Cleared when the banner is dismissed (handler
    // acknowledge/giveUp re-run this update after clearing the surface).
    if (UIService._warnBadgeCache === null) {
      try {
        UIService._warnBadgeCache = (await WSPStorageManager.getLastRestoreError()) != null;
      } catch (e) {
        // Leave the cache null (= retry on the next update) per the tri-state
        // contract; caching a definitive `false` here would suppress the
        // warning badge until the next writer-side invalidation, which a
        // pending un-dismissed warning has no reason to trigger.
        console.debug("[UIService][updateToolbarButton] warn-badge lookup failed:", e?.message);
      }
    }
    const warnBadge = UIService._warnBadgeCache === true;
    // Snapshot for the stale-write guard: if the warn state changes while the
    // awaits below are in flight, this pass skips its badge writes and leaves
    // the paint to the newer pass that follows every state change.
    const warnGen = UIService._warnGeneration;

    if (activeWsp) {
      console.log("[UIService][updateToolbarButton] activeWsp:", activeWsp.id,
        "name:", activeWsp.name, "icon:", activeWsp.icon || "(none)",
        "tabs:", activeWsp.tabs.length);
      await browser.browserAction.setTitle({ title: activeWsp.name });

      const tabCount = activeWsp.tabs.length;
      const badgeText = warnBadge ? "!" : (tabCount > 0 ? tabCount.toString() : "");
      const badgeBg = warnBadge ? BADGE_WARNING_COLOR : badgeColor;
      if (UIService._warnGeneration === warnGen) {
        await browser.browserAction.setBadgeText({ text: badgeText, windowId });
        // setBadgeBackgroundColor throws on invalid color strings. Even though
        // _pickAccentColor/_isSafeCssColor validate, wrap defensively so a
        // malformed theme or future Firefox API change cannot break the whole
        // toolbar update cascade (which is called from many hot paths).
        try {
          await browser.browserAction.setBadgeBackgroundColor({ color: badgeBg, windowId });
        } catch (e) {
          console.warn("[UIService][updateToolbarButton] setBadgeBackgroundColor rejected", badgeBg, "-- falling back:", e);
          UIService._cachedBadgeColor = BADGE_FALLBACK_COLOR;
          await browser.browserAction.setBadgeBackgroundColor({ color: BADGE_FALLBACK_COLOR, windowId }).catch(() => {});
        }
      } else {
        console.log("[UIService][updateToolbarButton] warn state changed mid-flight -- badge write skipped");
      }

      const validIcon = activeWsp.icon && UIService._VALID_ICONS.has(activeWsp.icon) ? activeWsp.icon : null;
      console.log("[UIService][updateToolbarButton] validIcon:", validIcon,
        "(raw icon value:", JSON.stringify(activeWsp.icon), ", in VALID_ICONS:", UIService._VALID_ICONS.has(activeWsp.icon ?? ""), ")");

      if (!validIcon) {
        console.log("[UIService][updateToolbarButton] no custom icon -> _setDefaultIcon()");
        await UIService._setDefaultIcon(themeColors);
      } else {
        // Custom icon: fetch the SVG, replace currentColor with a concrete
        // theme-appropriate color, and set via data URL.
        // context-fill only works for SVGs loaded by file path, not data URLs,
        // so we resolve the fill color ourselves based on the detected theme.
        console.log("[UIService][updateToolbarButton] custom icon path for:", validIcon);
        try {
          const isDark = await UIService._isThemeDark(themeColors);
          const fillColor = isDark ? "#ffffff" : "#1a1a1a";
          const cacheKey = `${validIcon}:${fillColor}`;
          let dataUrl = UIService._svgCache.get(cacheKey);

          if (!dataUrl) {
            console.log("[UIService][updateToolbarButton] SVG cache miss -- fetching SVG for:", validIcon, "fill:", fillColor);
            const url = browser.runtime.getURL(`popup/img/workspace-icons/${validIcon}.svg`);
            const resp = await fetch(url);
            console.log("[UIService][updateToolbarButton] fetch status:", resp.status, "for", url);
            let svgText = await resp.text();
            svgText = svgText.replace(/fill="currentColor"/g, `fill="${fillColor}"`);
            dataUrl = "data:image/svg+xml," + encodeURIComponent(svgText);
            if (UIService._svgCache.size >= UIService._SVG_CACHE_MAX) {
              UIService._svgCache.delete(UIService._svgCache.keys().next().value);
            }
            UIService._svgCache.set(cacheKey, dataUrl);
            console.log("[UIService][updateToolbarButton] SVG cached, cache size:", UIService._svgCache.size);
          } else {
            console.log("[UIService][updateToolbarButton] SVG cache HIT for:", cacheKey);
          }

          await browser.browserAction.setIcon({ path: { 16: dataUrl, 32: dataUrl, 64: dataUrl } });
          console.log("[UIService][updateToolbarButton] custom icon set OK");
        } catch (e) {
          console.warn("[UIService][updateToolbarButton] data URL failed, using default:", e);
          await UIService._setDefaultIcon(themeColors);
        }
      }
    } else {
      console.log("[UIService][updateToolbarButton] no active workspace for windowId:", windowId, "-> default icon + clear badge");
      await browser.browserAction.setTitle({ title: "Workspaces" });
      // Window-scoped like the active branch: a global write here would paint
      // every window and only another pass through this branch could clear it.
      if (UIService._warnGeneration === warnGen) {
        if (warnBadge) {
          await browser.browserAction.setBadgeText({ text: "!", windowId });
          await browser.browserAction.setBadgeBackgroundColor({ color: BADGE_WARNING_COLOR, windowId }).catch(() => {});
        } else {
          await browser.browserAction.setBadgeText({ text: "", windowId });
        }
      } else {
        console.log("[UIService][updateToolbarButton] warn state changed mid-flight -- badge write skipped");
      }
      await UIService._setDefaultIcon(themeColors);
    }
    console.log("[UIService][updateToolbarButton] done for windowId:", windowId);
  }
}
