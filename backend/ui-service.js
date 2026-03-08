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

  static clearThemeCache() {
    console.log("[UIService][clearThemeCache] invalidating _isDarkCache (was:", UIService._isDarkCache,
      ") _darkModeHint (was:", UIService._darkModeHint, ")");
    UIService._isDarkCache = null;
    UIService._darkModeHint = null;
  }

  static async _isThemeDark() {
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
    console.log("[UIService][_isThemeDark] cache miss — querying theme...");
    let result;
    try {
      const theme = await browser.theme.getCurrent();
      const colors = theme?.colors ?? null;
      console.log("[UIService][_isThemeDark] full theme.colors:", JSON.stringify(colors));

      const iconColor    = colors?.icons;
      const toolbarColor = colors?.toolbar;
      const toolbarText  = colors?.toolbar_text ?? colors?.bookmark_text;
      const frameColor   = colors?.frame;
      console.log("[UIService][_isThemeDark] key colors — icons:", iconColor,
        "| toolbar:", toolbarColor, "| toolbar_text:", toolbarText, "| frame:", frameColor);

      if (colors) {
        if (iconColor !== undefined && iconColor !== null) {
          const [r, g, b] = UIService._parseRgb(iconColor);
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          result = lum > 128;
          console.log("[UIService][_isThemeDark] branch=icons  rgb:", r, g, b, " lum:", lum.toFixed(1), "-> isDark:", result);
        } else if (toolbarText !== undefined && toolbarText !== null) {
          const [r, g, b] = UIService._parseRgb(toolbarText);
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          result = lum > 128;
          console.log("[UIService][_isThemeDark] branch=toolbar_text  rgb:", r, g, b, " lum:", lum.toFixed(1), "-> isDark:", result);
        } else if (toolbarColor !== undefined && toolbarColor !== null) {
          const [r, g, b] = UIService._parseRgb(toolbarColor);
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          result = lum < 128;
          console.log("[UIService][_isThemeDark] branch=toolbar  rgb:", r, g, b, " lum:", lum.toFixed(1), "-> isDark:", result);
        } else if (frameColor !== undefined && frameColor !== null) {
          const [r, g, b] = UIService._parseRgb(frameColor);
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          result = lum < 128;
          console.log("[UIService][_isThemeDark] branch=frame  rgb:", r, g, b, " lum:", lum.toFixed(1), "-> isDark:", result);
        } else {
          console.log("[UIService][_isThemeDark] colors object present but all key fields are null/undefined — falling through to matchMedia");
        }
      } else {
        console.log("[UIService][_isThemeDark] theme.colors is null/undefined — falling through to matchMedia");
      }
    } catch (e) {
      console.warn("[UIService][_isThemeDark] browser.theme.getCurrent() threw:", e);
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
      result = mq?.matches ?? false;
      console.log("[UIService][_isThemeDark] branch=matchMedia  matches:", mq?.matches, "-> isDark:", result);
    }
    console.log("[UIService][_isThemeDark] final result:", result, "— caching.");
    UIService._isDarkCache = result;
    return result;
  }

  static async _setDefaultIcon() {
    // Reset to manifest default — Firefox applies theme_icons automatically.
    // setIcon() with a hardcoded path overrides theme_icons and causes the wrong
    // icon (e.g. white on a light toolbar) when _isThemeDark() mis-detects the theme.
    console.log("[UIService][_setDefaultIcon] resetting icon to manifest default (theme_icons)");
    await browser.browserAction.setIcon({ path: null });
    console.log("[UIService][_setDefaultIcon] done");
  }

  static async updateToolbarButton(windowId) {
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
        await UIService._setDefaultIcon();
      } else {
        // Custom icon: generate SVG with correct fill for current theme
        console.log("[UIService][updateToolbarButton] custom icon path — querying isDark...");
        try {
          const isDark = await UIService._isThemeDark();
          const fillColor = isDark ? "#ffffff" : "#1a1a1a";
          const cacheKey = `${validIcon}:${fillColor}`;
          console.log("[UIService][updateToolbarButton] isDark:", isDark, "fillColor:", fillColor, "cacheKey:", cacheKey);
          let dataUrl = UIService._svgCache.get(cacheKey);

          if (!dataUrl) {
            console.log("[UIService][updateToolbarButton] SVG cache miss — fetching SVG for:", validIcon);
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
          console.warn("[UIService][updateToolbarButton] failed to set custom icon, falling back to default:", e);
          await UIService._setDefaultIcon();
        }
      }
    } else {
      console.log("[UIService][updateToolbarButton] no active workspace for windowId:", windowId, "-> default icon + clear badge");
      await browser.browserAction.setTitle({ title: "Workspaces" });
      await browser.browserAction.setBadgeText({ text: "" });
      await UIService._setDefaultIcon();
    }
    console.log("[UIService][updateToolbarButton] done for windowId:", windowId);
  }
}
