/* ============================================================
   Firefox Workspaces — Shared Theme Utilities
   Loaded by BOTH the background page (via manifest background.scripts,
   before ui-service.js) AND the popup document (via <script src> in
   popup/wsp.html, before popup/js/wsp.js). Must be a pure script: no
   DOM access, no browser.* calls — so it runs unchanged in either
   execution context.
   ============================================================ */

// Priority chain of theme.colors keys used to derive an "accent" color.
// Consumed by:
//   - backend/ui-service.js UIService._pickAccentColor (toolbar badge)
//   - popup/js/wsp.js _FF_POPUP_PROPS['--ff-popup-accent'] (popup accent)
// Keeping a single canonical list prevents the badge and popup accent
// from disagreeing when a theme defines some keys but not others.
const THEME_ACCENT_KEYS = Object.freeze([
  "accentcolor",
  "toolbar_field_focus_border",
  "icons_attention",
  "tab_loading",
  "popup_highlight",
]);

// Parse an RGB triplet out of a theme.colors value. Accepts [R,G,B(,A)]
// arrays, #RRGGBB hex, and rgb()/rgba() strings. Returns [r,g,b] or null.
// Pure — no validation, caller is responsible for sanitizing strings.
function _themeParseRgb(c) {
  if (Array.isArray(c)) {
    const [r, g, b] = c;
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r | 0, g | 0, b | 0];
    }
    return null;
  }
  if (typeof c !== "string") return null;
  const s = c.trim();
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(s);
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  return null;
}

// Compute relative luminance (Rec.601 weights). Returns null on parse fail.
function _themeLuminance(rgb) {
  if (!rgb) return null;
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

// Detect whether a theme.colors object describes a dark theme.
// Walks a priority chain:
//   1. "Text-ish" color: if light (lum > 128), theme is dark.
//   2. "Background-ish" color: if dark (lum < 128), theme is dark.
//   3. Return null to signal "indeterminate" so the caller can fall back
//      (e.g. the popup's -moz-Dialog DOM probe, or OS prefers-color-scheme).
// Pure function, no DOM / no awaits. Callable from background and popup.
function detectDarkFromThemeColors(colors) {
  if (!colors || typeof colors !== "object") return null;

  const textSrc = colors.icons
               ?? colors.toolbar_text
               ?? colors.bookmark_text
               ?? colors.tab_background_text
               ?? colors.toolbar_field_text
               ?? colors.popup_text;
  const textLum = _themeLuminance(_themeParseRgb(textSrc));
  if (textLum !== null) return textLum > 128;

  const bgSrc = colors.toolbar ?? colors.frame ?? colors.popup;
  const bgLum = _themeLuminance(_themeParseRgb(bgSrc));
  if (bgLum !== null) return bgLum < 128;

  return null;
}

// Pick the theme's accent color by walking THEME_ACCENT_KEYS. Returns a
// CSS color string ready for setBadgeBackgroundColor / style.setProperty,
// or null if no candidate is available. String values are NOT validated
// here — callers that pass them to sensitive APIs should add their own
// safety check (e.g. ui-service._isSafeCssColor).
function pickAccentFromThemeColors(colors) {
  if (!colors) return null;
  for (const key of THEME_ACCENT_KEYS) {
    const c = colors[key];
    if (c === undefined || c === null) continue;
    if (Array.isArray(c) && c.length >= 3) {
      const [r, g, b] = c;
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return `rgb(${r | 0},${g | 0},${b | 0})`;
      }
    }
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}
