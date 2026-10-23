// tests/popup-theme.test.mjs
// Popup theming on the real popup scripts (tests/helpers/popup-dom.mjs):
// theme colors resolved as surface/text pairs of one key family, data-theme
// from the popup background and the OK-button text from the accent (X-26),
// the color validator (X-50), theme-array alpha (X-52) and the -moz-Dialog
// re-detection after an OS scheme flip (X-53).
import test from "node:test";
import assert from "node:assert/strict";
import { loadPopup, readPopupCss, cssSupportsModel } from "./helpers/popup-dom.mjs";

async function openPopup(opts = {}) {
  const popup = loadPopup(opts);
  await popup.settle(20);
  const root = popup.document.documentElement;
  const cssVar = (name) => root.style.getPropertyValue(name);
  const hints = () => popup.sent.filter((m) => m.action === "setDarkModeHint").map((m) => m.isDark);
  const apply = (colors) => popup.get("applyTheme")({ colors });
  return { ...popup, root, cssVar, hints, apply };
}

// ---------------------------------------------------------------- X-50

test("X-50: the color validator takes one color token and nothing else", async () => {
  const { get } = await openPopup();
  const safe = get("_isSafeCssColor");
  for (const bad of [
    "rgb(0 0 0 / 0) url(https://t.example/p.png)",
    "rgb(0,0,0) , url(https://t.example/p.png)",
    "rgb(0 0 0) rgb(255 255 255)",
    "rgb(var(--wsp-bg))",
    "image-set(url(https://t.example/p.png) 1x)",
    "url(https://t.example/p.png)",
  ]) {
    assert.equal(safe(bad), false, bad);
  }
  for (const good of ["#1c1b22", "#fff", "rgb(28, 27, 34)", "rgba(0,0,0,0.5)", "rgb(0 0 0 / 50%)", "white", "hsl(120 50% 50%)"]) {
    assert.equal(safe(good), true, good);
  }
});

test("X-50: a value CSS.supports rejects is rejected", async () => {
  const { get } = await openPopup({
    cssSupports: (prop, value) => value !== "hwb(0 0% 0%)" && cssSupportsModel(prop, value),
  });
  const safe = get("_isSafeCssColor");
  assert.equal(safe("rgb(1 2)"), false, "malformed rgb() that the regex alone lets through");
  assert.equal(safe("hwb(0 0% 0%)"), false);
  assert.equal(safe("hwb(0 0% 50%)"), true);
});

test("X-50: a theme background with url() never reaches the popup's CSS", async () => {
  const p = await openPopup({
    theme: { colors: { popup: "rgb(0 0 0 / 0) url(https://t.example/p.png)", popup_text: "#fff", frame: "#1c1b22", tab_background_text: "#fbfbfe" } },
  });
  for (const name of ["--ff-popup-bg", "--ff-popup-text", "--ff-popup-input-bg"]) {
    assert.doesNotMatch(p.cssVar(name), /url\(/i, name);
  }
  assert.equal(p.cssVar("--ff-popup-bg"), "#1c1b22", "falls back to the next surface");
});

// ---------------------------------------------------------------- X-52

test("X-52: theme-array alpha is 0-1, as Firefox reads it", async () => {
  const p = await openPopup({ theme: { colors: { popup: [30, 30, 30, 0.9], popup_text: [240, 240, 240, 1] } } });
  assert.equal(p.cssVar("--ff-popup-bg"), "rgba(30,30,30,0.9)");
  assert.equal(p.cssVar("--ff-popup-text"), "rgba(240,240,240,1)");
  assert.equal(p.root.dataset.theme, "dark");
  const toCss = p.get("_toCSSColor");
  assert.equal(toCss([30, 30, 30, 0]), "rgba(30,30,30,0)");
  assert.equal(toCss([30, 30, 30, 128]), "rgba(30,30,30,0.502)", "a 0-255 alpha is scaled");
  assert.equal(toCss([30, 30, 30]), "rgb(30,30,30)");
});

// ---------------------------------------------------------------- X-53

test("X-53: an OS scheme flip with the popup open re-detects the new scheme", async () => {
  const p = await openPopup({ prefersDark: false });
  assert.equal(p.root.dataset.theme, "light");
  assert.deepEqual(p.hints(), [false]);

  p.setPrefersDark(true);
  await p.settle(20);
  assert.deepEqual(p.hints(), [false, true], "the forwarded hint follows the OS");
  assert.equal(p.root.dataset.theme, "dark", "and the popup re-themes");

  p.setPrefersDark(false);
  await p.settle(20);
  assert.deepEqual(p.hints(), [false, true, false]);
  assert.equal(p.root.dataset.theme, "light");
});

test("X-53: theme.onUpdated with empty colors re-detects too", async () => {
  const p = await openPopup({ prefersDark: false });
  p.state.prefersDark = true; // flipped, no change event (onUpdated comes instead)
  for (const fn of p.browser.theme.onUpdated._listeners) fn({ theme: { colors: {} } });
  await p.settle(120); // past the 80 ms debounce
  assert.deepEqual(p.hints(), [false, true]);
  assert.equal(p.root.dataset.theme, "dark");
});

// ---------------------------------------------------------------- X-26

test("X-26: a highlight is only used with the text color of its own family", async () => {
  // Scenario (a): toolbar_field_focus has no field text to go with it.
  const p = await openPopup({ theme: { colors: { frame: "#1c1b22", toolbar_text: "#fbfbfe", toolbar_field_focus: "#ffffff" } } });
  assert.equal(p.cssVar("--ff-popup-highlight"), "", "no white highlight under near-white text");
  assert.equal(p.cssVar("--ff-popup-highlight-text"), "");
  assert.equal(p.root.dataset.highlight, undefined);
  assert.equal(p.root.dataset.theme, "dark");

  const cases = [
    [{ popup_highlight: "#0060df", popup_highlight_text: "#ffffff" }, ["#0060df", "#ffffff", "dark"]],
    // Firefox falls back from toolbar_field_text_focus to toolbar_field_text;
    // toolbar_field_highlight_text is the URL bar's selection text, not this.
    [{ toolbar_field_focus: "#ffffff", toolbar_field_text: "#15141a", toolbar_field_highlight_text: "#ff0000" }, ["#ffffff", "#15141a", "light"]],
    [{ tab_selected: "#42414d", tab_text: "#fbfbfe" }, ["#42414d", "#fbfbfe", "dark"]],
    // The selected tab's text falls back to toolbar_text in Firefox.
    [{ tab_selected: "#f0f0f4", toolbar_text: "#15141a" }, ["#f0f0f4", "#15141a", "light"]],
    // An incomplete family is skipped, not paired with another family's text.
    [{ popup_highlight: "#0060df", tab_selected: "#42414d", tab_text: "#fbfbfe" }, ["#42414d", "#fbfbfe", "dark"]],
  ];
  for (const [colors, [surface, text, brightness]] of cases) {
    p.apply(colors);
    const what = JSON.stringify(colors);
    assert.equal(p.cssVar("--ff-popup-highlight"), surface, what);
    assert.equal(p.cssVar("--ff-popup-highlight-text"), text, what);
    assert.equal(p.root.dataset.highlight, brightness, what);
  }

  // A re-apply without a highlight clears the pair and the brightness.
  p.apply({});
  assert.equal(p.cssVar("--ff-popup-highlight"), "");
  assert.equal(p.cssVar("--ff-popup-highlight-text"), "");
  assert.equal(p.root.dataset.highlight, undefined);
});

test("X-26: the popup text comes from the background's family, data-theme from the background", async () => {
  // Scenario (b): dark toolbar, light popup.
  const p = await openPopup({ theme: { colors: { frame: "#0f1126", toolbar_text: "#fff", popup: "#fff", popup_text: "#0c0c0d" } } });
  assert.equal(p.cssVar("--ff-popup-bg"), "#fff");
  assert.equal(p.cssVar("--ff-popup-text"), "#0c0c0d");
  assert.equal(p.root.dataset.theme, "light", "icons are not inverted on a white popup");
  assert.deepEqual(p.hints(), [true], "the toolbar is still dark: the toolbar icon hint is unchanged");

  // No popup_text: the text is left to CanvasText of the popup's scheme,
  // never the toolbar's white.
  p.apply({ popup: "#ffffff", toolbar_text: "#ffffff" });
  assert.equal(p.cssVar("--ff-popup-bg"), "#ffffff");
  assert.equal(p.cssVar("--ff-popup-text"), "");
  assert.equal(p.root.dataset.theme, "light");

  // frame pairs with tab_background_text, not with the toolbar's text.
  p.apply({ frame: "#1c1b22", tab_background_text: "#fbfbfe", toolbar: "#f9f9fb", toolbar_text: "#15141a" });
  assert.equal(p.cssVar("--ff-popup-bg"), "#1c1b22");
  assert.equal(p.cssVar("--ff-popup-text"), "#fbfbfe");
  assert.equal(p.root.dataset.theme, "dark");
});

test("X-26: the text field uses the theme's field colors only as a pair", async () => {
  const p = await openPopup({
    theme: { colors: { frame: "#1c1b22", tab_background_text: "#fbfbfe", toolbar_field: "#ffffff", toolbar_field_text: "#15141a" } },
  });
  assert.equal(p.cssVar("--ff-popup-input-bg"), "#ffffff");
  assert.equal(p.cssVar("--ff-popup-input-text"), "#15141a");
  assert.equal(p.root.dataset.field, "light", "the icon on the field is not inverted");
  assert.equal(p.root.dataset.theme, "dark");

  p.apply({ frame: "#1c1b22", toolbar_text: "#fbfbfe", toolbar_field: "#ffffff" });
  assert.equal(p.cssVar("--ff-popup-input-bg"), "", "no field text: the CSS tint of the popup text is used");
  assert.equal(p.cssVar("--ff-popup-input-text"), "");
  assert.equal(p.root.dataset.field, undefined);
});

test("X-26: the OK button text is picked from the accent's own brightness", async () => {
  // Scenario (c): a yellow accent and no popup_highlight_text.
  const p = await openPopup({ theme: { colors: { tab_loading: "#ffe900" } } });
  assert.equal(p.cssVar("--ff-popup-accent"), "#ffe900");
  assert.equal(p.cssVar("--ff-popup-on-accent"), "black");

  p.apply({ icons_attention: "#0060df", popup_highlight_text: "#000000" });
  assert.equal(p.cssVar("--ff-popup-accent"), "#0060df");
  assert.equal(p.cssVar("--ff-popup-on-accent"), "white");

  // Brightness unknown: the theme accent is left out, so AccentColor keeps
  // its AccentColorText partner.
  p.apply({ tab_loading: "oklch(0.9 0.2 100)" });
  assert.equal(p.cssVar("--ff-popup-accent"), "");
  assert.equal(p.cssVar("--ff-popup-on-accent"), "");
});

test("X-26: the stylesheet paints hover surfaces with the highlight's paired text", () => {
  const { rules } = readPopupCss();
  const top = rules.filter((r) => r.media === null);
  const rootDecls = Object.assign({}, ...top.filter((r) => r.selectors.includes(":root")).map((r) => r.decls));
  assert.equal(rootDecls["--wsp-hover-text"], "var(--ff-popup-highlight-text, var(--wsp-color))");
  assert.equal(rootDecls["--wsp-on-primary"], "var(--ff-popup-on-accent, AccentColorText)");
  assert.doesNotMatch(rootDecls["--wsp-on-primary"], /highlight-text/, "the accent's text is not the highlight's");

  // Every element painted with var(--wsp-hover) re-points its text tokens.
  const repointed = top
    .filter((r) => r.decls["--wsp-color"] === "var(--wsp-hover-text)" && /var\(--wsp-hover-text\)/.test(r.decls["--wsp-text-secondary"] || ""))
    .flatMap((r) => r.selectors);
  const onHover = top.filter((r) => r.decls.background === "var(--wsp-hover)").flatMap((r) => r.selectors);
  assert.ok(onHover.length >= 10, "expected the popup's hover surfaces");
  for (const sel of onHover) {
    assert.ok(repointed.some((s) => s === sel || s.startsWith(`${sel}:not(`)), `${sel} needs --wsp-color: var(--wsp-hover-text)`);
  }

  // Workspace icons on the highlight follow the highlight's brightness.
  const filterFor = (sel) => top.find((r) => r.selectors.includes(sel))?.decls.filter;
  assert.equal(filterFor(':root[data-highlight="dark"] li.wsp-list-item.active img.wsp-icon'), "invert(1)");
  assert.equal(filterFor(':root[data-highlight="light"] li.wsp-list-item.active img.wsp-icon'), "none");
  assert.equal(filterFor(':root[data-field="light"] .icon-picker-btn img'), "none");
});
