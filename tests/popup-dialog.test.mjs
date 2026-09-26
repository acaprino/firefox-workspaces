// tests/popup-dialog.test.mjs
// The real popup/js/dialog.js on the real popup/wsp.html markup
// (tests/helpers/popup-dom.mjs). Key presses follow Gecko's order: the
// dialog's document keydown listener runs BEFORE Enter on a focused button
// becomes a click (X-03).
import test from "node:test";
import assert from "node:assert/strict";
import { loadPopup, assertSame, assertNotSame } from "./helpers/popup-dom.mjs";

function dialogOnly(opts = {}) {
  return loadPopup({ scripts: ["../backend/theme-utils.js", "js/dialog.js"], ...opts });
}

// Resolve state of a promise after the dialog's timers (rAF, animations) ran.
async function outcome(p, ms = 10) {
  let v = "<pending>";
  p.then((x) => { v = x; });
  await new Promise((r) => setTimeout(r, ms));
  return v;
}

const DELETE = { message: 'Delete "Work"?' };
const GIVE_UP = {
  message: "Give up the automatic restore retry?\n\nWhere possible, the saved tab lists " +
    "will first be exported to bookmarks.\n\nIf you have not copied the diagnostic dump yet, do that first.",
};

// ---------------------------------------------------------------- X-03

test("X-03: Enter on the focused Cancel of the Delete confirm cancels", async () => {
  const { get, $, press } = dialogOnly();
  const p = get("showCustomDialog")(DELETE);
  press($("custom-dialog-cancel"), "Enter");
  assert.equal(await outcome(p), false);
});

test("X-03: Enter on Cancel cancels on the animated close path too", async () => {
  const { get, $, press, fire } = dialogOnly({ reducedMotion: false });
  const p = get("showCustomDialog")(GIVE_UP);
  press($("custom-dialog-cancel"), "Enter");
  fire($("custom-dialog-backdrop"), "animationend");
  assert.equal(await outcome(p), false);
});

test("X-03: export dialog with 'close after export' ticked, Enter on Cancel does not confirm", async () => {
  const { get, $, press } = dialogOnly();
  const p = get("showCustomDialog")({
    message: 'Export "Work" to bookmarks?', showCheckbox: true,
    checkboxLabel: "Close workspace after export", checkboxDefault: false,
  });
  press($("custom-dialog-checkbox"), " ");
  assert.equal($("custom-dialog-checkbox").checked, true);
  press($("custom-dialog-checkbox"), "Enter"); // Enter on the checkbox confirms nothing
  assert.equal($("custom-dialog-backdrop").classList.contains("show"), true);
  press($("custom-dialog-cancel"), "Enter");
  assert.equal(await outcome(p), false);
});

test("X-03: Enter on OK confirms exactly once; Enter on a non-interactive target confirms", async () => {
  const { get, $, press, document } = dialogOnly();
  const show = get("showCustomDialog");
  let clicks = 0;
  $("custom-dialog-ok").addEventListener("click", () => clicks++);
  const p = show(DELETE);
  press($("custom-dialog-ok"), "Enter");
  assert.equal(await outcome(p), true);
  assert.equal(clicks, 1);

  const p2 = show(DELETE);
  press(document.body, "Enter");
  assert.equal(await outcome(p2), true);
});

test("X-03: Enter on a colour swatch selects it instead of submitting the old colour", async () => {
  const { get, $, press } = dialogOnly();
  const p = get("showCustomDialog")({
    message: "Create workspace:", withInput: true, defaultValue: "Work",
    showColorPicker: true, defaultColor: null,
  });
  const red = $("color-swatches").children.find((b) => b.dataset.color === "#ff613d");
  press(red, "Enter");
  assert.equal(await outcome(p), "<pending>", "Enter on a swatch must not submit");
  assert.equal(red.getAttribute("aria-checked"), "true");
  press($("custom-dialog-input"), "Enter");
  const r = await outcome(p);
  assert.equal(r.name, "Work");
  assert.equal(r.color, "#ff613d");
});

test("X-03: Enter on the icon button opens the picker instead of submitting", async () => {
  const { get, $, press } = dialogOnly();
  const p = get("showCustomDialog")({ message: "Create workspace:", withInput: true, defaultValue: "Work" });
  press($("custom-dialog-icon-btn"), "Enter");
  assert.equal(await outcome(p), "<pending>");
  assert.equal($("icon-picker").classList.contains("open"), true);
  const rocket = $("icon-grid").children.find((b) => b.dataset.icon === "rocket");
  press(rocket, "Enter");
  assert.equal(await outcome(p), "<pending>");
  press($("custom-dialog-input"), "Enter");
  assert.equal((await outcome(p)).icon, "rocket");
});

test("X-03: auto-repeated Enter neither confirms nor activates the focused Cancel", async () => {
  const { get, $, press, document } = dialogOnly();
  const show = get("showCustomDialog");
  const p = show(DELETE);
  // A held Enter: the repeat lands on whatever has focus now (Cancel).
  press(document.activeElement, "Enter", { repeat: true });
  press(document.body, "Enter", { repeat: true });
  assert.equal(await outcome(p), "<pending>");
  press($("custom-dialog-cancel"), "Escape");
  assert.equal(await outcome(p), false);
});

test("X-03: IME composition keys neither submit nor cancel", async () => {
  const { get, $, press } = dialogOnly();
  const p = get("showCustomDialog")({ message: "Create workspace:", withInput: true, defaultValue: "Wo" });
  const input = $("custom-dialog-input");
  press(input, "Enter", { isComposing: true });
  press(input, "Process", { keyCode: 229 });
  press(input, "Escape", { isComposing: true });
  assert.equal(await outcome(p), "<pending>");
  input.value = "Work";
  press(input, "Enter");
  assert.equal((await outcome(p)).name, "Work");
});

test("X-03: Enter in the name field still submits; Escape still cancels", async () => {
  const { get, $, press } = dialogOnly();
  const show = get("showCustomDialog");
  const p = show({ message: "Rename workspace:", withInput: true, defaultValue: "Home" });
  press($("custom-dialog-input"), "Enter");
  assert.equal((await outcome(p)).name, "Home");
  const p2 = show(DELETE);
  press($("custom-dialog-cancel"), "Escape");
  assert.equal(await outcome(p2), false);
});

test("X-03: a destructive confirm opens with focus on Cancel", async () => {
  const { get, $, document } = dialogOnly();
  get("showCustomDialog")(DELETE);
  assertSame(document.activeElement, $("custom-dialog-cancel"));
});

// ---------------------------------------------------------------- X-57

test("X-57: the dialog has dialog semantics labelled by its message", async () => {
  const { get, $, document } = dialogOnly();
  const dialog = document.querySelector(".custom-dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const labelId = dialog.getAttribute("aria-labelledby");
  assertSame($(labelId), $("custom-dialog-message"));

  const show = get("showCustomDialog");
  show(DELETE);
  assert.equal(dialog.getAttribute("role"), "alertdialog");
  $("custom-dialog-cancel").click();
  await outcome(Promise.resolve());
  show({ message: "Create workspace:", withInput: true, defaultValue: "Work" });
  assert.equal(dialog.getAttribute("role"), "dialog");
});

test("X-57: the name field has an accessible label", () => {
  const { $, document } = dialogOnly();
  const input = $("custom-dialog-input");
  const labelled = (input.getAttribute("aria-label") || "").trim() ||
    document.querySelector('label[for="custom-dialog-input"]')?.textContent.trim();
  assert.ok(labelled, "custom-dialog-input needs aria-label or a <label for>");
});

test("X-57: focus returns to the control that opened the dialog", async () => {
  const { get, $, press, document } = dialogOnly();
  const trigger = document.createElement("button");
  trigger.type = "button";
  $("wsp-list").appendChild(trigger);
  trigger.focus();
  assertSame(document.activeElement, trigger);

  const p = get("showCustomDialog")(DELETE);
  assertNotSame(document.activeElement, trigger, "focus must move into the dialog");
  press(document.activeElement, "Escape");
  await outcome(p);
  assertSame(document.activeElement, trigger);
});

test("X-57: focus returns once the exit animation has run", async () => {
  const { get, $, press, fire, document } = dialogOnly({ reducedMotion: false });
  const trigger = document.createElement("button");
  $("wsp-list").appendChild(trigger);
  trigger.focus();
  const p = get("showCustomDialog")({ message: "Create workspace:", withInput: true, defaultValue: "Work" });
  await outcome(p); // rAF moves focus to the name field
  assertSame(document.activeElement, $("custom-dialog-input"));
  press($("custom-dialog-input"), "Enter");
  assert.equal(await outcome(p), "<pending>", "still animating out");
  fire($("custom-dialog-backdrop"), "animationend");
  assert.equal((await outcome(p)).name, "Work");
  assertSame(document.activeElement, trigger);
});

test("X-57: a notice has no Cancel button and starts on OK", async () => {
  const { get, $, press, document } = dialogOnly();
  const show = get("showCustomDialog");
  const p = show({ message: "Diagnostics copied to clipboard.", infoOnly: true });
  assert.equal($("custom-dialog-cancel").hidden, true);
  assertSame(document.activeElement, $("custom-dialog-ok"));
  press(document.activeElement, "Enter");
  assert.equal(await outcome(p), true);

  show(DELETE);
  assert.equal($("custom-dialog-cancel").hidden, false, "confirms keep Cancel");
});

test("X-57: the collapsed icon picker is out of the Tab order", async () => {
  const { get, $, press, document } = dialogOnly();
  get("showCustomDialog")({ message: 'Export "Work" to bookmarks?', showCheckbox: true, checkboxLabel: "Close" });
  const iconBtn = $("custom-dialog-icon-btn");
  const clear = $("icon-clear-btn");
  clear.focus();
  assertNotSame(document.activeElement, clear, "hidden picker buttons must not take focus");
  press($("custom-dialog-cancel"), "Escape");
  await outcome(Promise.resolve());

  get("showCustomDialog")({ message: "Create workspace:", withInput: true, defaultValue: "Work" });
  assert.equal(iconBtn.getAttribute("aria-expanded"), "false");
  press(iconBtn, "Enter");
  assert.equal(iconBtn.getAttribute("aria-expanded"), "true");
  clear.focus();
  assertSame(document.activeElement, clear, "the open picker is reachable");
  press(clear, "Escape"); // closes the picker, not the dialog
  assert.equal($("icon-picker").classList.contains("open"), false);
  assertSame(document.activeElement, iconBtn);
  assert.equal($("custom-dialog-backdrop").classList.contains("show"), true);
});

test("X-57: a long confirm grows the popup to fit its message and buttons", async () => {
  const { get, $, press, document } = dialogOnly();
  const show = get("showCustomDialog");
  $("custom-dialog-message").offsetHeight = 260;
  document.querySelector(".custom-dialog-footer").offsetHeight = 50;
  const p = show(GIVE_UP);
  assert.equal(document.body.style.minHeight, "310px");
  assert.equal($("custom-dialog-message").textContent.includes("\n\n"), true);
  press($("custom-dialog-cancel"), "Enter");
  await outcome(p);

  $("custom-dialog-message").offsetHeight = 60;
  show(DELETE);
  assert.equal(document.body.style.minHeight, "140px");
});
