// tests/popup-css.test.mjs
// Static checks on popup/css/wsp.css for rules no DOM stub can render:
// forced colors (X-58), focus visibility of hover-only controls (X-25), the
// dialog message's paragraph breaks (X-57), the diagnostics link (X-48) and
// the downward drop line (X-56).
import test from "node:test";
import assert from "node:assert/strict";
import { readPopupCss } from "./helpers/popup-dom.mjs";

const { rules } = readPopupCss();
const FORCED = "(forced-colors: active)";
const SYSTEM_COLOR = /^(Canvas|CanvasText|ButtonFace|ButtonText|ButtonBorder|Field|FieldText|GrayText|Highlight|HighlightText|LinkText|VisitedText|ActiveText|Mark|MarkText|SelectedItem|SelectedItemText|AccentColor|AccentColorText)$/i;

const declsFor = (selector, media) => {
  const out = {};
  for (const r of rules) {
    if (r.media === media && r.selectors.includes(selector)) Object.assign(out, r.decls);
  }
  return out;
};

test("X-58: every mask-painted icon is repainted with a system color in forced colors", () => {
  const masked = rules.filter((r) => r.media === null && "mask-image" in r.decls).flatMap((r) => r.selectors);
  assert.ok(masked.length >= 6, "expected the popup's mask icons");
  // The icon's paint comes from `background`; hover variants override it.
  const painted = new Set(masked);
  for (const r of rules) {
    if (r.media !== null || !("background" in r.decls)) continue;
    for (const s of r.selectors) {
      if (masked.some((m) => s !== m && s.replace(":hover", "") === m)) painted.add(s);
    }
  }
  for (const sel of painted) {
    const d = declsFor(sel, FORCED);
    assert.equal(d["forced-color-adjust"], "none", `${sel} needs forced-color-adjust: none`);
    assert.match(d.background || "", SYSTEM_COLOR, `${sel} needs a system-color background`);
  }
});

test("X-58: color swatches and container dots keep their colors in forced colors", () => {
  for (const sel of [".color-swatch", ".wsp-container-dot"]) {
    assert.equal(declsFor(sel, FORCED)["forced-color-adjust"], "none", sel);
  }
  const selected = declsFor(".color-swatch.selected", FORCED);
  const marks = [selected["border-color"], selected["box-shadow"], selected.outline].filter(Boolean).join(" ");
  assert.match(marks, /\b(Highlight|CanvasText)\b/, "the selected swatch needs a system-color mark");
});

test("X-25: row actions and closed-tab restore buttons show up on keyboard focus", () => {
  const all = rules.filter((r) => r.media === null);
  const visibleOnFocus = (target) => all.some((r) =>
    r.selectors.some((s) => s.includes(target) && /:focus-visible|:focus-within/.test(s)) &&
    /^(1|0\.[5-9]\d*)/.test(r.decls.opacity || ""));
  assert.ok(visibleOnFocus(".edit-btn"), ".edit-btn needs an opacity rule for :focus-visible/:focus-within");
  assert.ok(visibleOnFocus(".wsp-closed-tab-restore"), ".wsp-closed-tab-restore needs one too");
});

test("X-57: dialog messages keep their line breaks", () => {
  assert.equal(declsFor(".custom-dialog-message", null)["white-space"], "pre-line");
});

test("X-48: the Copy diagnostics footer link is displayed", () => {
  // `.footer { display: none }` hides every footer link that no id rule
  // shows again (the same pattern as #createNewWsp / #restoreFromBookmarks).
  assert.equal(declsFor(".footer", null).display, "none");
  const display = declsFor(".footer#wsp-copy-diagnostics", null).display;
  assert.ok(display && display !== "none", `.footer#wsp-copy-diagnostics needs a display, got ${display}`);
});

test("X-56: moving a row down draws the drop line at the bottom of the target", () => {
  const below = declsFor("li.wsp-list-item.drag-over.drag-over-below", null)["box-shadow"] || "";
  assert.match(below, /^inset 0 -2px/);
});
