// tests/smoke.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./helpers/load-backend.mjs";

// The background's init IIFE runs against the stubs; a rejection there must
// not kill the test process (Node exits on unhandled rejections by default).
process.on("unhandledRejection", () => {});

test("backend boots in the vm harness and defines its classes", async () => {
  const { get, settle } = loadBackend();
  await settle();
  assert.equal(typeof get("Brainer"), "function");
  assert.equal(typeof get("WSPStorageManager"), "function");
  assert.equal(typeof get("BookmarkService"), "function");
  assert.equal(typeof get("LIMITS"), "object");
});

test("boot registers the window listeners", async () => {
  const { browser, settle } = loadBackend();
  await settle();
  assert.ok(browser.windows.onRemoved._listeners.length >= 1);
  assert.ok(browser.windows.onCreated._listeners.length >= 1);
});
