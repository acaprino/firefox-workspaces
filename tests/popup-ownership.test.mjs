// Concurrent popup actions against the real markup and scripts. Browser
// messages are deferred at the API boundary to expose ownership races.
import test from "node:test";
import assert from "node:assert/strict";
import { loadPopup, assertSame } from "./helpers/popup-dom.mjs";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WORKSPACES = [
  { id: A, name: "Home", active: true, tabs: [1], windowId: 1 },
  { id: B, name: "Work", active: false, tabs: [2], windowId: 1 },
  { id: C, name: "Play", active: false, tabs: [3], windowId: 1 },
];
const CLOSED = [{ url: "https://closed.example/", title: "Closed", closedAt: 100 }];
const INTERNAL = { _error: true, message: "An internal error occurred" };

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function openPopup(replies = {}, options = {}) {
  const p = loadPopup({ ...options, replies: { getWorkspaces: WORKSPACES, ...replies } });
  await p.settle(20);
  return {
    ...p,
    row: id => p.document.querySelector(`li.wsp-list-item[data-wsp-id="${id}"]`),
    actions: name => p.sent.filter(m => m.action === name),
    order: () => p.document.querySelectorAll("li.wsp-list-item").map(li => li.dataset.wspId),
    dialogText: () => p.$("custom-dialog-message").textContent,
  };
}

for (const reducedMotion of [true, false]) {
  test(`a late information notice cannot replace or confirm Delete (reduced motion: ${reducedMotion})`, async () => {
    const p = await openPopup({}, { reducedMotion });
    const deleteButton = p.row(B).querySelector(".delete-btn");
    deleteButton.focus();
    deleteButton.click();
    p.get("showCustomDialog")({ message: "No saved tabs found.", infoOnly: true });
    await p.settle();

    assert.match(p.dialogText(), /Delete.*Work/, "the visible confirmation keeps ownership of OK");
    assert.equal(p.$("custom-dialog-cancel").hidden, false);
    p.press(p.$("custom-dialog-cancel"), "Enter");
    if (!reducedMotion) {
      await p.settle();
      assert.match(p.dialogText(), /Delete.*Work/, "the next dialog waits for the close animation");
      p.fire(p.$("custom-dialog-backdrop"), "animationend");
    }
    await p.settle();
    assert.match(p.dialogText(), /No saved tabs/);
    assert.equal(p.$("custom-dialog-cancel").hidden, true);
    p.press(p.$("custom-dialog-ok"), "Enter");
    if (!reducedMotion) p.fire(p.$("custom-dialog-backdrop"), "animationend");
    await p.settle();

    assert.equal(p.actions("destroyWsp").length, 0, "notice acknowledgement does not delete anything");
    assertSame(p.document.activeElement, deleteButton, "focus returns to the visible dialog's opener");
    assert.equal(p.$("custom-dialog-backdrop").classList.contains("show"), false);
  });
}

test("closed-tab restore ignores repeated keyboard and pointer activation until the list refreshes", async () => {
  const restored = deferred();
  const refreshed = deferred();
  let reads = 0;
  const p = await openPopup({
    getClosedTabs: () => ++reads === 1 ? CLOSED : refreshed.promise,
    restoreClosedTab: () => restored.promise,
  });
  const button = p.document.querySelector(".wsp-closed-tab-restore");
  button.focus();
  p.press(button, "Enter");
  p.press(button, "Enter", { repeat: true });
  p.press(button, " ");
  button.click();
  assert.equal(p.actions("restoreClosedTab").length, 1);
  restored.resolve(CLOSED[0]);
  await p.settle();
  p.press(button, "Enter");
  assert.equal(p.actions("restoreClosedTab").length, 1, "the old row stays guarded while its refresh is pending");
  refreshed.resolve([]);
  await p.settle();
  assert.equal(p.$("wsp-closed-tabs").hidden, true);
});

test("a failed closed-tab restore can be retried after the notice and refresh", async () => {
  const restored = deferred();
  let calls = 0;
  let closed = CLOSED;
  const p = await openPopup({
    getClosedTabs: () => closed,
    restoreClosedTab: () => ++calls === 1 ? restored.promise : (closed = [], CLOSED[0]),
  });
  const button = p.document.querySelector(".wsp-closed-tab-restore");
  p.press(button, "Enter");
  p.press(button, "Enter");
  assert.equal(p.actions("restoreClosedTab").length, 1);
  restored.resolve(INTERNAL);
  await p.settle();
  assert.match(p.dialogText(), /Could not restore the tab/);
  p.$("custom-dialog-ok").click();
  await p.settle();
  p.press(p.document.querySelector(".wsp-closed-tab-restore"), "Enter");
  await p.settle();
  assert.equal(p.actions("restoreClosedTab").length, 2);
  assert.equal(p.$("wsp-closed-tabs").hidden, true);
});

for (const firstSucceeds of [false, true]) {
  test(`rapid keyboard reorders use the last settled order (first save succeeds: ${firstSucceeds})`, async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const p = await openPopup({ saveWorkspaceOrder: () => ++calls === 1 ? first.promise : second.promise });
    const main = p.row(A).querySelector(".wsp-row-main");
    main.focus();
    p.press(main, "ArrowDown", { altKey: true });
    p.press(main, "ArrowDown", { altKey: true });
    await p.settle();
    assert.equal(p.actions("saveWorkspaceOrder").length, 1, "the second move waits for the first result");
    first.resolve(firstSucceeds ? { success: true } : INTERNAL);
    await p.settle();
    const expected = firstSucceeds ? [B, C, A] : [B, A, C];
    assert.deepEqual(p.actions("saveWorkspaceOrder")[1].orderedIds, expected);
    second.resolve({ success: true });
    await p.settle();
    assert.deepEqual(p.order(), expected);
    assertSame(p.document.activeElement, main, "keyboard focus survives both moves and any rollback");
  });
}

test("a queued drag uses its captured rows after dragend and an earlier failed keyboard save", async () => {
  const first = deferred();
  let calls = 0;
  const p = await openPopup({ saveWorkspaceOrder: () => ++calls === 1 ? first.promise : { success: true } });
  p.press(p.row(A).querySelector(".wsp-row-main"), "ArrowDown", { altKey: true });
  await p.settle();
  const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
  p.fire(p.row(C), "dragstart", { dataTransfer });
  p.fire(p.row(B), "drop", { dataTransfer });
  p.fire(p.row(C), "dragend", { dataTransfer });
  assert.equal(p.actions("saveWorkspaceOrder").length, 1);
  first.resolve(INTERNAL);
  await p.settle(20);
  assert.deepEqual(p.actions("saveWorkspaceOrder")[1].orderedIds, [A, C, B]);
  assert.deepEqual(p.order(), [A, C, B]);
});
