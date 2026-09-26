// tests/popup-state.test.mjs
// Popup state, errors and the restore banner, on the real popup scripts
// (tests/helpers/popup-dom.mjs): the banner's compare-and-clear and its
// storage listener (X-24, X-55), failures that must not look like success
// (X-46), activation refusals and the restricted view (X-47), stale search
// and tooltip replies (X-54), drag and drop (X-56), the popup's workspace
// model (X-74), name limits (X-121) and the diagnostic dump (X-48, X-49).
import test from "node:test";
import assert from "node:assert/strict";
import { loadPopup } from "./helpers/popup-dom.mjs";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const N = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const WORKSPACES = [
  { id: A, name: "Home", icon: "", color: null, active: true, tabs: [1], windowId: 1, containerId: null },
  { id: B, name: "Work", icon: "", color: null, active: false, tabs: [2, 3], windowId: 1, containerId: null },
  { id: C, name: "Play", icon: "", color: null, active: false, tabs: [4], windowId: 1, containerId: null },
];

const LAST_ERROR_KEY = "ld-wsp-last-restore-error";
const INTERNAL = { _error: true, message: "An internal error occurred" };
const STARTING = {
  _error: true, _userFacing: true, retriable: true,
  message: "Workspaces is still starting up (restoring the previous session). Please try again in a moment.",
};
const PHASE4 = { reason: "phase4-failure", when: 1000, wspCount: 2, snapshotUrlCount: 5 };
const LOSS = { reason: "session-not-restored", when: 2000, wspCount: 2, snapshotUrlCount: 5, exportedWorkspaces: 2 };

async function openPopup(replies = {}) {
  const popup = loadPopup({ replies: { getWorkspaces: WORKSPACES, ...replies } });
  await popup.settle(20);
  const row = (id) => popup.document.querySelector(`li.wsp-list-item[data-wsp-id="${id}"]`);
  const actions = (name) => popup.sent.filter((m) => m.action === name);
  const dialogOpen = () => popup.$("custom-dialog-backdrop").classList.contains("show");
  const dialogText = () => popup.$("custom-dialog-message").textContent;
  const order = () => popup.document.querySelectorAll("li.wsp-list-item").map((li) => li.dataset.wspId);
  return { ...popup, row, actions, dialogOpen, dialogText, order };
}

// A reply the test resolves by hand.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ---------------------------------------------------------------- X-24

test("X-24: Give up sends the when of the banner the user saw", async () => {
  const p = await openPopup({ getLastRestoreError: PHASE4, giveUpRestoreRetry: { success: true, exportedWorkspaces: 0 } });
  p.$("wsp-error-give-up").click();
  await p.settle();
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  assert.deepEqual(p.actions("giveUpRestoreRetry").map((m) => m.when), [1000]);
});

test("X-24: a warning that replaced the banner during the Give up confirm is not given up", async () => {
  const p = await openPopup({ getLastRestoreError: PHASE4 });
  p.$("wsp-error-give-up").click();
  await p.settle();
  assert.equal(p.dialogOpen(), true);
  // The restore commits and raises session-not-restored while the confirm is open.
  p.storageChange({ [LAST_ERROR_KEY]: LOSS });
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  assert.equal(p.actions("giveUpRestoreRetry").length, 0, "nothing is sent for a banner the user never saw");
  assert.match(p.dialogText(), /nothing was given up/);
  p.$("custom-dialog-ok").click();
  await p.settle();
  assert.equal(p.$("wsp-error-banner").hidden, false);
  assert.match(p.$("wsp-error-banner-text").textContent, /not fully restored/);
});

test("X-24: a warning cleared during the Give up confirm is not given up either", async () => {
  const p = await openPopup({ getLastRestoreError: PHASE4 });
  p.$("wsp-error-give-up").click();
  await p.settle();
  p.storageChange({ [LAST_ERROR_KEY]: undefined });
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  assert.equal(p.actions("giveUpRestoreRetry").length, 0);
});

// ---------------------------------------------------------------- X-55

test("X-55: a warning written while the banner's first read is in flight is shown", async () => {
  const read = deferred();
  const p = await openPopup({ getLastRestoreError: () => read.promise });
  assert.equal(p.actions("getLastRestoreError").length, 1, "first read in flight");
  p.storageChange({ [LAST_ERROR_KEY]: LOSS });
  read.resolve(PHASE4); // the older value, read before the write
  await p.settle();
  assert.equal(p.$("wsp-error-banner").hidden, false);
  assert.match(p.$("wsp-error-banner-text").textContent, /not fully restored/,
    "the newer warning wins over the older read");
});

test("X-55: the banner's first read starts in parallel with the workspace list", async () => {
  const primary = deferred();
  const p = loadPopup({ replies: { getWorkspaces: WORKSPACES, getPrimaryWindowId: () => primary.promise } });
  await p.settle();
  assert.equal(p.sent.filter((m) => m.action === "getLastRestoreError").length, 1);
  primary.resolve(1);
  await p.settle();
});

// ---------------------------------------------------------------- X-46

test("X-46: a failed Dismiss keeps the banner (the payload and the badge are still there)", async () => {
  for (const failure of [INTERNAL, () => { throw new Error("Could not establish connection"); }]) {
    const p = await openPopup({ getLastRestoreError: PHASE4, acknowledgeLastRestoreError: failure });
    p.$("wsp-error-acknowledge").click();
    await p.settle();
    assert.equal(p.$("wsp-error-banner").hidden, false);
  }
});

test("X-46: a successful Dismiss hides the banner", async () => {
  const p = await openPopup({ getLastRestoreError: PHASE4, acknowledgeLastRestoreError: { success: true } });
  p.$("wsp-error-acknowledge").click();
  await p.settle();
  assert.equal(p.$("wsp-error-banner").hidden, true);
  assert.deepEqual(p.actions("acknowledgeLastRestoreError").map((m) => m.when), [1000]);
});

test("X-46: a failed Give up keeps the banner and says so", async () => {
  const p = await openPopup({ getLastRestoreError: PHASE4, giveUpRestoreRetry: INTERNAL });
  p.$("wsp-error-give-up").click();
  await p.settle();
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  assert.equal(p.actions("giveUpRestoreRetry").length, 1);
  assert.match(p.dialogText(), /Could not give up/);
  p.$("custom-dialog-ok").click();
  await p.settle();
  assert.equal(p.$("wsp-error-banner").hidden, false);
});

test("X-46: a failed diagnostics read copies nothing", async () => {
  const p = await openPopup({ getDiagnostics: INTERNAL });
  p.$("wsp-copy-diagnostics").click();
  await p.settle();
  if (p.dialogOpen()) p.$("custom-dialog-ok").click(); // the X-49 confirm
  await p.settle(20);
  assert.equal(p.state.clipboard, null, "no 'null' dump on the clipboard");
  assert.match(p.dialogText(), /Could not read the diagnostic data/);
});

test("X-46: a refused rename keeps the old name", async () => {
  const p = await openPopup({ renameWorkspace: INTERNAL });
  p.row(B).querySelector(".rename-btn").click();
  await p.settle();
  p.$("custom-dialog-input").value = "Office";
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  assert.equal(p.actions("renameWorkspace").length, 1);
  assert.equal(p.row(B).querySelector(".wsp-name").textContent, "Work");
  assert.equal(p.row(B).querySelector(".wsp-name").title, "Work");
  assert.match(p.dialogText(), /Could not save the workspace changes/);
});

test("X-46: a refused container change does not repaint the container dot", async () => {
  const p = await openPopup({
    getContainers: [{ cookieStoreId: "firefox-container-1", name: "Shopping", colorCode: "#ff9f00" }],
    setWorkspaceContainer: { _error: true, _userFacing: true, message: "Workspace not found: it was deleted." },
  });
  p.row(B).querySelector(".rename-btn").click();
  await p.settle();
  p.$("custom-dialog-container-select").value = "firefox-container-1";
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  assert.equal(p.actions("setWorkspaceContainer").length, 1);
  const dot = p.row(B).querySelector(".wsp-container-dot");
  assert.equal(dot.style.visibility, "hidden");
  assert.equal(dot.title, "");
  assert.equal(p.dialogText(), "Workspace not found: it was deleted.", "the refusal, shown once");
});

test("X-46: a failed Clear keeps the Recently Closed list", async () => {
  const p = await openPopup({
    getClosedTabs: [{ url: "https://example.test/", title: "Example", closedAt: 5 }],
    clearClosedTabs: INTERNAL,
  });
  assert.equal(p.$("wsp-closed-tabs").hidden, false);
  p.$("wsp-closed-tabs-clear").click();
  await p.settle();
  assert.equal(p.$("wsp-closed-tabs").hidden, false);
  assert.match(p.dialogText(), /Could not clear/);
});

test("X-46: a failed bookmarks read is not reported as 'no saved workspaces'", async () => {
  const p = await openPopup({ getBookmarkWorkspaces: INTERNAL });
  p.$("restoreFromBookmarks").click();
  await p.settle();
  assert.doesNotMatch(p.dialogText(), /No saved workspaces/);
  assert.match(p.dialogText(), /Could not read/);
});

// ---------------------------------------------------------------- X-47

test("X-47: a switch refused while starting up keeps the popup open and says why", async () => {
  const p = await openPopup({ activateWorkspace: STARTING });
  p.row(B).querySelector(".wsp-row-main").click();
  await p.settle();
  assert.equal(p.state.closed, false);
  assert.equal(p.dialogText(), STARTING.message);
  p.$("custom-dialog-ok").click();
  await p.settle();
  assert.equal(p.row(A).classList.contains("active"), true, "the optimistic mark is undone");
  assert.equal(p.row(B).classList.contains("active"), false);
  // Recently Closed still belongs to A: a later render asks for A's list.
  p.type(p.$("wsp-search-input"), "x");
  await p.settle(170);
  p.type(p.$("wsp-search-input"), "");
  await p.settle(170);
  assert.equal(p.actions("getClosedTabs").at(-1).wspId, A);
});

test("X-47: a refused switch from a search hit keeps the popup open too", async () => {
  const p = await openPopup({
    activateWorkspace: STARTING,
    searchTabs: [{ wspId: B, wspName: "Work", tabId: 3, title: "Issue tracker" }],
  });
  p.type(p.$("wsp-search-input"), "issue");
  await p.settle(200);
  p.document.querySelector(".wsp-search-result").click();
  await p.settle();
  assert.equal(p.state.closed, false);
  assert.equal(p.dialogText(), STARTING.message);
});

test("X-47: a switch that is still running closes the popup after a short wait", async () => {
  const p = await openPopup({ activateWorkspace: () => new Promise(() => {}) });
  p.row(B).querySelector(".wsp-row-main").click();
  await p.settle(20);
  assert.equal(p.state.closed, false, "waits briefly for a refusal");
  await p.settle(300);
  assert.equal(p.state.closed, true);
});

test("X-47: without a primary window the popup does not claim this is a secondary window, and switches to the list once claimed", async () => {
  const p = await openPopup({ getPrimaryWindowId: undefined });
  const note = p.document.querySelector("#wsp-list li.no-wsp");
  assert.ok(note);
  assert.doesNotMatch(note.textContent, /only available in the primary window/);
  assert.equal(p.$("wsp-search").hidden, true);
  // The restart restore claims this window as primary while the popup is open.
  p.storageChange({ "primary-window-id": 1 });
  await p.settle(20);
  assert.deepEqual(p.order(), [A, B, C]);
  assert.equal(p.document.querySelector("#wsp-list li.no-wsp"), null);
  assert.equal(p.$("wsp-search").hidden, false);
  assert.equal(p.$("createNewWsp").style.getPropertyValue("display") || "", "");
});

test("X-47: another window as primary still gets the primary-window notice", async () => {
  const p = await openPopup({ getPrimaryWindowId: 7 });
  assert.match(p.document.querySelector("#wsp-list li.no-wsp").textContent, /only available in the primary window/);
  p.storageChange({ "primary-window-id": 9 });
  await p.settle();
  assert.equal(p.order().length, 0, "still restricted for another window");
});

// ---------------------------------------------------------------- X-54

test("X-54: a search reply that lands after the box was cleared does not hide the list", async () => {
  const reply = deferred();
  const p = await openPopup({ searchTabs: () => reply.promise });
  const input = p.$("wsp-search-input");
  p.type(input, "git");
  await p.settle(170); // "git" request in flight
  p.type(input, "");   // cleared; its own debounced run is still pending
  reply.resolve([{ wspId: B, wspName: "Work", tabId: 3, title: "git log" }]);
  await p.settle();
  assert.equal(p.$("wsp-list").hidden, false);
  assert.equal(p.$("wsp-search-results").hidden, true);
});

test("X-54: a tab preview for a row the pointer already left is not shown", async () => {
  const previews = { [A]: deferred(), [B]: deferred() };
  const p = await openPopup({ getTabPreviews: ({ wspId }) => previews[wspId].promise });
  p.fire(p.row(A), "mouseenter");
  await p.settle(320); // A's preview request in flight
  p.fire(p.row(A), "mouseleave");
  p.fire(p.row(B), "mouseenter");
  previews[A].resolve({ previews: ["Tab of A"], total: 1 });
  await p.settle();
  assert.equal(p.document.querySelectorAll(".wsp-tab-preview").length, 0);
  assert.equal(p.row(A).getAttribute("aria-describedby"), null);
  await p.settle(320);
  previews[B].resolve({ previews: ["Tab of B"], total: 1 });
  await p.settle();
  const tips = p.document.querySelectorAll(".wsp-tab-preview");
  assert.equal(tips.length, 1);
  assert.equal(tips[0].textContent, "Tab of B");
  assert.equal(p.row(B).getAttribute("aria-describedby"), tips[0].id);
});

// ---------------------------------------------------------------- X-56

const dataTransfer = () => ({ setData() {}, effectAllowed: "", dropEffect: "" });

test("X-56: a drag that did not start on a row is refused and inserts nothing", async () => {
  const p = await openPopup();
  // e.g. a footer link (an <a href> is draggable) dragged onto a row
  p.fire(p.$("createNewWsp"), "dragstart", { dataTransfer: dataTransfer() });
  const over = p.fire(p.row(B), "dragover", { dataTransfer: dataTransfer() });
  assert.equal(over.defaultPrevented, false, "no drop allowed");
  p.fire(p.row(B), "drop", { dataTransfer: dataTransfer() });
  await p.settle();
  const texts = p.$("wsp-list").childNodes.filter((n) => n.nodeType === 3).map((n) => n.data);
  assert.deepEqual(texts, [], "no stray 'null' text node");
  assert.deepEqual(p.order(), [A, B, C]);
  assert.equal(p.actions("saveWorkspaceOrder").length, 0);
});

test("X-56: the drop line is drawn on the side the row lands", async () => {
  const p = await openPopup();
  p.fire(p.row(A), "dragstart", { dataTransfer: dataTransfer() });
  p.fire(p.row(C), "dragover", { dataTransfer: dataTransfer() });
  assert.equal(p.row(C).classList.contains("drag-over"), true);
  assert.equal(p.row(C).classList.contains("drag-over-below"), true, "moving down lands below C");
  p.fire(p.row(A), "dragend", { dataTransfer: dataTransfer() });
  assert.equal(p.row(C).classList.contains("drag-over-below"), false);

  p.fire(p.row(C), "dragstart", { dataTransfer: dataTransfer() });
  p.fire(p.row(A), "dragover", { dataTransfer: dataTransfer() });
  assert.equal(p.row(A).classList.contains("drag-over"), true);
  assert.equal(p.row(A).classList.contains("drag-over-below"), false, "moving up lands above A");
});

test("X-56: a refused reorder puts the rows back", async () => {
  const p = await openPopup({ saveWorkspaceOrder: STARTING });
  p.fire(p.row(A), "dragstart", { dataTransfer: dataTransfer() });
  p.fire(p.row(C), "dragover", { dataTransfer: dataTransfer() });
  p.fire(p.row(C), "drop", { dataTransfer: dataTransfer() });
  p.fire(p.row(A), "dragend", { dataTransfer: dataTransfer() });
  await p.settle();
  assert.deepEqual(p.actions("saveWorkspaceOrder").map((m) => m.orderedIds), [[B, C, A]]);
  assert.deepEqual(p.order(), [A, B, C]);
  assert.equal(p.dialogText(), STARTING.message);
});

test("X-56: a refused keyboard reorder puts the rows back and keeps focus", async () => {
  const p = await openPopup({ saveWorkspaceOrder: INTERNAL });
  const main = p.row(A).querySelector(".wsp-row-main");
  main.focus();
  p.press(main, "ArrowDown", { altKey: true });
  await p.settle();
  assert.deepEqual(p.order(), [A, B, C]);
  assert.equal(p.document.activeElement === main, true);
});

// ---------------------------------------------------------------- X-74

const CLOSED = {
  [A]: [{ url: "https://a.example/", title: "Closed in Home", closedAt: 1 }],
  [B]: [{ url: "https://b.example/", title: "Closed in Work", closedAt: 2 }],
  [N]: [],
};
const closedTitles = (p) => p.$("wsp-closed-tabs").hidden
  ? [] : p.document.querySelectorAll(".wsp-closed-tab-title").map((e) => e.textContent);

test("X-74: after creating a workspace, Recently Closed and its actions follow the new one", async () => {
  const p = await openPopup({
    getClosedTabs: ({ wspId }) => CLOSED[wspId],
    createWorkspaceWithTab: { wspId: N, tabId: 9 },
  });
  assert.deepEqual(closedTitles(p), ["Closed in Home"]);
  p.$("createNewWsp").click();
  await p.settle();
  p.$("custom-dialog-input").value = "Fresh";
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  assert.deepEqual(p.order(), [A, B, C, N]);
  assert.equal(p.row(N).classList.contains("active"), true);
  assert.equal(p.row(A).classList.contains("active"), false);
  assert.deepEqual(closedTitles(p), [], "no longer Home's list");
  // Clearing a search re-renders Recently Closed: for the new workspace.
  p.type(p.$("wsp-search-input"), "x");
  await p.settle(170);
  p.type(p.$("wsp-search-input"), "");
  await p.settle(170);
  assert.equal(p.actions("getClosedTabs").at(-1).wspId, N);
  assert.deepEqual(closedTitles(p), []);
});

test("X-74: deleting the active workspace shows the next active one's Recently Closed", async () => {
  const p = await openPopup({
    getClosedTabs: ({ wspId }) => CLOSED[wspId],
    destroyWsp: { success: true, activatedWspId: B },
  });
  p.row(A).querySelector(".delete-btn").click();
  await p.settle();
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  assert.deepEqual(p.order(), [B, C]);
  assert.equal(p.row(B).classList.contains("active"), true);
  assert.deepEqual(closedTitles(p), ["Closed in Work"]);
  p.$("wsp-closed-tabs-clear").click();
  await p.settle();
  assert.deepEqual(p.actions("clearClosedTabs").map((m) => m.wspId), [B]);
});

test("X-74: export and close of the active workspace moves the active mark too", async () => {
  const p = await openPopup({
    getClosedTabs: ({ wspId }) => CLOSED[wspId],
    exportWorkspaceToBookmarks: { exported: 1, total: 1, folderTitle: "Home", destroyed: true, activatedWspId: B },
  });
  p.row(A).querySelector(".export-btn").click();
  await p.settle();
  p.$("custom-dialog-checkbox").click();
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  assert.deepEqual(p.order(), [B, C]);
  assert.equal(p.row(B).classList.contains("active"), true);
  assert.deepEqual(closedTitles(p), ["Closed in Work"]);
});

// ---------------------------------------------------------------- X-121

const hasLoneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

test("X-121: a created name keeps its emoji whole, at the background's 200 limit", async () => {
  for (const [typed, expected] of [
    ["a".repeat(99) + "\u{1F680}x", "a".repeat(99) + "\u{1F680}x"],
    ["a".repeat(199) + "\u{1F680}", "a".repeat(199)],
  ]) {
    const p = await openPopup({ createWorkspaceWithTab: { wspId: N, tabId: 9 } });
    p.$("createNewWsp").click();
    await p.settle();
    p.$("custom-dialog-input").value = typed;
    p.$("custom-dialog-ok").click();
    await p.settle(20);
    const sent = p.actions("createWorkspaceWithTab")[0].name;
    assert.equal(hasLoneSurrogate(sent), false);
    assert.equal(sent, expected);
  }
});

test("X-121: changing only the color keeps a long name untouched", async () => {
  const long = "Research ".repeat(16).trim() + " \u{1F680}"; // 145 units, e.g. restored from a bookmark folder
  const p = await openPopup({
    getWorkspaces: [{ ...WORKSPACES[0], name: long }, WORKSPACES[1]],
  });
  p.row(A).querySelector(".rename-btn").click();
  await p.settle();
  p.document.querySelector('.color-swatch[data-color="#37adff"]').click();
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  const msg = p.actions("renameWorkspace")[0];
  assert.equal(msg.wspName, long);
  assert.equal(msg.wspColor, "#37adff");
});

test("X-121: the name field has the same limit", async () => {
  const p = await openPopup();
  assert.equal(p.$("custom-dialog-input").getAttribute("maxlength"), "200");
  assert.equal(p.get("WSP_NAME_MAX"), 200);
});

// ---------------------------------------------------------------- X-48 / X-49

const DUMP = {
  _generatedAt: "2026-09-26T10:00:00.000Z",
  "primary-window-id": 1,
  [`ld-wsp-${A}`]: {
    id: A, name: "Home", windowId: 1, tabs: [1, 2, 3],
    tabSnapshot: ["https://mail.example.com/inbox?token=SECRET1", "https://example.org/", "about:home"],
    lastActiveTabUrl: "https://mail.example.com/inbox?token=SECRET1",
  },
  [`ld-wsp-closed-${A}`]: [{
    url: "https://bank.example.net/login?code=SECRET2", title: "My bank - account 1234",
    favIconUrl: "https://bank.example.net/favicon.ico", closedAt: 5,
  }],
  [LAST_ERROR_KEY]: { reason: "phase4-failure", when: 1, error: "failed at https://x.example/?sid=SECRET3" },
};

test("X-48: the Copy diagnostics link is displayed, also in the restricted popup", async () => {
  const p = await openPopup({ getPrimaryWindowId: 7 });
  assert.notEqual(p.$("wsp-copy-diagnostics").style.getPropertyValue("display"), "none");
  p.$("wsp-copy-diagnostics").click();
  await p.settle();
  assert.equal(p.dialogOpen(), true, "the link works without a primary window");
});

test("X-49: nothing is copied before the user confirms", async () => {
  const p = await openPopup({ getDiagnostics: DUMP });
  p.$("wsp-copy-diagnostics").click();
  await p.settle();
  assert.equal(p.dialogOpen(), true);
  assert.equal(p.state.clipboard, null);
  assert.equal(p.actions("getDiagnostics").length, 0);
  assert.match(p.dialogText(), /recently closed/);
  assert.match(p.dialogText(), /titles/);
  p.$("custom-dialog-cancel").click();
  await p.settle();
  assert.equal(p.state.clipboard, null);
  assert.equal(p.actions("getDiagnostics").length, 0);
});

test("X-49: the default dump keeps structure but no full addresses, titles or icons", async () => {
  const p = await openPopup({ getDiagnostics: DUMP });
  p.$("wsp-error-copy").click(); // the banner button shares the same flow
  await p.settle();
  assert.equal(p.$("custom-dialog-checkbox").checked, false);
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  const clip = p.state.clipboard;
  assert.ok(clip);
  assert.doesNotMatch(clip, /SECRET|My bank|favicon\.ico|inbox/);
  const d = JSON.parse(clip);
  const wsp = d[`ld-wsp-${A}`];
  assert.deepEqual(wsp.tabs, [1, 2, 3]);
  assert.equal(wsp.name, "Home");
  assert.equal(wsp.tabSnapshot.length, 3);
  assert.match(wsp.tabSnapshot[0], /^https:\/\/mail\.example\.com\/\[[0-9a-f]{8}\]$/);
  assert.equal(wsp.tabSnapshot[1], "https://example.org/");
  assert.equal(wsp.tabSnapshot[2], "about:home");
  assert.equal(wsp.lastActiveTabUrl, wsp.tabSnapshot[0], "equal addresses keep equal tags");
  const closed = d[`ld-wsp-closed-${A}`][0];
  assert.equal(closed.title, "[title removed]");
  assert.equal(closed.favIconUrl, "[icon removed]");
  assert.equal(closed.closedAt, 5);
  assert.match(closed.url, /^https:\/\/bank\.example\.net\/\[/);
  assert.equal(d[LAST_ERROR_KEY].reason, "phase4-failure");
  assert.equal(d["primary-window-id"], 1);
  assert.match(p.dialogText(), /review it before sharing/);
});

test("X-49: the full dump is an explicit opt-in", async () => {
  const p = await openPopup({ getDiagnostics: DUMP });
  p.$("wsp-copy-diagnostics").click();
  await p.settle();
  p.$("custom-dialog-checkbox").click();
  p.$("custom-dialog-ok").click();
  await p.settle(20);
  assert.deepEqual(JSON.parse(p.state.clipboard), DUMP);
});
