// tests/popup-keyboard.test.mjs
// The whole popup (wsp.html + every script it loads) driven from the
// keyboard: workspace rows, row actions, search results (X-25), and the
// dialogs they open (X-03, X-57).
import test from "node:test";
import assert from "node:assert/strict";
import { loadPopup, assertSame, assertNotSame } from "./helpers/popup-dom.mjs";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const WORKSPACES = [
  { id: A, name: "Home", icon: "home", color: null, active: true, tabs: [1], windowId: 1, containerId: null },
  { id: B, name: "Work", icon: "", color: "#37adff", active: false, tabs: [2, 3], windowId: 1, containerId: null },
  { id: C, name: "Play", icon: "", color: null, active: false, tabs: [4], windowId: 1, containerId: null },
];

async function openPopup(replies = {}, opts = {}) {
  const popup = loadPopup({ replies: { getWorkspaces: WORKSPACES, ...replies }, ...opts });
  await popup.settle(20);
  const row = (id) => popup.document.querySelector(`li.wsp-list-item[data-wsp-id="${id}"]`);
  const main = (id) => row(id).querySelector(".wsp-row-main");
  const actions = (name) => popup.sent.filter((m) => m.action === name);
  return { ...popup, row, main, actions };
}

// ---------------------------------------------------------------- rows

test("X-25: every workspace row has a focusable, named switch target", async () => {
  const { row, main } = await openPopup();
  for (const id of [A, B, C]) {
    const m = main(id);
    assert.ok(m, "row needs a .wsp-row-main");
    assert.equal(m.getAttribute("role"), "button");
    assert.equal(m.tabIndex, 0);
    assert.match(m.textContent, /tabs/);
  }
  assert.equal(main(A).getAttribute("aria-current"), "true");
  assert.equal(main(B).getAttribute("aria-current"), null);
  assert.equal(row(A).querySelector("img.wsp-icon").alt, "", "the row icon is decorative");
});

test("X-25: Enter and Space on a row switch to that workspace", async () => {
  for (const key of ["Enter", " "]) {
    const { main, press, actions, state, row, settle } = await openPopup();
    main(B).focus();
    press(main(B), key);
    assert.deepEqual(actions("activateWorkspace").map((m) => m.wspId), [B], `key ${JSON.stringify(key)}`);
    await settle(); // the popup closes on the reply (X-47)
    assert.equal(state.closed, true);
    assert.equal(row(B).classList.contains("active"), true);
    assert.equal(main(B).getAttribute("aria-current"), "true");
    assert.equal(main(A).getAttribute("aria-current"), null);
  }
});

test("X-25: Enter on the already active row is a no-op", async () => {
  const { main, press, actions, state } = await openPopup();
  press(main(A), "Enter");
  assert.equal(actions("activateWorkspace").length, 0);
  assert.equal(state.closed, false);
});

test("X-25: Up and Down move between rows; Up from the first row reaches the search box", async () => {
  const { main, press, document, $ } = await openPopup();
  main(A).focus();
  press(main(A), "ArrowDown");
  assertSame(document.activeElement, main(B));
  press(main(B), "ArrowDown");
  assertSame(document.activeElement, main(C));
  press(main(C), "ArrowDown");
  assertSame(document.activeElement, main(C));
  press(main(C), "ArrowUp");
  press(main(B), "ArrowUp");
  assertSame(document.activeElement, main(A));
  press(main(A), "ArrowUp");
  assertSame(document.activeElement, $("wsp-search-input"));
  press($("wsp-search-input"), "ArrowDown");
  assertSame(document.activeElement, main(A));
});

test("X-25: Alt+Down / Alt+Up reorder rows, save the order and keep focus", async () => {
  const { main, press, document, actions, settle } = await openPopup();
  const order = () => document.querySelectorAll("li.wsp-list-item").map((li) => li.dataset.wspId);
  main(A).focus();
  press(main(A), "ArrowDown", { altKey: true });
  await settle();
  assert.deepEqual(order(), [B, A, C]);
  assert.deepEqual(actions("saveWorkspaceOrder").at(-1).orderedIds, [B, A, C]);
  assertSame(document.activeElement, main(A), "the moved row keeps focus");
  press(main(A), "ArrowDown", { altKey: true });
  press(main(A), "ArrowDown", { altKey: true }); // already last: no-op
  await settle();
  assert.deepEqual(order(), [B, C, A]);
  press(main(A), "ArrowUp", { altKey: true });
  await settle();
  assert.deepEqual(order(), [B, A, C]);
  assert.deepEqual(actions("saveWorkspaceOrder").at(-1).orderedIds, [B, A, C]);
  assert.equal(actions("saveWorkspaceOrder").length, 3);
  assertSame(document.activeElement, main(A));
});

test("X-25: drag and drop still reorders and saves (shared save path)", async () => {
  const { row, fire, document, actions, settle } = await openPopup();
  const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
  fire(row(A), "dragstart", { dataTransfer });
  fire(row(C), "dragover", { dataTransfer });
  fire(row(C), "drop", { dataTransfer });
  fire(row(A), "dragend", { dataTransfer });
  await settle();
  const order = document.querySelectorAll("li.wsp-list-item").map((li) => li.dataset.wspId);
  assert.deepEqual(order, [B, C, A]);
  assert.deepEqual(actions("saveWorkspaceOrder").map((m) => m.orderedIds), [[B, C, A]]);
});

// ---------------------------------------------------------------- row actions

test("X-25: row actions are named after their workspace and in visual order", async () => {
  const { row } = await openPopup();
  const btns = row(B).querySelectorAll(".edit-btn");
  assert.deepEqual(btns.map((b) => [...b.classList].find((c) => c !== "edit-btn")),
    ["export-btn", "rename-btn", "delete-btn"]);
  for (const b of btns) assert.match(b.getAttribute("aria-label") || "", /"Work"/);
  assert.match(row(B).querySelector(".delete-btn").getAttribute("aria-label"), /^Delete/);
});

test("X-25: renaming updates the action labels and keeps the icon before the name", async () => {
  const { row, main, press, $, document, settle, actions } = await openPopup();
  const renameBtn = row(A).querySelector(".rename-btn");
  renameBtn.focus();
  press(renameBtn, "Enter");
  await settle();
  assertSame(document.activeElement, $("custom-dialog-input"));
  $("custom-dialog-input").value = "Office";
  press($("custom-dialog-input"), "Enter");
  await settle(20);
  assert.equal(actions("renameWorkspace")[0].wspName, "Office");
  assert.match(row(A).querySelector(".delete-btn").getAttribute("aria-label"), /"Office"/);
  const kids = main(A).children.map((c) => c.className);
  assert.deepEqual(kids, ["wsp-container-dot", "wsp-icon", "wsp-name", "tabs-qty"]);
  assertSame(document.activeElement, renameBtn, "focus is back on the rename button");
});

test("X-03/X-25/X-57: Delete from the keyboard - Enter, then Enter on the focused Cancel, deletes nothing", async () => {
  const { row, press, $, document, settle, actions } = await openPopup();
  const del = row(B).querySelector(".delete-btn");
  del.focus();
  press(del, "Enter");
  assert.equal($("custom-dialog-backdrop").classList.contains("show"), true);
  assertSame(document.activeElement, $("custom-dialog-cancel"));
  press(document.activeElement, "Enter");
  await settle(20);
  assert.equal(actions("destroyWsp").length, 0, "Cancel must not delete");
  assert.ok(row(B), "row still there");
  assertSame(document.activeElement, del, "focus is back on the delete button");
});

test("X-03: holding Enter on the delete button does not confirm the delete", async () => {
  const { row, press, $, document, settle, actions } = await openPopup();
  const del = row(B).querySelector(".delete-btn");
  del.focus();
  press(del, "Enter", { repeat: true }); // first keydown of the hold opens the dialog
  for (let i = 0; i < 5; i++) press(document.activeElement, "Enter", { repeat: true });
  await settle(20);
  assert.equal(actions("destroyWsp").length, 0);
  assert.equal($("custom-dialog-backdrop").classList.contains("show"), true, "dialog still open");
});

test("X-25: confirming a keyboard delete moves focus to the neighbouring row", async () => {
  const { row, main, press, $, document, settle, actions } = await openPopup({
    destroyWsp: { activatedWspId: null },
  });
  const del = row(B).querySelector(".delete-btn");
  del.focus();
  press(del, "Enter");
  $("custom-dialog-ok").focus();
  press($("custom-dialog-ok"), "Enter");
  await settle(20);
  assert.deepEqual(actions("destroyWsp").map((m) => m.wspId), [B]);
  assert.ok(row(B) === null, "row B removed");
  assertSame(document.activeElement, main(C));
});

test("X-25: closed-tab restore buttons are named after the tab", async () => {
  const { document } = await openPopup({
    getClosedTabs: [{ url: "https://example.test/", title: "Example", closedAt: 5 }],
  });
  const btn = document.querySelector(".wsp-closed-tab-restore");
  assert.equal(btn.getAttribute("aria-label"), 'Restore "Example"');
});

// ---------------------------------------------------------------- search

const HITS = [
  { wspId: B, wspName: "Work", tabId: 3, title: "Issue tracker" },
  { wspId: C, wspName: "Play", tabId: 4, title: "Issue of the week" },
];

test("X-25: search results are focusable buttons reachable with Down, opened with Enter", async () => {
  const { $, press, type, document, settle, actions, state } = await openPopup({ searchTabs: HITS });
  const input = $("wsp-search-input");
  input.focus();
  type(input, "issue");
  await settle(200);
  const items = document.querySelectorAll(".wsp-search-result");
  assert.equal(items.length, 2);
  for (const it of items) {
    assert.equal(it.getAttribute("role"), "button");
    assert.equal(it.tabIndex, 0);
  }
  press(input, "ArrowDown");
  assertSame(document.activeElement, items[0]);
  press(items[0], "ArrowDown");
  assertSame(document.activeElement, items[1]);
  press(items[1], "Enter");
  assert.deepEqual(actions("activateWorkspace").map((m) => [m.wspId, m.tabId]), [[C, 4]]);
  await settle(); // the popup closes on the reply (X-47)
  assert.equal(state.closed, true);
});

test("X-25: Enter in the search box opens the first hit, even before the debounce fired", async () => {
  const { $, press, type, settle, actions, state } = await openPopup({ searchTabs: HITS });
  const input = $("wsp-search-input");
  input.focus();
  type(input, "issue");
  press(input, "Enter");
  await settle(20);
  assert.deepEqual(actions("searchTabs").map((m) => m.query), ["issue"]);
  assert.deepEqual(actions("activateWorkspace").map((m) => [m.wspId, m.tabId]), [[B, 3]]);
  assert.equal(state.closed, true);
  await settle(200);
  assert.equal(actions("searchTabs").length, 1, "the flushed search does not run twice");
});

test("X-25: a slow reply for an older query does not replace newer results", async () => {
  const { $, type, document, settle } = await openPopup({
    searchTabs: async ({ query }) => {
      if (query === "is") await new Promise((r) => setTimeout(r, 300));
      return query === "is" ? [HITS[1]] : [HITS[0]];
    },
  });
  const input = $("wsp-search-input");
  type(input, "is");
  await settle(170); // "is" request in flight
  type(input, "issue");
  await settle(500);
  const titles = document.querySelectorAll(".wsp-search-result-title").map((e) => e.textContent);
  assert.deepEqual(titles, ["Issue tracker"]);
});

// ---------------------------------------------------------------- dialogs from the popup

test("X-57: notices from the popup show a lone OK button", async () => {
  const { $, press, settle, document } = await openPopup({ getBookmarkWorkspaces: [] });
  const link = $("restoreFromBookmarks");
  link.focus();
  press(link, "Enter");
  await settle(20);
  assert.equal($("custom-dialog-message").textContent, "No saved workspaces found in bookmarks.");
  assert.equal($("custom-dialog-cancel").hidden, true);
  assertSame(document.activeElement, $("custom-dialog-ok"));
});

test("X-57/X-03: the Give up confirm keeps its paragraphs and Enter on Cancel keeps the retry", async () => {
  const { $, press, settle, document, actions } = await openPopup({
    getLastRestoreError: { reason: "refuse-to-wipe", when: 1700000000000, wspCount: 2, snapshotUrlCount: 5 },
  });
  assert.equal($("wsp-error-banner").hidden, false);
  const giveUp = $("wsp-error-give-up");
  giveUp.focus();
  press(giveUp, "Enter");
  await settle();
  const msg = $("custom-dialog-message").textContent;
  assert.equal(msg.split("\n\n").length, 3, "three paragraphs");
  assert.equal(document.querySelector(".custom-dialog").getAttribute("role"), "alertdialog");
  assertSame(document.activeElement, $("custom-dialog-cancel"));
  press(document.activeElement, "Enter");
  await settle(20);
  assert.equal(actions("giveUpRestoreRetry").length, 0);
  assert.equal($("wsp-error-banner").hidden, false);
  assertSame(document.activeElement, giveUp);
});
