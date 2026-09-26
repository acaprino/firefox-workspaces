// tests/helpers/world.mjs
// Opt-in stateful browser model for scenario tests. load-backend.mjs stubs
// every tab and window API as a stateless no-op; a test that imports this
// module instead gets a small in-memory browser (windows, tabs, sessions tab
// values, recently closed list, containers, storage.session) that follows the
// Firefox rules the backend depends on:
//   - tabs.hide skips active, pinned, already hidden and media-sharing tabs
//     and resolves to the ids it actually hid. An invalid id anywhere in the
//     list rejects the whole show/hide/remove/move call before anything
//     changes ("Invalid tab ID: N").
//   - Selecting a hidden tab shows it (onUpdated {hidden:false} before
//     onActivated) and clears the multiselection. Closing the selected tab
//     selects the next visible tab to the right, else to the left.
//   - Closing the last visible tab closes the whole window, hidden tabs
//     included (browser.tabs.closeWindowWithLastTab, default true); with the
//     pref off a fresh about:newtab tab replaces it. Moving the last visible
//     tab to another window closes the source window the same way.
//   - Tab indexes are per-window positions; pinned tabs stay in front and
//     tabs.move ignores a move across the pinned boundary.
//   - A tab moved to another window keeps its id and its session values,
//     arrives visible and unselected, and fires onDetached + onAttached.
//   - Session tab values follow the tab: across windows, into the recently
//     closed list, and back onto the NEW tab id on undo close / restore.
//   - API calls fire the same events as user actions. onCreated carries the
//     post-selection state (active: true) and precedes onActivated. Every
//     event is delivered asynchronously (one macrotask per event) and
//     honours addListener filters ({properties, tabId, windowId}).
// Options:
//   apiLatencyMs      timer hop before every tabs/windows/sessions call
//                     (>= 1 makes the events of a call arrive before its
//                     promise resolves, as they often do in Firefox)
//   storageLatencyMs  timer hop per storage.local call (see load-backend.mjs)
//   autoEvents        false = mutate state silently; tests dispatch with fire()
//   sessionAlive      true (default) seeds the storage.session sentinel, so
//                     boot takes the "already running" path; false models a
//                     browser restart
//   closeWindowWithLastTab, urlCommitMs (web URLs load as about:blank first
//                     and commit N ms later with onUpdated {url})
// Nothing here runs unless a test imports it; the existing tests keep the
// plain stubs.
import { loadBackend } from "./load-backend.mjs";

export const WSP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const WSP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const WSP_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const WINDOW_ID_NONE = -1;
const WINDOW_ID_CURRENT = -2;
const DEFAULT_WINDOW_TYPES = ["normal", "panel", "popup"];
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// One storage record: { "ld-wsp-<id>": {...} } with the fields the backend
// expects, overridable.
export function wspRecord(id, fields = {}) {
  return {
    [`ld-wsp-${id}`]: {
      id, name: id.slice(0, 1).toUpperCase(), icon: "", active: false, tabs: [], groups: [],
      windowId: 1, containerId: null, color: null, tabSnapshot: [],
      lastActiveTabId: null, lastActiveTabUrl: null, ...fields,
    },
  };
}

// Storage seed for a primary window owning the given workspace records
// (array of wspRecord(...) results or plain {id, ...fields} objects).
export function seedWorkspaces(windowId, records) {
  const out = { "primary-window-id": windowId, "ld-wsp-schema-version": 2 };
  const ids = [];
  for (const r of records) {
    const rec = r.id ? wspRecord(r.id, { windowId, ...r }) : r;
    const [key, value] = Object.entries(rec)[0];
    ids.push(value.id);
    out[key] = value;
  }
  out[`ld-wsp-window-${windowId}`] = ids;
  out[`ld-wsp-order-${windowId}`] = [...ids];
  return out;
}

// Minimal match-pattern test for tabs.query({url}).
function urlMatches(url, patterns) {
  return [].concat(patterns).some((p) => {
    if (p === "<all_urls>") return /^(https?|wss?|file|ftp|data):/.test(url);
    const m = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)$/.exec(p);
    if (!m) return url === p;
    const scheme = m[1] === "*" ? "(https?|wss?)" : m[1].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const host = m[2] === "*" ? "[^/]*" : m[2].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/^\\\*\\\./, "(?:[^/]*\\.)?");
    const path = m[3].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${scheme}://${host}${path}$`).test(url);
  });
}

function passesFilter(ns, name, filter, args) {
  if (!filter) return true;
  if (ns === "tabs" && name === "onUpdated") {
    const [tabId, changeInfo, tab] = args;
    if (filter.tabId != null && filter.tabId !== tabId) return false;
    if (filter.windowId != null && filter.windowId !== tab.windowId) return false;
    if (filter.properties && !filter.properties.some((p) => p in changeInfo)) return false;
    if (filter.urls && !urlMatches(tab.url, filter.urls)) return false;
  }
  return true;
}

export function makeWorld({
  windows: winSeed = [{ id: 1 }],
  tabs: tabSeed = [],
  sessionValues = {},
  containers = [],
  storage = {},
  storageLatencyMs = 0,
  apiLatencyMs = 0,
  autoEvents = true,
  sessionAlive = true,
  closeWindowWithLastTab = true,
  urlCommitMs = null,
} = {}) {
  const windows = new Map();   // id -> { id, type, incognito, state, tabIds: [] }
  const tabs = new Map();      // id -> internal tab record
  const values = new Map();    // tabId -> Map(key -> JSON string)
  const closed = [];           // recently closed, newest first
  const groups = new Map();    // groupId -> { id, windowId, title, color, collapsed }
  const sessionArea = sessionAlive ? { "wsp-session-alive": true } : {};
  const calls = [];
  const listenerErrors = [];
  let browserRef = null;
  let env = null;
  let focusedId = null;
  let nextSessionId = 1;
  let nextGroupId = 900;
  let clock = 1_700_000_000_000;
  const now = () => ++clock;

  // ── Event dispatch ──
  let queued = 0;
  let stopped = false;
  const inflight = new Set();
  function fire(ns, name, ...args) {
    if (stopped) return;
    const payload = clone(args);
    queued++;
    setTimeout(() => {
      queued--;
      const ev = stopped ? null : browserRef?.[ns]?.[name];
      if (!ev) return;
      const entries = ev._entries ?? ev._listeners.map((fn) => ({ fn }));
      for (const { fn, filter } of [...entries]) {
        if (!passesFilter(ns, name, filter, payload)) continue;
        let p;
        try { p = Promise.resolve(fn(...payload)); } catch (e) { p = Promise.reject(e); }
        const tracked = p.catch((e) => { listenerErrors.push(e); })
          .finally(() => inflight.delete(tracked));
        inflight.add(tracked);
      }
    }, 0);
  }
  const emit = (ns, name, ...args) => { if (autoEvents) fire(ns, name, ...args); };

  // Wait until every dispatched event was delivered and every listener
  // promise settled, including events those listeners caused. Backend
  // debounce timers (snapshot refresh, menu refresh) are not awaited.
  async function idle({ timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let quiet = 0;
    while (quiet < 2) {
      if (Date.now() > deadline) {
        throw new Error(`world.idle() timed out: ${queued} queued, ${inflight.size} in flight`);
      }
      await delay(0);
      if (inflight.size) {
        quiet = 0;
        let timer;
        const timeout = new Promise((r) => { timer = setTimeout(r, Math.max(1, deadline - Date.now())); });
        await Promise.race([Promise.allSettled([...inflight]), timeout]);
        clearTimeout(timer);
        continue;
      }
      quiet = queued === 0 ? quiet + 1 : 0;
    }
  }

  // ── State helpers ──
  function requireTab(id) {
    const t = tabs.get(id);
    if (!t) throw new Error(`Invalid tab ID: ${id}`);
    return t;
  }
  function requireTabs(ids) { return [].concat(ids).map(requireTab); }
  function resolveWindowId(id) { return id == null || id === WINDOW_ID_CURRENT ? focusedId : id; }
  function requireWindow(id) {
    const w = windows.get(resolveWindowId(id));
    if (!w) throw new Error(`Invalid window ID: ${id}`);
    return w;
  }
  const tabsOf = (w) => w.tabIds.map((id) => tabs.get(id));
  const pinnedCount = (w) => tabsOf(w).filter((t) => t.pinned).length;
  const activeOf = (w) => tabsOf(w).find((t) => t.active);

  function snap(t) {
    const w = windows.get(t.windowId);
    const out = {
      id: t.id, index: w.tabIds.indexOf(t.id), windowId: t.windowId,
      url: t.url, title: t.title, status: t.status, favIconUrl: t.favIconUrl,
      active: t.active, highlighted: t.active || t.multiselected,
      pinned: t.pinned, hidden: t.hidden, discarded: t.discarded,
      incognito: w.incognito, cookieStoreId: t.cookieStoreId, groupId: t.groupId,
      lastAccessed: t.lastAccessed,
      sharingState: { camera: t.sharing, microphone: false, screen: undefined },
    };
    if (t.openerTabId != null) out.openerTabId = t.openerTabId;
    return out;
  }
  function winSnap(w, { populate = false } = {}) {
    const out = {
      id: w.id, type: w.type, incognito: w.incognito, state: w.state,
      focused: w.id === focusedId, alwaysOnTop: false,
    };
    if (populate) out.tabs = tabsOf(w).map(snap);
    return out;
  }

  function checkCookieStore(cookieStoreId, w) {
    if (cookieStoreId === "firefox-private") {
      if (!w.incognito) throw new Error("Illegal to set private cookieStoreId in a non-private window");
      return;
    }
    if (w.incognito) throw new Error("Illegal to set non-private cookieStoreId in a private window");
    if (cookieStoreId === "firefox-default") return;
    if (!containers.some((c) => c.cookieStoreId === cookieStoreId)) {
      throw new Error(`No cookie store exists with ID ${cookieStoreId}`);
    }
  }

  function setHidden(t, hidden) {
    if (t.hidden === hidden) return;
    t.hidden = hidden;
    emit("tabs", "onUpdated", t.id, { hidden }, snap(t));
  }

  // Make `t` the selected tab of its window. Returns the onActivated info
  // instead of firing it when `deferEvent` is set (tab creation fires
  // onCreated first).
  function select(t, { keepMultiselect = false, deferEvent = false } = {}) {
    const w = windows.get(t.windowId);
    const prev = activeOf(w);
    if (prev === t) return null;
    if (prev) prev.active = false;
    if (!keepMultiselect) for (const o of tabsOf(w)) o.multiselected = false;
    t.active = true;
    t.lastAccessed = now();
    if (t.hidden) {
      if (deferEvent) t.hidden = false;
      else setHidden(t, false);
    }
    const info = { tabId: t.id, previousTabId: prev ? prev.id : undefined, windowId: w.id };
    if (!deferEvent) emit("tabs", "onActivated", info);
    return info;
  }

  // Firefox _findTabToBlurTo: next visible tab to the right, else the left.
  function findTabToBlurTo(t, exclude = new Set()) {
    const w = windows.get(t.windowId);
    const list = tabsOf(w);
    const i = list.indexOf(t);
    const ok = (o) => o !== t && !o.hidden && !exclude.has(o.id);
    return list.slice(i + 1).find(ok) ?? list.slice(0, i).reverse().find(ok) ?? null;
  }

  function scheduleCommit(t, url) {
    setTimeout(() => {
      if (tabs.get(t.id) !== t) return;
      t.url = url;
      t.title = url;
      emit("tabs", "onUpdated", t.id, { url }, snap(t));
      t.status = "complete";
      emit("tabs", "onUpdated", t.id, { status: "complete" }, snap(t));
    }, urlCommitMs);
  }

  function insertIndex(w, pinned, wanted) {
    const np = pinnedCount(w);
    const len = w.tabIds.length;
    const idx = wanted == null || wanted < 0 ? len : Math.min(wanted, len);
    return pinned ? Math.min(idx, np) : Math.max(np, idx);
  }

  // `restore` (internal): session values Firefox puts back before the
  // extension hears about the tab.
  function createTab(props = {}, restore = null) {
    const w = requireWindow(props.windowId);
    const cookieStoreId = props.cookieStoreId ?? (w.incognito ? "firefox-private" : "firefox-default");
    checkCookieStore(cookieStoreId, w);
    const url = props.url ?? "about:newtab";
    const deferred = urlCommitMs != null && /^(https?|file|ftp):/.test(url);
    const t = {
      id: nextTabId++, windowId: w.id,
      url: deferred ? "about:blank" : url, title: props.title ?? (deferred ? "New Tab" : url),
      status: deferred ? "loading" : "complete", favIconUrl: undefined,
      pinned: !!props.pinned, hidden: false, active: false, multiselected: false,
      discarded: !!props.discarded, cookieStoreId, groupId: -1, sharing: false,
      lastAccessed: now(), openerTabId: props.openerTabId,
    };
    tabs.set(t.id, t);
    w.tabIds.splice(insertIndex(w, t.pinned, props.index), 0, t.id);
    if (restore?.values) values.set(t.id, new Map(restore.values));
    const mustSelect = props.active !== false || !activeOf(w);
    const activated = mustSelect ? select(t, { deferEvent: true }) : null;
    emit("tabs", "onCreated", snap(t));
    if (activated) emit("tabs", "onActivated", activated);
    if (deferred) scheduleCommit(t, url);
    return t;
  }

  // Closed-tab objects carry a sessionId instead of an id.
  function closedSnap(t) {
    const { id, ...rest } = snap(t);
    return { ...rest, sessionId: String(nextSessionId++) };
  }

  // Close one tab. `exclude` = other tabs removed in the same call (never
  // chosen as the next selection, like removeTabs()).
  function removeTab(t, { exclude = new Set() } = {}) {
    if (tabs.get(t.id) !== t) return;
    const w = windows.get(t.windowId);
    if (!t.hidden && !tabsOf(w).some((o) => o !== t && !o.hidden)) {
      // Last visible tab (Firefox ignores hidden tabs when deciding this).
      if (closeWindowWithLastTab) { closeWindow(w.id); return; }
      createTab({ windowId: w.id, url: "about:newtab", active: false });
    }
    const blurTo = t.active ? findTabToBlurTo(t, exclude) : null;
    closed.unshift({
      lastModified: now(), tab: { ...closedSnap(t), active: false },
      values: new Map(values.get(t.id) ?? []), windowId: w.id,
    });
    w.tabIds.splice(w.tabIds.indexOf(t.id), 1);
    tabs.delete(t.id);
    values.delete(t.id);
    emit("tabs", "onRemoved", t.id, { windowId: w.id, isWindowClosing: false });
    if (blurTo) {
      // select() cannot see the closed tab any more: previousTabId stays
      // undefined, as Firefox reports for a closing previous tab.
      const info = select(blurTo, { deferEvent: true });
      if (info) emit("tabs", "onActivated", info);
    }
    gcGroups();
  }

  function closeWindow(id) {
    const w = requireWindow(id);
    const entryTabs = tabsOf(w).map((t) => ({ tab: closedSnap(t), values: new Map(values.get(t.id) ?? []) }));
    for (const t of tabsOf(w)) {
      tabs.delete(t.id);
      values.delete(t.id);
      emit("tabs", "onRemoved", t.id, { windowId: w.id, isWindowClosing: true });
    }
    windows.delete(w.id);
    closed.unshift({
      lastModified: now(),
      window: { ...winSnap(w), focused: false, sessionId: String(nextSessionId++), tabs: entryTabs.map((e) => e.tab) },
      tabValues: entryTabs.map((e) => e.values),
    });
    emit("windows", "onRemoved", w.id);
    if (focusedId === w.id) {
      const nextFocus = [...windows.keys()].at(-1) ?? null;
      focusedId = nextFocus;
      emit("windows", "onFocusChanged", nextFocus ?? WINDOW_ID_NONE);
    }
    gcGroups();
  }

  function createWindow({ type = "normal", incognito = false, state = "normal", focused = true,
    url, tabId, tabs: tabProps } = {}) {
    if (tabId != null && windows.get(requireTab(tabId).windowId).incognito !== incognito) {
      throw new Error("Cannot move a tab between private and non-private windows");
    }
    const w = { id: nextWindowId++, type, incognito, state, tabIds: [] };
    windows.set(w.id, w);
    const prevFocus = focusedId;
    if (focused || focusedId == null) focusedId = w.id;
    emit("windows", "onCreated", winSnap(w));
    if (tabId != null) {
      moveTabs([tabId], { windowId: w.id, index: 0 });
      select(requireTab(tabId));
    } else {
      const list = tabProps ?? [].concat(url ?? "about:newtab").map((u) => ({ url: u }));
      list.forEach((p, i) => createTab({ ...p, windowId: w.id, active: p.active ?? i === 0 }));
    }
    if (focusedId !== prevFocus) emit("windows", "onFocusChanged", w.id);
    return w;
  }

  function focusWindow(id) {
    const w = requireWindow(id);
    if (focusedId === w.id) return;
    focusedId = w.id;
    emit("windows", "onFocusChanged", w.id);
  }

  // tabs.move semantics (ext-tabs.js move()): per-window insertion points,
  // illegal moves across the pinned boundary are skipped, cross-window moves
  // adopt the tab (same id, visible, unselected, session values kept).
  function moveTabs(ids, { windowId = null, index = -1 } = {}) {
    const dest = windowId == null ? null : requireWindow(windowId);
    const list = requireTabs(ids);
    const lastInsertion = new Map();
    const moved = [];
    for (const t of list) {
      const src = windows.get(t.windowId);
      const w = dest ?? src;
      const same = w === src;
      if (same && w.tabIds.length === 1) { lastInsertion.set(w.id, 0); continue; }
      if (!same && w.incognito !== src.incognito) continue;
      const from = src.tabIds.indexOf(t.id);
      let point;
      const last = lastInsertion.get(w.id);
      if (last == null) {
        const maxIndex = w.tabIds.length - (same ? 1 : 0);
        point = index === -1 ? maxIndex : Math.min(index, maxIndex);
      } else if (same && from <= last) {
        point = last;
      } else {
        point = last + 1;
      }
      const np = pinnedCount(w);
      if (t.pinned ? point > np : point < np) continue;
      if (same) {
        w.tabIds.splice(from, 1);
        w.tabIds.splice(point, 0, t.id);
        lastInsertion.set(w.id, point);
        if (from !== point) emit("tabs", "onMoved", t.id, { windowId: w.id, fromIndex: from, toIndex: point });
      } else {
        const blurTo = t.active ? findTabToBlurTo(t) : null;
        src.tabIds.splice(from, 1);
        t.windowId = w.id;
        t.active = false;
        t.multiselected = false;
        t.hidden = false;
        w.tabIds.splice(point, 0, t.id);
        lastInsertion.set(w.id, point);
        emit("tabs", "onDetached", t.id, { oldWindowId: src.id, oldPosition: from });
        emit("tabs", "onAttached", t.id, { newWindowId: w.id, newPosition: point });
        if (!tabsOf(src).some((o) => !o.hidden)) {
          closeWindow(src.id); // swapBrowsersAndCloseOther: last visible tab left
        } else if (blurTo) {
          const info = select(blurTo, { deferEvent: true });
          if (info) emit("tabs", "onActivated", info);
        }
      }
      moved.push(t);
    }
    return moved;
  }

  function navigate(t, url, { title } = {}) {
    t.status = "loading";
    emit("tabs", "onUpdated", t.id, { status: "loading" }, snap(t));
    if (urlCommitMs != null) { scheduleCommit(t, url); return; }
    t.url = url;
    emit("tabs", "onUpdated", t.id, { url }, snap(t));
    if (title != null) {
      t.title = title;
      emit("tabs", "onUpdated", t.id, { title }, snap(t));
    }
    t.status = "complete";
    emit("tabs", "onUpdated", t.id, { status: "complete" }, snap(t));
  }

  function setPinned(t, pinned) {
    if (t.pinned === pinned) return;
    const w = windows.get(t.windowId);
    if (pinned) setHidden(t, false); // pinTab() shows the tab first
    const from = w.tabIds.indexOf(t.id);
    const to = pinned ? pinnedCount(w) : pinnedCount(w) - 1;
    w.tabIds.splice(from, 1);
    w.tabIds.splice(to, 0, t.id);
    t.pinned = pinned;
    if (from !== to) emit("tabs", "onMoved", t.id, { windowId: w.id, fromIndex: from, toIndex: to });
    emit("tabs", "onUpdated", t.id, { pinned }, snap(t));
  }

  function gcGroups() {
    for (const gid of groups.keys()) {
      if (![...tabs.values()].some((t) => t.groupId === gid)) groups.delete(gid);
    }
  }

  function restoreClosed(sessionId) {
    const i = sessionId == null ? 0
      : closed.findIndex((e) => (e.tab ?? e.window).sessionId === String(sessionId));
    const entry = closed[i];
    if (!entry) throw new Error(`Could not restore object using sessionId ${sessionId}.`);
    closed.splice(i, 1);
    if (entry.tab) {
      const windowId = windows.has(entry.windowId) ? entry.windowId : focusedId;
      const t = createTab({
        windowId, url: entry.tab.url, title: entry.tab.title, pinned: entry.tab.pinned,
        index: entry.tab.index, cookieStoreId: entry.tab.cookieStoreId, active: true,
      }, { values: entry.values });
      return { lastModified: entry.lastModified, tab: snap(t) };
    }
    const w = createWindow({ type: entry.window.type, incognito: entry.window.incognito, tabs: [] });
    const restored = entry.window.tabs.map((tab, k) => createTab({
      windowId: w.id, url: tab.url, title: tab.title, pinned: tab.pinned,
      cookieStoreId: tab.cookieStoreId, active: tab.active,
    }, { values: entry.tabValues[k] }));
    // SessionStore re-hides the tabs that were hidden (TabHide -> onUpdated).
    restored.forEach((t, k) => {
      if (entry.window.tabs[k].hidden && !t.active && !t.pinned) setHidden(t, true);
    });
    return { lastModified: entry.lastModified, window: winSnap(w, { populate: true }) };
  }

  // ── Seed ──
  for (const s of winSeed) {
    windows.set(s.id, {
      id: s.id, type: s.type ?? "normal", incognito: !!s.incognito, state: s.state ?? "normal", tabIds: [],
    });
    if (s.focused || focusedId == null) focusedId = s.id;
  }
  let nextWindowId = Math.max(0, ...windows.keys()) + 1;
  const firstWindowId = winSeed[0]?.id;
  for (const s of tabSeed) {
    const windowId = s.windowId ?? firstWindowId;
    const w = windows.get(windowId);
    if (!w) throw new Error(`world seed: tab ${s.id} names unknown window ${windowId}`);
    if (s.active && s.hidden) throw new Error(`world seed: tab ${s.id} cannot be both active and hidden`);
    if (s.pinned && s.hidden) throw new Error(`world seed: tab ${s.id} cannot be both pinned and hidden`);
    tabs.set(s.id, {
      id: s.id, windowId, url: s.url ?? "about:newtab", title: s.title ?? s.url ?? "New Tab",
      status: s.status ?? "complete", favIconUrl: s.favIconUrl,
      pinned: !!s.pinned, hidden: !!s.hidden, active: !!s.active, multiselected: !!s.highlighted && !s.active,
      discarded: !!s.discarded, cookieStoreId: s.cookieStoreId ?? (w.incognito ? "firefox-private" : "firefox-default"),
      groupId: s.groupId ?? -1, sharing: !!s.sharing, lastAccessed: now(), openerTabId: s.openerTabId,
    });
    w.tabIds.push(s.id);
  }
  for (const w of windows.values()) {
    // Pinned tabs first, then seed order; exactly one selected tab.
    w.tabIds.sort((a, b) => Number(tabs.get(b).pinned) - Number(tabs.get(a).pinned));
    const active = tabsOf(w).filter((t) => t.active);
    if (active.length > 1) throw new Error(`world seed: window ${w.id} has ${active.length} active tabs`);
    if (active.length === 0 && w.tabIds.length) {
      const first = tabsOf(w).find((t) => !t.hidden);
      if (!first) throw new Error(`world seed: window ${w.id} has only hidden tabs`);
      first.active = true;
    }
  }
  for (const t of tabs.values()) if (t.groupId !== -1 && !groups.has(t.groupId)) {
    groups.set(t.groupId, { id: t.groupId, windowId: t.windowId, title: "", color: "grey", collapsed: false });
  }
  let nextTabId = Math.max(100, ...tabs.keys()) + 1;
  for (const [id, v] of Object.entries(sessionValues)) {
    const map = new Map();
    const obj = typeof v === "string" ? { wspId: v } : v;
    for (const [k, val] of Object.entries(obj)) map.set(k, JSON.stringify(val));
    values.set(Number(id), map);
  }

  // ── Browser API overrides ──
  const hop = () => (apiLatencyMs > 0 ? delay(apiLatencyMs) : Promise.resolve());
  const api = (name, fn) => async (...args) => {
    calls.push([name, ...clone(args)]);
    await hop();
    return fn(...args);
  };
  const byWindowThenIndex = (a, b) => {
    const order = [...windows.keys()];
    return order.indexOf(a.windowId) - order.indexOf(b.windowId) || a.index - b.index;
  };

  const overrides = {
    storage: {
      session: {
        get: async (keys) => {
          if (keys == null) return clone(sessionArea);
          const out = {};
          for (const k of [].concat(keys)) if (k in sessionArea) out[k] = clone(sessionArea[k]);
          return out;
        },
        set: async (obj) => { Object.assign(sessionArea, clone(obj)); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete sessionArea[k]; },
      },
    },
    windows: {
      WINDOW_ID_NONE, WINDOW_ID_CURRENT,
      getAll: api("windows.getAll", ({ populate = false, windowTypes = DEFAULT_WINDOW_TYPES } = {}) =>
        [...windows.values()].filter((w) => windowTypes.includes(w.type)).map((w) => winSnap(w, { populate }))),
      get: api("windows.get", (id, { populate = false } = {}) => winSnap(requireWindow(id), { populate })),
      getCurrent: api("windows.getCurrent", ({ populate = false } = {}) => winSnap(requireWindow(focusedId), { populate })),
      getLastFocused: api("windows.getLastFocused", ({ populate = false } = {}) => winSnap(requireWindow(focusedId), { populate })),
      create: api("windows.create", (props = {}) => winSnap(createWindow(props), { populate: true })),
      remove: api("windows.remove", (id) => { closeWindow(id); }),
      update: api("windows.update", (id, props = {}) => {
        const w = requireWindow(id);
        if (props.state) w.state = props.state;
        if (props.focused) focusWindow(w.id);
        return winSnap(w);
      }),
    },
    tabs: {
      TAB_ID_NONE: -1,
      query: api("tabs.query", (q = {}) => {
        const wid = q.currentWindow || q.lastFocusedWindow ? focusedId : resolveWindowId(q.windowId);
        return [...tabs.values()].map(snap).filter((t) =>
          ((q.windowId == null && !q.currentWindow && !q.lastFocusedWindow) || t.windowId === wid)
          && (q.windowType == null || windows.get(t.windowId).type === q.windowType)
          && (q.active == null || t.active === q.active)
          && (q.pinned == null || t.pinned === q.pinned)
          && (q.hidden == null || t.hidden === q.hidden)
          && (q.highlighted == null || t.highlighted === q.highlighted)
          && (q.discarded == null || t.discarded === q.discarded)
          && (q.status == null || t.status === q.status)
          && (q.index == null || t.index === q.index)
          && (q.cookieStoreId == null || [].concat(q.cookieStoreId).includes(t.cookieStoreId))
          && (q.url == null || urlMatches(t.url, q.url))).sort(byWindowThenIndex);
      }),
      get: api("tabs.get", (id) => snap(requireTab(id))),
      create: api("tabs.create", (props = {}) => snap(createTab(props))),
      remove: api("tabs.remove", (ids) => {
        const list = requireTabs(ids);
        const exclude = new Set(list.map((t) => t.id));
        for (const t of list) removeTab(t, { exclude });
      }),
      update: api("tabs.update", (id, props) => {
        if (typeof id === "object" && id !== null) { props = id; id = null; }
        const t = id == null ? activeOf(requireWindow(focusedId)) : requireTab(id);
        props = props ?? {};
        if (props.pinned != null) setPinned(t, props.pinned);
        if (props.highlighted === true && !t.active) {
          t.multiselected = true;
          if (props.active !== false) select(t, { keepMultiselect: true });
        } else if (props.highlighted === false) {
          t.multiselected = false;
        }
        if (props.active === true) select(t);
        if (props.url != null) navigate(t, props.url);
        return snap(t);
      }),
      move: api("tabs.move", (ids, props = {}) => {
        const moved = moveTabs(ids, props).map(snap);
        return Array.isArray(ids) ? moved : moved[0];
      }),
      hide: api("tabs.hide", (ids) => {
        const hidden = [];
        for (const t of requireTabs(ids)) {
          if (t.hidden || t.pinned || t.active || t.sharing) continue;
          setHidden(t, true);
          hidden.push(t.id);
        }
        return hidden;
      }),
      show: api("tabs.show", (ids) => { for (const t of requireTabs(ids)) setHidden(t, false); }),
      group: api("tabs.group", ({ tabIds, groupId, createProperties } = {}) => {
        const list = requireTabs(tabIds);
        const gid = groupId ?? ++nextGroupId;
        if (!groups.has(gid)) {
          const windowId = createProperties?.windowId ?? list[0].windowId;
          groups.set(gid, { id: gid, windowId, title: "", color: "grey", collapsed: false });
        }
        for (const t of list) t.groupId = gid;
        gcGroups();
        return gid;
      }),
      ungroup: api("tabs.ungroup", (ids) => { for (const t of requireTabs(ids)) t.groupId = -1; gcGroups(); }),
    },
    tabGroups: {
      query: api("tabGroups.query", ({ windowId } = {}) =>
        [...groups.values()].filter((g) => windowId == null || g.windowId === windowId).map(clone)),
      update: api("tabGroups.update", (gid, props = {}) => {
        const g = groups.get(gid);
        if (!g) throw new Error(`No group with id: ${gid}`);
        Object.assign(g, props);
        return clone(g);
      }),
    },
    sessions: {
      getTabValue: api("sessions.getTabValue", (tabId, key) => {
        requireTab(tabId);
        const raw = values.get(tabId)?.get(key);
        return raw === undefined ? undefined : JSON.parse(raw);
      }),
      setTabValue: api("sessions.setTabValue", (tabId, key, value) => {
        requireTab(tabId);
        if (!values.has(tabId)) values.set(tabId, new Map());
        values.get(tabId).set(key, JSON.stringify(value));
      }),
      removeTabValue: api("sessions.removeTabValue", (tabId, key) => {
        requireTab(tabId);
        values.get(tabId)?.delete(key);
      }),
      getRecentlyClosed: api("sessions.getRecentlyClosed", ({ maxResults = 25 } = {}) =>
        closed.slice(0, maxResults).map((e) => clone(e.tab
          ? { lastModified: e.lastModified, tab: e.tab }
          : { lastModified: e.lastModified, window: e.window }))),
      restore: api("sessions.restore", (sessionId) => restoreClosed(sessionId)),
      forgetClosedTab: api("sessions.forgetClosedTab", (windowId, sessionId) => {
        const i = closed.findIndex((e) => e.tab?.sessionId === String(sessionId));
        if (i === -1) throw new Error(`Could not find closed tab using sessionId ${sessionId}.`);
        closed.splice(i, 1);
      }),
    },
    contextualIdentities: {
      query: api("contextualIdentities.query", () => clone(containers)),
      get: api("contextualIdentities.get", (id) => {
        const c = containers.find((x) => x.cookieStoreId === id);
        if (!c) throw new Error(`Invalid contextual identity: ${id}`);
        return clone(c);
      }),
    },
  };

  const world = {
    tabs, windows, closed, storage, calls, listenerErrors, overrides,
    get env() { return env; },
    get browser() { return browserRef; },
    get focusedWindowId() { return focusedId; },

    // Load the backend against this world and let its init settle.
    async boot({ settleMs = 20 } = {}) {
      env = loadBackend({ storageData: storage, overrides, storageLatencyMs });
      browserRef = env.browser;
      await env.settle(settleMs);
      await idle();
      return env;
    },
    idle,
    // Deliver an arbitrary event to the backend's listeners (asynchronous,
    // filter-aware); ignores `autoEvents`.
    fire,
    // End of test: stop delivering events and cancel the backend's debounce
    // timers (the snapshot refresh waits 5 s), including any that handlers
    // still running would schedule, so the test process exits promptly.
    teardown() {
      stopped = true;
      if (!env) return;
      const TabService = env.get("TabService");
      TabService._scheduleSnapshotRefresh = () => {};
      for (const timer of TabService._snapshotTimers.values()) clearTimeout(timer);
      TabService._snapshotTimers.clear();
      const WorkspaceService = env.get("WorkspaceService");
      WorkspaceService.updateLastActiveTab = () => {};
      clearTimeout(WorkspaceService._lastActiveTimer);
      clearTimeout(env.get("MenuService")._refreshTimer);
    },

    // ── User actions (synchronous state change, asynchronous events) ──
    openTab: (props = {}) => snap(createTab(props)),
    selectTab: (id) => { select(requireTab(id)); },
    closeTab: (id) => { removeTab(requireTab(id)); },
    navigate: (id, url, opts) => { navigate(requireTab(id), url, opts); },
    moveTab: (id, props) => moveTabs([id], props).map(snap)[0],
    multiselect: (ids) => { for (const t of requireTabs(ids)) if (!t.active) t.multiselected = true; },
    setSharing: (id, sharing = true) => {
      const t = requireTab(id);
      t.sharing = sharing;
      emit("tabs", "onUpdated", t.id, { sharingState: snap(t).sharingState }, snap(t));
    },
    undoCloseTab: () => {
      const entry = closed.find((e) => e.tab);
      if (!entry) throw new Error("world.undoCloseTab: nothing to restore");
      return restoreClosed(entry.tab.sessionId).tab;
    },
    restoreClosed: (sessionId) => restoreClosed(sessionId),
    openWindow: (props = {}) => winSnap(createWindow(props), { populate: true }),
    closeWindow: (id) => { closeWindow(id); },
    focusWindow: (id) => { focusWindow(id); },

    // ── Inspection ──
    tab: (id) => (tabs.has(id) ? snap(tabs.get(id)) : undefined),
    order: (windowId = focusedId) => [...(windows.get(windowId)?.tabIds ?? [])],
    visible: (windowId = focusedId) => tabsOf(requireWindow(windowId)).filter((t) => !t.hidden).map((t) => t.id),
    hidden: (windowId = focusedId) => tabsOf(requireWindow(windowId)).filter((t) => t.hidden).map((t) => t.id),
    activeTabId: (windowId = focusedId) => activeOf(requireWindow(windowId))?.id,
    tabValue: (tabId, key = "wspId") => {
      const raw = values.get(tabId)?.get(key);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    record: (wspId) => storage[`ld-wsp-${wspId}`],
  };
  return world;
}
