import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { loadPopup } from "./helpers/popup-dom.mjs";

const ERROR_KEY = "ld-wsp-last-restore-error";
const INIT = { reason: "init-failure", when: 1000, error: "storage unavailable" };
const CLOSED = { reason: "primary-window-closed", when: 2000, windowId: 7,
  wspCount: 3, hiddenWspCount: 2, hiddenTabCount: 8 };
const LOSS = { reason: "session-not-restored", when: 3000, wspCount: 3,
  snapshotUrlCount: 8, exportedUrls: 8, exportedWorkspaces: 3 };

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function openBanner(payload, replies = {}) {
  const p = loadPopup({ replies: { getPrimaryWindowId: null, getLastRestoreError: payload, ...replies } });
  await p.settle(20);
  return { ...p, actions: name => p.sent.filter(m => m.action === name),
    text: () => p.$("wsp-error-banner-text").textContent };
}

test("startup failure offers retry through the existing dismiss command without invented counts", async () => {
  const p = await openBanner(INIT, { acknowledgeLastRestoreError: { success: true, resumed: true } });
  assert.match(p.text(), /could not start/i);
  assert.doesNotMatch(p.text(), /\?|untouched|restore was paused/i);
  assert.equal(p.$("wsp-error-give-up").hidden, true);
  assert.match(p.$("wsp-error-acknowledge").textContent, /retry/i);
  p.$("wsp-error-acknowledge").click();
  await p.settle();
  assert.deepEqual(p.actions("acknowledgeLastRestoreError").map(m => m.when), [1000]);
});

test("closed primary window exposes one guarded reopen action with the displayed timestamp", async () => {
  const pending = deferred();
  let warning = CLOSED;
  const p = await openBanner(CLOSED, {
    getLastRestoreError: () => warning,
    reopenClosedPrimaryWindow: () => pending.promise,
  });
  assert.match(p.text(), /primary window.*closed/i);
  assert.match(p.text(), /8.*2/);
  assert.doesNotMatch(p.text(), /\?|untouched|restore was paused/i);
  assert.equal(p.$("wsp-error-give-up").hidden, true);
  const reopen = p.$("wsp-error-reopen");
  assert.ok(reopen, "a reopen control exists in the real markup");
  assert.equal(reopen.hidden, false);
  p.press(reopen, "Enter");
  p.press(reopen, "Enter");
  assert.deepEqual(p.actions("reopenClosedPrimaryWindow").map(m => m.when), [2000]);
  warning = null;
  pending.resolve({ success: true, windowId: 8 });
  await p.settle();
  assert.equal(p.$("wsp-error-banner").hidden, true);
});

test("a failed reopen keeps the warning and explains the failure without losing retry", async () => {
  const p = await openBanner(CLOSED, {
    reopenClosedPrimaryWindow: { _error: true, _userFacing: true, message: "The closed window is no longer available." },
  });
  const reopen = p.$("wsp-error-reopen");
  assert.ok(reopen);
  reopen.click();
  await p.settle();
  assert.equal(p.$("wsp-error-banner").hidden, false);
  assert.match(p.$("custom-dialog-message").textContent, /no longer available/);
  p.$("custom-dialog-ok").click();
  await p.settle();
  assert.equal(reopen.disabled, false);
});

test("a new warning survives a successful reopen reply and an older refresh", async () => {
  const pending = deferred();
  const oldRead = deferred();
  let reads = 0;
  const p = await openBanner(CLOSED, {
    getLastRestoreError: () => ++reads === 1 ? CLOSED : oldRead.promise,
    reopenClosedPrimaryWindow: () => pending.promise,
  });
  const reopen = p.$("wsp-error-reopen");
  assert.ok(reopen);
  reopen.click();
  pending.resolve({ success: true, windowId: 8 });
  await p.settle();
  p.storageChange({ [ERROR_KEY]: LOSS });
  oldRead.resolve(null);
  await p.settle();
  assert.equal(p.$("wsp-error-banner").hidden, false);
  assert.match(p.text(), /not fully restored/);
  assert.equal(reopen.hidden, true);
  assert.equal(p.$("wsp-error-give-up").hidden, true);
});

test("a stale reopen response refreshes to the current warning", async () => {
  let warning = CLOSED;
  const p = await openBanner(CLOSED, {
    getLastRestoreError: () => warning,
    reopenClosedPrimaryWindow: () => { warning = INIT; return { success: false, stale: true }; },
  });
  const reopen = p.$("wsp-error-reopen");
  assert.ok(reopen);
  reopen.click();
  await p.settle();
  assert.equal(p.$("wsp-error-banner").hidden, false);
  assert.match(p.text(), /could not start/i);
  assert.equal(reopen.hidden, true);
  assert.match(p.$("wsp-error-acknowledge").textContent, /retry/i);
});

test("every recovery reason selects its supported actions without DOM or browser services", () => {
  const context = createContext({});
  runInContext(readFileSync(new URL("../popup/js/recovery-banner.js", import.meta.url), "utf8"), context);
  const model = runInContext("getRecoveryBannerModel", context);
  const cases = [
    ["init-failure", "Retry startup", false, false, /could not start/],
    ["primary-window-closed", "Dismiss", false, true, /primary window closed/],
    ["session-not-restored", "Dismiss", false, false, /not reopened automatically/],
    ["tabs-closed-at-startup", "Dismiss", false, false, /earlier automatic recovery/],
    ["phase4-failure", "Dismiss", true, false, /failed mid-way/],
    ["refuse-to-wipe", "Dismiss", true, false, /restore was paused/],
    ["future-warning", "Dismiss", true, false, /restore was paused/],
  ];
  for (const [reason, label, canGiveUp, canReopen, message] of cases) {
    const payload = Object.freeze({ ...LOSS, ...CLOSED, reason });
    const view = model(payload, () => "the recorded time");
    assert.equal(view.when, 2000);
    assert.equal(view.acknowledgeLabel, label, reason);
    assert.equal(view.canGiveUp, canGiveUp, reason);
    assert.equal(view.canReopen, canReopen, reason);
    assert.match(view.text, message, reason);
    assert.match(view.text, /the recorded time/);
  }
  assert.equal(model(null), null);
  const malformed = model({ reason: "init-failure", when: Infinity }, () => assert.fail("invalid timestamp formatted"));
  assert.equal(malformed.when, null);
  assert.match(malformed.text, /earlier/);
});

test("a failed recovery reports incomplete work without promising an untouched state", async () => {
  const p = await openBanner({ reason: "phase4-failure", when: 4000 });
  assert.match(p.text(), /recovery did not complete/i);
  assert.match(p.text(), /retry/i);
  assert.doesNotMatch(p.text(), /untouched|\?/i, "a partial commit has no unchanged-data guarantee or count evidence");
});
