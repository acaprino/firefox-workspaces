// tests/helpers/load-backend.mjs
// Loads the real backend scripts into one shared vm context, mirroring the
// MV2 background's single global scope and manifest load order. All browser
// APIs are stubbed; storage.local is backed by a plain object the test can
// inspect and pre-seed (values are structured-cloned in and out, as in
// Firefox). For stateful tab/window scenarios see ./world.mjs.
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const LOAD_ORDER = [
  "backend/theme-utils.js",
  "backend/storage.js",
  "backend/workspace.js",
  "backend/ui-service.js",
  "backend/menu-service.js",
  "backend/workspace-service.js",
  "backend/tab-service.js",
  "backend/bookmark-service.js",
  "backend/brainer.js",
  "backend/handler.js",
];

// `_listeners` holds the bare functions (tests call them directly);
// `_entries` pairs each with the optional filter passed as addListener's
// second argument (e.g. tabs.onUpdated's {properties: [...]}), so a
// dispatcher such as ./world.mjs can deliver only what Firefox would.
export function makeEvent() {
  const listeners = [];
  const entries = [];
  return {
    addListener: (fn, filter) => { listeners.push(fn); entries.push({ fn, filter }); },
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
      const j = entries.findIndex(e => e.fn === fn);
      if (j !== -1) entries.splice(j, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    _listeners: listeners,
    _entries: entries,
  };
}

// Real storage.local structured-clones every value on the way in and on the
// way out, so a caller never shares an object with storage or with another
// caller. A stub that hands out live references makes two interleaved
// read-modify-writes compose (both push into the same array) instead of the
// second overwriting the first, which hides every lost-update race. Values
// cross the vm boundary as main-realm objects; the backend never uses
// instanceof on stored data, and tests can deepEqual them directly.
// `latencyMs` (optional) adds a timer hop per call to model the IPC round
// trip; 0 (default) keeps a microtask-only stub.
export function makeStorageArea(storageData = {}, { latencyMs = 0 } = {}) {
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const hop = () => (latencyMs > 0 ? new Promise((r) => setTimeout(r, latencyMs)) : null);
  return {
    get: async (keys) => {
      await hop();
      if (keys == null) return clone({ ...storageData });
      // Object form: { key: defaultValue } returns the default for a missing key.
      if (typeof keys === "object" && !Array.isArray(keys)) {
        const out = {};
        for (const [k, dflt] of Object.entries(keys)) out[k] = clone(k in storageData ? storageData[k] : dflt);
        return out;
      }
      const out = {};
      for (const k of [].concat(keys)) if (k in storageData) out[k] = clone(storageData[k]);
      return out;
    },
    set: async (obj) => {
      // Clone synchronously (before the hop) like the real API, which
      // serializes its argument at call time: a caller mutating the object
      // after set() must not change what gets stored.
      const copy = structuredClone(obj);
      await hop();
      Object.assign(storageData, copy);
    },
    remove: async (keys) => {
      await hop();
      for (const k of [].concat(keys)) delete storageData[k];
    },
  };
}

export function makeBrowserStub({ storageData = {}, overrides = {}, storageLatencyMs = 0 } = {}) {
  let bookmarkSeq = 0;
  const stub = {
    storage: {
      local: makeStorageArea(storageData, { latencyMs: storageLatencyMs }),
      session: { get: async () => ({}), set: async () => {} },
      onChanged: makeEvent(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, incognito: false }],
      getCurrent: async () => ({ id: 1, incognito: false }),
      getLastFocused: async () => ({ id: 1, incognito: false }),
      get: async (id) => {
        if (id === 1) return { id: 1, incognito: false };
        throw new Error("No window with id " + id);
      },
      onCreated: makeEvent(),
      onRemoved: makeEvent(),
      onFocusChanged: makeEvent(),
    },
    tabs: {
      query: async () => [],
      get: async () => { throw new Error("no tab"); },
      create: async (o) => ({ id: 100, ...o }),
      update: async () => ({}),
      show: async () => {},
      hide: async () => [],
      onCreated: makeEvent(), onRemoved: makeEvent(), onUpdated: makeEvent(),
      onActivated: makeEvent(), onMoved: makeEvent(),
      onAttached: makeEvent(), onDetached: makeEvent(),
    },
    tabGroups: {
      query: async () => [],
      update: async () => ({}),
      onUpdated: makeEvent(),
    },
    sessions: {
      getTabValue: async () => undefined,
      setTabValue: async () => {},
      getRecentlyClosed: async () => [],
    },
    browserAction: {
      setTitle: async () => {}, setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {}, setIcon: async () => {},
    },
    menus: {
      create: () => {}, remove: async () => {}, removeAll: async () => {},
      update: async () => {}, refresh: async () => {},
      onClicked: makeEvent(), onShown: makeEvent(), onHidden: makeEvent(),
    },
    omnibox: {
      setDefaultSuggestion: () => {},
      onInputChanged: makeEvent(), onInputEntered: makeEvent(),
      onInputStarted: makeEvent(), onInputCancelled: makeEvent(),
    },
    bookmarks: {
      create: async (b) => ({ id: "bm-" + (++bookmarkSeq), type: b.url ? "bookmark" : "folder", ...b }),
      search: async () => [],
      getChildren: async () => [],
      get: async (id) => [{ id, type: "folder", parentId: "unfiled_____" }],
    },
    contextualIdentities: { query: async () => [] },
    theme: { getCurrent: async () => ({}), onUpdated: makeEvent() },
    commands: { onCommand: makeEvent() },
    runtime: {
      onMessage: makeEvent(), onInstalled: makeEvent(), onStartup: makeEvent(),
      getURL: (p) => "moz-extension://test/" + p,
      sendMessage: async () => ({}),
    },
  };
  // Shallow-merge per-namespace overrides (e.g. { windows: { getAll: ... } }).
  for (const [ns, api] of Object.entries(overrides)) {
    stub[ns] = { ...stub[ns], ...api };
  }
  return stub;
}

export function loadBackend({ storageData = {}, overrides = {}, storageLatencyMs = 0 } = {}) {
  const browser = makeBrowserStub({ storageData, overrides, storageLatencyMs });
  const sandbox = {
    browser,
    console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    // `crypto` (Web Crypto, e.g. crypto.randomUUID()) is a global in the MV2
    // background page; reuse Node's built-in implementation.
    crypto,
    // `URL` is a global in the MV2 background page (TabService._isUrlAllowed
    // parses with `new URL(...)`); a vm sandbox does not inherit it, so add it
    // explicitly or every URL fails to parse and exports create zero folders.
    URL,
    fetch: async () => ({ status: 200, text: async () => "<svg></svg>" }),
  };
  sandbox.globalThis = sandbox;
  // In an MV2 background page `self` is the global object (backend code uses
  // `self.matchMedia?.(...)`); mirror the real environment's binding.
  sandbox.self = sandbox;
  const ctx = createContext(sandbox);
  for (const file of LOAD_ORDER) {
    runInContext(readFileSync(join(ROOT, file), "utf8"), ctx, { filename: file });
  }
  return {
    get: (name) => runInContext(name, ctx),
    browser,
    storageData,
    settle: (ms = 20) => new Promise((r) => setTimeout(r, ms)),
  };
}
