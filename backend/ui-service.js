// Toolbar button icon, badge, and SVG handling
class UIService {
  // Cache SVG data URLs keyed by "iconName:fillColor" to avoid repeated fetch+encode
  static _svgCache = new Map();
  static _SVG_CACHE_MAX = 100;
  // Cached isDark result — invalidated by theme.onUpdated via clearThemeCache()
  static _isDarkCache = null;
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

  static _parseRgb(color) {
    if (Array.isArray(color)) return color.slice(0, 3);
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
    if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
    const rgb = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/i.exec(color);
    if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
    console.warn("[UIService][_parseRgb] unrecognized color format:", color, "-> fallback [128,128,128]");
    return [128, 128, 128];
  }

  // Extract dark/light from a theme.colors object without any DOM or async calls.
  // Returns true (dark), false (light), or null (indeterminate).
  static _detectDarkFromColors(colors) {
    if (!colors) return null;
    const iconColor    = colors.icons;
    const toolbarText  = colors.toolbar_text ?? colors.bookmark_text;
    const tabBgText    = colors.tab_background_text;
    const fieldText    = colors.toolbar_field_text;
    const popupText    = colors.popup_text;
    const textColor    = iconColor ?? toolbarText ?? tabBgText ?? fieldText ?? popupText;
    if (textColor !== undefined && textColor !== null) {
      const [r, g, b] = UIService._parseRgb(textColor);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      console.log("[UIService][_detectDarkFromColors] text rgb:", r, g, b, "lum:", lum.toFixed(1));
      return lum > 128;
    }
    const toolbarColor = colors.toolbar;
    if (toolbarColor !== undefined && toolbarColor !== null) {
      const [r, g, b] = UIService._parseRgb(toolbarColor);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      console.log("[UIService][_detectDarkFromColors] toolbar rgb:", r, g, b, "lum:", lum.toFixed(1));
      return lum < 128;
    }
    const frameColor = colors.frame;
    if (frameColor !== undefined && frameColor !== null) {
      const [r, g, b] = UIService._parseRgb(frameColor);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      console.log("[UIService][_detectDarkFromColors] frame rgb:", r, g, b, "lum:", lum.toFixed(1));
      return lum < 128;
    }
    return null;
  }

  static clearThemeCache() {
    console.log("[UIService][clearThemeCache] invalidating _isDarkCache (was:", UIService._isDarkCache,
      ") _darkModeHint (was:", UIService._darkModeHint, ")");
    UIService._isDarkCache = null;
    UIService._darkModeHint = null;
    // Also clear persisted hint so stale value doesn't override fresh theme detection.
    browser.storage.local.remove("ld-wsp-dark-hint").catch(() => {});
  }

  static async _isThemeDark(themeColors) {
    if (UIService._isDarkCache !== null) {
      console.log("[UIService][_isThemeDark] returning cached result:", UIService._isDarkCache);
      return UIService._isDarkCache;
    }
    // Popup-sourced hint takes priority: popup has a real rendering context where
    // -moz-Dialog resolves correctly (background page is hidden, may not).
    if (UIService._darkModeHint !== null) {
      console.log("[UIService][_isThemeDark] branch=popupHint -> isDark:", UIService._darkModeHint);
      UIService._isDarkCache = UIService._darkModeHint;
      return UIService._darkModeHint;
    }
    // Try reading persisted hint from storage (set by popup via setDarkModeHint).
    // This survives popup closings and is available before the popup is opened.
    try {
      const stored = await browser.storage.local.get("ld-wsp-dark-hint");
      const storedHint = stored["ld-wsp-dark-hint"];
      if (storedHint !== undefined && storedHint !== null) {
        console.log("[UIService][_isThemeDark] branch=storedHint -> isDark:", storedHint);
        UIService._darkModeHint = storedHint;
        UIService._isDarkCache = storedHint;
        return storedHint;
      }
    } catch (e) {
      console.warn("[UIService][_isThemeDark] storage read failed:", e);
    }
    console.log("[UIService][_isThemeDark] cache miss -- detecting theme...");
    let result;
    // If the caller supplied theme colors (e.g. from theme.onUpdated callback),
    // use them directly instead of re-querying browser.theme.getCurrent().
    // This avoids races and works even in the background page which has no
    // rendering context for DOM-based probes.
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

  static async updateToolbarButton(windowId, themeColors) {
    console.log("[UIService][updateToolbarButton] called for windowId:", windowId);
    const activeWsp = await WorkspaceService.getActiveWsp(windowId);

    if (activeWsp) {
      console.log("[UIService][updateToolbarButton] activeWsp:", activeWsp.id,
        "name:", activeWsp.name, "icon:", activeWsp.icon || "(none)",
        "tabs:", activeWsp.tabs.length);
      await browser.browserAction.setTitle({ title: activeWsp.name });

      const tabCount = activeWsp.tabs.length;
      await browser.browserAction.setBadgeText({ text: tabCount > 0 ? tabCount.toString() : "", windowId });
      await browser.browserAction.setBadgeBackgroundColor({ color: "#0078D4", windowId });

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
      await browser.browserAction.setBadgeText({ text: "" });
      await UIService._setDefaultIcon(themeColors);
    }
    console.log("[UIService][updateToolbarButton] done for windowId:", windowId);
  }
}
