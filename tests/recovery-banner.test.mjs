// Exercise the real popup banner against a minimal DOM and messaging boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

async function renderBanner(payload) {
  const nodes = Object.fromEntries([
    "wsp-error-banner", "wsp-error-banner-text", "wsp-error-copy",
    "wsp-error-acknowledge", "wsp-error-give-up",
  ].map(id => [id, { hidden: true, textContent: "", addEventListener() {} }]));
  const changes = [];
  const messages = [];
  const ctx = createContext({
    WSP_DEBUG: false,
    console: { log() {}, debug() {}, error() {} },
    document: { getElementById: id => nodes[id] },
    browser: {
      // Hold the automatic full-popup initialization before DOM/theme work.
      // This suite exercises the banner independently of unrelated UI widgets.
      windows: { getCurrent: () => new Promise(() => {}) },
      theme: { getCurrent: async () => ({}) },
      runtime: { sendMessage: async message => {
        messages.push(message.action);
        assert.equal(message.action, "getLastRestoreError");
        return payload;
      } },
      storage: { onChanged: { addListener: listener => changes.push(listener) } },
    },
  });
  runInContext(readFileSync(new URL("../popup/js/wsp.js", import.meta.url), "utf8"), ctx);
  await runInContext("new WorkspaceUI()._setupRestoreErrorBanner()", ctx);
  return { nodes, messages, changes, text: () => nodes["wsp-error-banner-text"].textContent };
}

const incomplete = {
  when: 1789732764855, reason: "session-not-restored", wspCount: 3,
  snapshotUrlCount: 31, exportedWorkspaces: 3, exportedUrls: 31,
};

function assertNeutral(text) {
  assert.doesNotMatch(text, /gone for good|cannot come back|not by this extension|check your other extensions|closed by something|usually means/i);
}

test("incomplete restore banner reports backup and voluntary recovery without diagnosing a cause", async () => {
  const ui = await renderBanner(incomplete);
  assertNeutral(ui.text());
  assert.match(ui.text(), /not fully restored/i);
  assert.match(ui.text(), /31 URL\(s\)/);
  assert.match(ui.text(), /Restore from bookmarks/);
  assert.match(ui.text(), /not reopened automatically/i);
  assert.equal(ui.nodes["wsp-error-banner"].hidden, false);
  assert.equal(ui.nodes["wsp-error-give-up"].hidden, true);
  assert.deepEqual(ui.messages, ["getLastRestoreError"], "rendering cannot trigger recovery");
});

test("a legacy auto-recovery banner always shows its backup even when all matched sessions reopened", async () => {
  const ui = await renderBanner({
    ...incomplete, reason: "tabs-closed-at-startup", closedMatchCount: 25, restoredCount: 25,
  });
  assertNeutral(ui.text());
  assert.match(ui.text(), /25/);
  assert.match(ui.text(), /31 URL\(s\)/, "25 of 25 undo sessions does not mean all 31 snapshot URLs survived");
  assert.match(ui.text(), /Restore from bookmarks/);
  assert.doesNotMatch(ui.text(), /All 25|not reopened automatically/i,
    "legacy payload must not claim completeness or deny past auto-recovery");
});

test("partial and failed backups report actual export results", async () => {
  const partial = await renderBanner({ ...incomplete, exportedWorkspaces: 1, exportedUrls: 7 });
  assert.match(partial.text(), /7 of 31 URL\(s\)/);
  assert.match(partial.text(), /Restore from bookmarks/);

  const failed = await renderBanner({ ...incomplete, exportedWorkspaces: 0, exportedUrls: 0 });
  assert.match(failed.text(), /No tab list could be exported/i);
  assert.doesNotMatch(failed.text(), /were exported to bookmarks/i);
});

test("new warnings replace legacy recovery text while the popup stays open", async () => {
  const ui = await renderBanner({ ...incomplete, reason: "tabs-closed-at-startup", restoredCount: 25 });
  ui.changes[0]({ "ld-wsp-last-restore-error": { newValue: incomplete } }, "local");
  assertNeutral(ui.text());
  assert.match(ui.text(), /not reopened automatically/i);
  assert.doesNotMatch(ui.text(), /25 tab/);
  ui.changes[0]({ "ld-wsp-last-restore-error": { newValue: null } }, "local");
  assert.equal(ui.nodes["wsp-error-banner"].hidden, true);
});
