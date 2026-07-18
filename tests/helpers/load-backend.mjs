// tests/helpers/load-backend.mjs
// Loads the real backend scripts into one shared vm context, mirroring the
// MV2 background's single global scope and manifest load order. All browser
// APIs are stubbed; storage.local is backed by a plain object the test can
// inspect and pre-seed.
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

function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    _listeners: listeners,
  };
}

export function makeBrowserStub({ storageData = {}, overrides = {} } = {}) {
  let bookmarkSeq = 0;
  const stub = {
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...storageData };
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in storageData) out[k] = storageData[k];
          return out;
        },
        set: async (obj) => { Object.assign(storageData, obj); },
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete storageData[k];
        },
      },
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

export function loadBackend({ storageData = {}, overrides = {} } = {}) {
  const browser = makeBrowserStub({ storageData, overrides });
  const sandbox = {
    browser,
    console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    // `crypto` (Web Crypto, e.g. crypto.randomUUID()) is a global in the MV2
    // background page; reuse Node's built-in implementation.
    crypto,
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
