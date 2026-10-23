// tests/helpers/popup-dom.mjs
// Runs the REAL popup scripts against a minimal DOM built from the REAL
// popup/wsp.html, in one vm context (the popup document's global scope).
//
// Modelled, because the popup code depends on it:
//   - element tree, attributes, dataset, classList, hidden/inert/disabled
//   - a CSS selector subset (compound selectors, descendant / child /
//     sibling combinators, [attr], [attr="v"], :not(...)) for querySelector,
//     matches and closest
//   - event bubbling target -> ancestors -> document -> window
//   - focus: document.activeElement, focusability (disabled, tabindex,
//     hidden / inert / display:none ancestors), and focus loss when the
//     focused node leaves the document
//   - key presses in Gecko's order (see press())
//   - theming inputs: browser.theme.getCurrent, a live prefers-color-scheme
//     MediaQueryList, CSS.supports("color", v), and getComputedStyle for
//     the popup's color and -moz-Dialog probes (see computedStyleModel)
// Not modelled: layout (sizes are plain writable numbers, 0 by default),
// the capture phase, real CSS cascade. The few display:none rules the
// dialog depends on are mirrored from wsp.css in DISPLAY_NONE below.
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { inspect } from "node:util";
import { AssertionError } from "node:assert";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POPUP_DIR = join(ROOT, "popup");

// ---------------------------------------------------------------- selectors

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map(x => x.trim());
}

const COMPOUND_TOKEN = /(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]|:not\(((?:[^()]|\([^()]*\))*)\)/y;

function parseCompound(src) {
  const c = { tag: null, ids: [], classes: [], attrs: [], nots: [] };
  let pos = 0;
  while (pos < src.length) {
    COMPOUND_TOKEN.lastIndex = pos;
    const m = COMPOUND_TOKEN.exec(src);
    if (!m) throw new Error(`popup-dom: unsupported selector "${src}"`);
    pos = COMPOUND_TOKEN.lastIndex; // before :not() recursion reuses the regex
    if (m[1]) c.tag = m[1] === "*" ? null : m[1].toUpperCase();
    else if (m[2]) c.ids.push(m[2]);
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4].toLowerCase(), value: m[5] ?? m[6] ?? m[7] ?? null });
    else if (m[8] !== undefined) c.nots.push(parseSelectorList(m[8]));
  }
  return c;
}

function parseComplex(src) {
  const parts = [];
  let i = 0, comb = null;
  while (i < src.length) {
    let ws = false;
    while (src[i] === " ") { i++; ws = true; }
    if (src[i] === ">" || src[i] === "+" || src[i] === "~") {
      comb = src[i++];
      while (src[i] === " ") i++;
    } else if (ws && parts.length) {
      comb = " ";
    }
    const start = i;
    let depth = 0, quote = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (depth === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~")) break;
    }
    if (i === start) break;
    parts.push({ comb: parts.length ? (comb || " ") : null, compound: parseCompound(src.slice(start, i)) });
    comb = null;
  }
  return parts;
}

const selectorCache = new Map();
function parseSelectorList(sel) {
  let list = selectorCache.get(sel);
  if (!list) {
    list = splitTopLevel(sel, ",").map(parseComplex);
    selectorCache.set(sel, list);
  }
  return list;
}

function matchCompound(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== null && el.getAttribute(a.name) !== a.value) return false;
  }
  for (const list of c.nots) if (matchList(el, list)) return false;
  return true;
}

function matchComplex(el, parts, idx) {
  if (!matchCompound(el, parts[idx].compound)) return false;
  if (idx === 0) return true;
  const comb = parts[idx].comb;
  if (comb === ">") {
    const p = el.parentElement;
    return !!p && matchComplex(p, parts, idx - 1);
  }
  if (comb === " ") {
    for (let p = el.parentElement; p; p = p.parentElement) if (matchComplex(p, parts, idx - 1)) return true;
    return false;
  }
  if (comb === "+") {
    const p = el.previousElementSibling;
    return !!p && matchComplex(p, parts, idx - 1);
  }
  for (let p = el.previousElementSibling; p; p = p.previousElementSibling) {
    if (matchComplex(p, parts, idx - 1)) return true;
  }
  return false;
}

function matchList(el, list) {
  return list.some(parts => matchComplex(el, parts, parts.length - 1));
}

// ---------------------------------------------------------------- nodes

class Text {
  constructor(data, doc) {
    this.nodeType = 3;
    this.data = data;
    this.ownerDocument = doc;
    this.parentNode = null;
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
  get isConnected() { return !!this.parentNode?.isConnected; }
  remove() { this.parentNode?.removeChild(this); }
}

function asNode(n, doc) {
  return n instanceof Element || n instanceof Text ? n : new Text(String(n), doc);
}

class ClassList {
  constructor(el) { this._el = el; }
  _get() { return (this._el.getAttribute("class") || "").split(/\s+/).filter(Boolean); }
  _set(list) { this._el.setAttribute("class", list.join(" ")); }
  contains(c) { return this._get().includes(c); }
  add(...cs) { const l = this._get(); for (const c of cs) if (!l.includes(c)) l.push(c); this._set(l); }
  remove(...cs) { this._set(this._get().filter(c => !cs.includes(c))); }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : !!force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
  get length() { return this._get().length; }
  [Symbol.iterator]() { return this._get()[Symbol.iterator](); }
}

function makeStyle() {
  const props = new Map();
  return {
    setProperty(k, v) { props.set(k, String(v)); },
    removeProperty(k) { const v = props.get(k) ?? ""; props.delete(k); return v; },
    getPropertyValue(k) { return props.get(k) ?? ""; },
    cssText: "",
  };
}

const dataKey = (k) => "data-" + k.replace(/[A-Z]/g, m => "-" + m.toLowerCase());
function makeDataset(el) {
  return new Proxy({}, {
    get: (_, k) => typeof k === "string" ? (el.getAttribute(dataKey(k)) ?? undefined) : undefined,
    set: (_, k, v) => { el.setAttribute(dataKey(k), String(v)); return true; },
    deleteProperty: (_, k) => { el.removeAttribute(dataKey(k)); return true; },
    has: (_, k) => typeof k === "string" && el.hasAttribute(dataKey(k)),
    ownKeys: () => [...el._attrs.keys()].filter(n => n.startsWith("data-"))
      .map(n => n.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase())),
    getOwnPropertyDescriptor: (_, k) => el.hasAttribute(dataKey(k))
      ? { value: el.getAttribute(dataKey(k)), enumerable: true, configurable: true, writable: true }
      : undefined,
  });
}

const NATIVELY_FOCUSABLE = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
const FORM_CONTROLS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION"]);

export class Element {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this._attrs = new Map();
    this._listeners = {};
    this.classList = new ClassList(this);
    this.dataset = makeDataset(this);
    this.style = makeStyle();
    // Layout is not modelled: plain numbers a test may overwrite.
    this.offsetHeight = 0;
    this.offsetWidth = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.scrollTop = 0;
  }

  get localName() { return this.tagName.toLowerCase(); }
  get nodeName() { return this.tagName; }

  // attributes
  getAttribute(n) { return this._attrs.has(n.toLowerCase()) ? this._attrs.get(n.toLowerCase()) : null; }
  setAttribute(n, v) { this._attrs.set(n.toLowerCase(), String(v)); }
  removeAttribute(n) { this._attrs.delete(n.toLowerCase()); }
  hasAttribute(n) { return this._attrs.has(n.toLowerCase()); }
  toggleAttribute(n, force) {
    const on = force === undefined ? !this.hasAttribute(n) : !!force;
    if (on) this.setAttribute(n, ""); else this.removeAttribute(n);
    return on;
  }
  _boolAttr(n, v) { if (v) this.setAttribute(n, ""); else this.removeAttribute(n); }

  get id() { return this.getAttribute("id") ?? ""; }
  set id(v) { this.setAttribute("id", v); }
  get className() { return this.getAttribute("class") ?? ""; }
  set className(v) { this.setAttribute("class", v); }
  get title() { return this.getAttribute("title") ?? ""; }
  set title(v) { this.setAttribute("title", v); }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(v) { this._boolAttr("hidden", v); }
  get inert() { return this.hasAttribute("inert"); }
  set inert(v) { this._boolAttr("inert", v); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v) { this._boolAttr("disabled", v); }
  get draggable() { return this.getAttribute("draggable") === "true"; }
  set draggable(v) { this.setAttribute("draggable", v ? "true" : "false"); }
  get spellcheck() { return this.getAttribute("spellcheck") !== "false"; }
  set spellcheck(v) { this.setAttribute("spellcheck", v ? "true" : "false"); }
  get type() {
    const t = this.getAttribute("type");
    if (this.tagName === "BUTTON") return t ?? "submit";
    if (this.tagName === "INPUT") return t ?? "text";
    return t ?? "";
  }
  set type(v) { this.setAttribute("type", v); }
  get alt() { return this.getAttribute("alt") ?? ""; }
  set alt(v) { this.setAttribute("alt", v); }
  get src() { return this.getAttribute("src") ?? ""; }
  set src(v) { this.setAttribute("src", v); }
  get href() { return this.getAttribute("href") ?? ""; }
  get tabIndex() {
    const t = this.getAttribute("tabindex");
    if (t !== null && /^-?\d+$/.test(t.trim())) return parseInt(t, 10);
    return this._nativelyFocusable() ? 0 : -1;
  }
  set tabIndex(v) { this.setAttribute("tabindex", String(v)); }

  // form state
  get value() {
    if (this.tagName === "SELECT") {
      const opts = this.options;
      const sel = opts.find(o => o.selected) || opts[0];
      return sel ? sel.value : "";
    }
    if (this.tagName === "OPTION") return this.getAttribute("value") ?? this.textContent;
    if (this._value === undefined) this._value = this.getAttribute("value") ?? "";
    return this._value;
  }
  set value(v) {
    if (this.tagName === "SELECT") {
      for (const o of this.options) o.selected = o.value === String(v);
    } else if (this.tagName === "OPTION") {
      this.setAttribute("value", v);
    } else {
      this._value = String(v);
    }
  }
  get checked() { return this._checked ?? this.hasAttribute("checked"); }
  set checked(v) { this._checked = !!v; }
  get selected() { return this._selected ?? this.hasAttribute("selected"); }
  set selected(v) {
    this._selected = !!v;
    if (v && this.parentElement?.tagName === "SELECT") {
      for (const o of this.parentElement.options) if (o !== this) o._selected = false;
    }
  }
  get options() { return this.children.filter(c => c.tagName === "OPTION"); }

  // tree
  get children() { return this.childNodes.filter(n => n instanceof Element); }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] ?? null; }
  get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
  get nextElementSibling() {
    const sibs = this.parentNode?.children ?? [];
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }
  get previousElementSibling() {
    const sibs = this.parentNode?.children ?? [];
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1] : null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get textContent() { return this.childNodes.map(n => n.textContent).join(""); }
  set textContent(v) {
    this.replaceChildren();
    if (v !== "" && v != null) this.appendChild(new Text(String(v), this.ownerDocument));
  }
  set innerHTML(v) {
    if (v !== "") throw new Error("popup-dom: innerHTML only supports clearing");
    this.replaceChildren();
  }

  _adopt(node) {
    if (typeof node === "string") return new Text(node, this.ownerDocument);
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) {
    const n = this._adopt(node);
    this.childNodes.push(n);
    return n;
  }
  // ChildNode/ParentNode methods take (Node or DOMString): anything that is
  // not a node becomes text, so `li.after(null)` inserts "null".
  append(...nodes) { for (const n of nodes) this.appendChild(asNode(n, this.ownerDocument)); }
  insertBefore(node, ref) {
    if (ref == null) return this.appendChild(node);
    if (ref.parentNode !== this) throw new Error("NotFoundError: reference node is not a child");
    const n = this._adopt(node);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
    return n;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i === -1) throw new Error("NotFoundError: not a child");
    // Firefox drops focus when the focused node (or an ancestor) leaves the
    // document, including for a move (remove + insert).
    const doc = this.ownerDocument;
    const hadFocus = node instanceof Element && node.isConnected && node.contains(doc.activeElement);
    this.childNodes.splice(i, 1);
    node.parentNode = null;
    if (hadFocus) doc.activeElement = doc.body;
    return node;
  }
  replaceChildren(...nodes) {
    for (const n of [...this.childNodes]) this.removeChild(n);
    for (const n of nodes) this.appendChild(n);
  }
  remove() { this.parentNode?.removeChild(this); }
  before(...nodes) {
    const p = this.parentNode;
    for (const n of nodes) p.insertBefore(asNode(n, this.ownerDocument), this);
  }
  after(...nodes) {
    const p = this.parentNode;
    let ref = this;
    for (const n of nodes.map(x => asNode(x, this.ownerDocument))) {
      const next = p.childNodes[p.childNodes.indexOf(ref) + 1] ?? null;
      p.insertBefore(n, next);
      ref = n;
    }
  }

  // selectors
  matches(sel) { return matchList(this, parseSelectorList(sel)); }
  closest(sel) {
    const list = parseSelectorList(sel);
    for (let n = this; n instanceof Element; n = n.parentNode) if (matchList(n, list)) return n;
    return null;
  }
  *_descendants() {
    for (const c of this.children) { yield c; yield* c._descendants(); }
  }
  querySelectorAll(sel) {
    const list = parseSelectorList(sel);
    return [...this._descendants()].filter(el => matchList(el, list));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

  // events
  addEventListener(type, fn, opts) {
    (this._listeners[type] ||= []).push({ fn, once: !!(opts && opts.once) });
  }
  removeEventListener(type, fn) {
    const a = this._listeners[type] || [];
    const i = a.findIndex(l => l.fn === fn);
    if (i !== -1) a.splice(i, 1);
  }
  dispatchEvent(ev) { return dispatch(this, ev); }
  click() {
    if (FORM_CONTROLS.has(this.tagName) && this.disabled) return;
    if (this.tagName === "INPUT" && (this.type === "checkbox" || this.type === "radio")) {
      this.checked = this.type === "radio" ? true : !this.checked;
    }
    dispatch(this, makeEvent("click"));
  }

  // focus
  _nativelyFocusable() {
    if (NATIVELY_FOCUSABLE.has(this.tagName)) return this.type !== "hidden";
    return this.tagName === "A" && this.hasAttribute("href");
  }
  _isRendered() {
    for (let n = this; n instanceof Element; n = n.parentNode) {
      if (n.hidden || n.inert) return false;
      if (DISPLAY_NONE.some(rule => rule(n))) return false;
    }
    return true;
  }
  _isFocusable() {
    if (!this.isConnected || !this._isRendered()) return false;
    if (FORM_CONTROLS.has(this.tagName) && this.disabled) return false;
    return this._nativelyFocusable() || this.hasAttribute("tabindex");
  }
  focus() {
    if (!this._isFocusable()) return;
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  select() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }

  // Short form in assertion messages (the tree is circular and large).
  [inspect.custom]() {
    const id = this.id ? `#${this.id}` : "";
    const cls = this.className ? `.${this.className.trim().split(/\s+/).join(".")}` : "";
    return `<${this.localName}${id}${cls}>`;
  }
}

// display:none rules from popup/css/wsp.css that decide focusability of
// the dialog and the list behind it.
export const DISPLAY_NONE = [
  // #custom-dialog-backdrop { display: none } ... #custom-dialog-backdrop.show { display: flex }
  (el) => el.id === "custom-dialog-backdrop" && !el.classList.contains("show"),
  // #custom-dialog-backdrop.show ~ #wsp-container { display: none; }
  (el) => el.id === "wsp-container" &&
    !!el.ownerDocument.getElementById("custom-dialog-backdrop")?.classList.contains("show"),
  // .custom-dialog.dialog-confirm .custom-dialog-body { display: none; }
  (el) => el.classList.contains("custom-dialog-body") &&
    !!el.closest(".custom-dialog.dialog-confirm"),
];

// Identity assertions for DOM nodes. assert.equal() on two different nodes
// would walk the whole circular tree to build its message (it ignores
// custom inspectors), which takes practically forever.
export function describe(node) {
  if (node == null) return String(node);
  return node instanceof Element || node instanceof Document ? node[inspect.custom]() : inspect(node);
}

export function assertSame(actual, expected, message) {
  if (actual === expected) return;
  throw new AssertionError({
    message: `${message ? message + ": " : ""}expected ${describe(expected)}, got ${describe(actual)}`,
    actual: describe(actual), expected: describe(expected), operator: "===",
  });
}

export function assertNotSame(actual, other, message) {
  if (actual !== other) return;
  throw new AssertionError({
    message: `${message ? message + ": " : ""}did not expect ${describe(other)}`,
    actual: describe(actual), expected: describe(other), operator: "!==",
  });
}

// ---------------------------------------------------------------- events

const BUBBLES = new Set(["click", "keydown", "keyup", "keypress", "input", "change",
  "animationend", "focusin", "focusout", "dragstart", "dragover", "dragleave", "drop", "dragend"]);

export function makeEvent(type, init = {}) {
  return {
    type,
    bubbles: init.bubbles ?? BUBBLES.has(type),
    key: init.key,
    keyCode: init.keyCode ?? 0,
    repeat: !!init.repeat,
    isComposing: !!init.isComposing,
    altKey: !!init.altKey, ctrlKey: !!init.ctrlKey, metaKey: !!init.metaKey, shiftKey: !!init.shiftKey,
    dataTransfer: init.dataTransfer ?? null,
    target: null, currentTarget: null,
    defaultPrevented: false,
    _stop: false, _stopNow: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stop = true; },
    stopImmediatePropagation() { this._stop = true; this._stopNow = true; },
  };
}

function dispatch(target, ev) {
  ev.target = target;
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  const doc = target.ownerDocument ?? target;
  if (path[path.length - 1] === doc && doc.defaultView) path.push(doc.defaultView);
  for (const node of ev.bubbles ? path : [target]) {
    ev.currentTarget = node;
    const list = node._listeners?.[ev.type] || [];
    for (const l of [...list]) {
      if (l.once) node.removeEventListener(ev.type, l.fn);
      l.fn.call(node, ev);
      if (ev._stopNow) break;
    }
    // Event handler properties (el.onclick = ...), run after the listeners.
    const handler = ev._stopNow ? null : node["on" + ev.type];
    if (typeof handler === "function") handler.call(node, ev);
    if (ev._stop) break;
  }
  return !ev.defaultPrevented;
}

function fire(target, type, init) {
  const ev = makeEvent(type, init);
  dispatch(target, ev);
  return ev;
}

// A physical key press on `target`, in Gecko's order:
//   keydown (bubbles to document and window). If not default-prevented and
//   not consumed by an IME composition:
//   - Enter: keypress; if that is not prevented either, a <button> or an
//     <a href> activates (synthesized click) on the keypress.
//   - Space: a <button> activates, and a checkbox toggles, on keyup.
// `repeat: true` models one auto-repeat keydown of a held key (no keyup).
export function press(target, key, init = {}) {
  const opts = { key, ...init };
  const kd = fire(target, "keydown", opts);
  if (init.isComposing) return kd;
  if (!kd.defaultPrevented && key === "Enter") {
    const kp = fire(target, "keypress", opts);
    const activates = target.tagName === "BUTTON" || (target.tagName === "A" && target.hasAttribute("href"));
    if (!kp.defaultPrevented && activates) target.click();
  }
  if (init.repeat) return kd;
  const ku = fire(target, "keyup", opts);
  if (!kd.defaultPrevented && !ku.defaultPrevented && key === " ") {
    const isCheck = target.tagName === "INPUT" && (target.type === "checkbox" || target.type === "radio");
    if (target.tagName === "BUTTON" || isCheck) target.click();
  }
  return kd;
}

// Set a text field's value the way typing does: value, then an input event.
export function type(input, text) {
  input.value = text;
  dispatch(input, makeEvent("input"));
}

// ---------------------------------------------------------------- document

class Document {
  constructor() {
    this.nodeType = 9;
    this._listeners = {};
    this.parentNode = null;
    this.documentElement = null;
    this.defaultView = null;
    this._active = null;
  }
  get body() { return this.documentElement?.querySelector("body") ?? null; }
  get head() { return this.documentElement?.querySelector("head") ?? null; }
  get activeElement() {
    const a = this._active;
    return a && a.isConnected ? a : this.body;
  }
  set activeElement(el) { this._active = el; }
  get isConnected() { return true; }
  get children() { return this.documentElement ? [this.documentElement] : []; }
  createElement(tag) { return new Element(tag, this); }
  createTextNode(data) { return new Text(data, this); }
  getElementById(id) {
    if (!this.documentElement) return null;
    if (this.documentElement.id === id) return this.documentElement;
    for (const el of this.documentElement._descendants()) if (el.id === id) return el;
    return null;
  }
  querySelectorAll(sel) {
    if (!this.documentElement) return [];
    const root = this.documentElement;
    return [root, ...root._descendants()].filter(el => el.matches(sel));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  addEventListener(type, fn, opts) { Element.prototype.addEventListener.call(this, type, fn, opts); }
  removeEventListener(type, fn) { Element.prototype.removeEventListener.call(this, type, fn); }
  dispatchEvent(ev) { return dispatch(this, ev); }
  removeChild() { throw new Error("popup-dom: cannot remove the document element"); }
  [inspect.custom]() { return "#document"; }
}

// ---------------------------------------------------------------- HTML parser

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : (ENTITIES[e] ?? m));

// Enough HTML for popup/wsp.html: elements, quoted/bare/boolean attributes,
// void elements, comments, doctype, text.
export function parseHtml(src, doc) {
  const fragment = new Element("#fragment", doc);
  const stack = [fragment];
  const token = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+)/gi;
  const attrRe = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = token.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const tag = m[1].toUpperCase();
      const idx = stack.map(e => e.tagName).lastIndexOf(tag);
      if (idx > 0) stack.length = idx;
    } else if (m[2]) {
      const el = new Element(m[2], doc);
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[3] || ""))) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ""));
      top.appendChild(el);
      if (!VOID.has(m[2].toLowerCase()) && !m[4]) stack.push(el);
    } else if (m[5]) {
      if (stack.length > 1) top.appendChild(new Text(decode(m[5]), doc));
    }
  }
  return fragment.children;
}

// ---------------------------------------------------------------- CSS

// Parse wsp.css into { rules: [{ selectors, decls, media }] }: enough to
// assert which declarations a selector gets inside or outside an @media.
export function parseCss(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const walk = (s, media) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf("{", i);
      if (open === -1) break;
      const prelude = s.slice(i, open).trim();
      let depth = 1, j = open + 1;
      for (; j < s.length && depth; j++) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
      }
      const body = s.slice(open + 1, j - 1);
      if (prelude.startsWith("@media")) {
        walk(body, prelude.slice(6).trim());
      } else if (!prelude.startsWith("@")) {
        const decls = {};
        for (const d of body.split(";")) {
          const k = d.indexOf(":");
          if (k === -1) continue;
          decls[d.slice(0, k).trim().toLowerCase()] = d.slice(k + 1).trim();
        }
        rules.push({ selectors: splitTopLevel(prelude.replace(/\s+/g, " "), ","), decls, media });
      }
      i = j;
    }
  };
  walk(text, null);
  return { rules };
}

export function readPopupCss() {
  return parseCss(readFileSync(join(POPUP_DIR, "css", "wsp.css"), "utf8"));
}

// ---------------------------------------------------------------- style

// CSS.supports("color", v), modelled: Gecko's color parser for the shapes a
// theme uses. One token only: a hex color, a named color, or rgb()/rgba()
// with 3 or 4 numeric components (other color functions are accepted when
// their parentheses are balanced and not nested). Tests pass their own
// cssSupports to reject a specific value.
const NAMED_COLORS = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
  gray: [128, 128, 128], grey: [128, 128, 128], orange: [255, 165, 0],
  purple: [128, 0, 128], pink: [255, 192, 203], brown: [165, 42, 42],
};
export function cssSupportsModel(prop, value) {
  if (prop !== "color" || typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return true;
  if (v in NAMED_COLORS || v === "transparent" || v === "currentcolor") return true;
  const rgb = /^rgba?\(([^()]*)\)$/.exec(v);
  if (rgb) return parseRgbArgs(rgb[1]) !== null;
  return /^(hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)$/.test(v);
}

function parseRgbArgs(args) {
  const parts = args.includes(",")
    ? args.split(",").map((x) => x.trim())
    : args.replace("/", " / ").trim().split(/\s+/).filter((x) => x !== "/");
  if (parts.length < 3 || parts.length > 4) return null;
  // Percentages: of 255 for the channels, of 1 for the alpha.
  const nums = parts.map((x, i) => x.endsWith("%") ? Number(x.slice(0, -1)) * (i < 3 ? 2.55 : 0.01) : Number(x));
  return nums.every(Number.isFinite) ? nums : null;
}

// The computed `color` of an inline color, serialized as Gecko does for
// sRGB colors: "rgb(r, g, b)" or "rgba(r, g, b, a)". Other syntaxes (lab(),
// oklch(), color()) keep their own form, as they do in Gecko.
function computedColor(value) {
  const v = String(value ?? "").trim().toLowerCase();
  let rgba = null;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    rgba = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (h.length === 8) rgba.push(+(parseInt(h.slice(6, 8), 16) / 255).toFixed(3));
  } else if (v in NAMED_COLORS) {
    rgba = NAMED_COLORS[v];
  } else if (v === "transparent") {
    rgba = [0, 0, 0, 0];
  } else {
    const m = /^rgba?\(([^()]*)\)$/.exec(v);
    if (m) rgba = parseRgbArgs(m[1]);
  }
  if (!rgba) return v;
  const [r, g, b] = rgba.slice(0, 3).map((n) => Math.round(Math.min(255, Math.max(0, n))));
  return rgba.length === 4 && rgba[3] !== 1 ? `rgba(${r}, ${g}, ${b}, ${rgba[3]})` : `rgb(${r}, ${g}, ${b})`;
}

// getComputedStyle, modelled for what the popup reads:
//   color: the element's inline color (computedColor);
//   backgroundColor: -moz-Dialog resolved for the element's color-scheme,
//     which is its own inline one, else the root's (the [data-theme] rules
//     of wsp.css, "light dark" without data-theme). "light dark" follows
//     the OS preference. Any other element reads white, as before.
const MOZ_DIALOG = { light: "rgb(240, 240, 244)", dark: "rgb(43, 42, 51)" };
function computedStyleModel(el, doc, state) {
  const style = el?.style ?? {};
  const own = style.colorScheme || /(?:^|;)\s*color-scheme\s*:\s*([^;]+)/i.exec(style.cssText || "")?.[1];
  const rootTheme = doc.documentElement.getAttribute("data-theme");
  const scheme = (own || (rootTheme === "light" || rootTheme === "dark" ? rootTheme : "light dark")).trim();
  const used = /\blight\b/.test(scheme) && /\bdark\b/.test(scheme)
    ? (state.prefersDark ? "dark" : "light")
    : (/\bdark\b/.test(scheme) ? "dark" : "light");
  const probesDialog = /background\s*:\s*-moz-dialog/i.test(style.cssText || "");
  return {
    backgroundColor: probesDialog ? MOZ_DIALOG[used] : "rgb(255, 255, 255)",
    color: style.color ? computedColor(style.color) : "rgb(0, 0, 0)",
    getPropertyValue: () => "",
  };
}

// ---------------------------------------------------------------- loader

function makeListenerEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
    hasListener: (fn) => listeners.includes(fn),
    _listeners: listeners,
  };
}

// Replies the popup gets when a test does not override an action.
const DEFAULT_REPLIES = {
  getPrimaryWindowId: 1,
  getContainers: [],
  getWorkspaces: [],
  getLastRestoreError: null,
  getClosedTabs: [],
  getWorkspaceName: "Workspace",
  getBookmarkWorkspaces: [],
  searchTabs: [],
};

// Load popup/wsp.html and the scripts it references, in order.
//   scripts:  override the script list (paths relative to popup/), e.g.
//             ["js/dialog.js"] to test the dialog alone.
//   replies:  { action: value | (message) => value } for runtime.sendMessage.
//   reducedMotion: what matchMedia("(prefers-reduced-motion: reduce)") says;
//             with false the dialog waits for an animationend event.
//   theme:    what browser.theme.getCurrent() returns (a copy each call).
//   prefersDark: the OS color scheme; setPrefersDark() flips it later and
//             fires the prefers-color-scheme change listeners.
//   cssSupports: CSS.supports(property, value); defaults to cssSupportsModel.
export function loadPopup({
  scripts = null, replies = {}, reducedMotion = true,
  theme = { colors: {} }, prefersDark = false, cssSupports = cssSupportsModel,
} = {}) {
  const doc = new Document();
  const html = readFileSync(join(POPUP_DIR, "wsp.html"), "utf8");
  const roots = parseHtml(html, doc);
  const htmlEl = roots.find(e => e.tagName === "HTML");
  htmlEl.parentNode = doc;
  doc.documentElement = htmlEl;
  doc._active = null;

  const sent = [];
  const state = { closed: false, clipboard: null, prefersDark, theme };
  const mediaLists = [];
  const browser = {
    windows: { getCurrent: async () => ({ id: 1, type: "normal", incognito: false }) },
    theme: { getCurrent: async () => structuredClone(state.theme), onUpdated: makeListenerEvent() },
    storage: { onChanged: makeListenerEvent() },
    runtime: {
      sendMessage: async (message) => {
        // Copy into this realm so tests can deepStrictEqual the payloads.
        sent.push(structuredClone(message));
        const r = message.action in replies ? replies[message.action] : DEFAULT_REPLIES[message.action];
        const v = typeof r === "function" ? await r(message) : r;
        return v === undefined ? undefined : structuredClone(v);
      },
    },
  };

  const win = {
    document: doc,
    browser,
    console: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, crypto: globalThis.crypto,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    // A live MediaQueryList: `matches` follows the state, and "change"
    // listeners run on setPrefersDark().
    matchMedia: (q) => {
      const listeners = [];
      const mql = {
        get matches() {
          if (/prefers-reduced-motion:\s*reduce/.test(q)) return reducedMotion;
          if (/prefers-color-scheme:\s*dark/.test(q)) return state.prefersDark;
          if (/prefers-color-scheme:\s*light/.test(q)) return !state.prefersDark;
          return false;
        },
        media: q,
        addEventListener(type, fn) { if (type === "change") listeners.push(fn); },
        removeEventListener(type, fn) { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
        _listeners: listeners,
      };
      mediaLists.push(mql);
      return mql;
    },
    getComputedStyle: (el) => computedStyleModel(el, doc, state),
    CSS: { supports: (prop, value) => cssSupports(prop, value) },
    navigator: { clipboard: { writeText: async (t) => { state.clipboard = t; } } },
    innerHeight: 600,
    innerWidth: 400,
    close: () => { state.closed = true; },
    _listeners: {},
    addEventListener(type, fn, opts) { Element.prototype.addEventListener.call(win, type, fn, opts); },
    removeEventListener(type, fn) { Element.prototype.removeEventListener.call(win, type, fn); },
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  doc.defaultView = win;

  const list = scripts ?? doc.querySelectorAll("script[src]").map(s => s.getAttribute("src"));
  const ctx = createContext(win);
  for (const rel of list) {
    const file = normalize(join(POPUP_DIR, rel));
    runInContext(readFileSync(file, "utf8"), ctx, { filename: file.slice(ROOT.length + 1) });
  }

  return {
    window: win,
    document: doc,
    browser,
    sent,
    state,
    $: (id) => doc.getElementById(id),
    get: (name) => runInContext(name, ctx),
    press,
    type,
    fire: (target, type, init) => fire(target, type, init),
    settle: (ms = 10) => new Promise((r) => setTimeout(r, ms)),
    // Flip the OS color scheme, as the OS does at a scheduled switch.
    setPrefersDark: (dark) => {
      state.prefersDark = dark;
      for (const mql of mediaLists) {
        if (!/prefers-color-scheme/.test(mql.media)) continue;
        for (const fn of [...mql._listeners]) fn({ type: "change", matches: mql.matches, media: mql.media });
      }
    },
    // Deliver a storage.onChanged event, as browser.storage.local.set/remove
    // in the background does: { key: newValue } (undefined = removed).
    storageChange: (values, area = "local") => {
      const changes = {};
      for (const [k, v] of Object.entries(values)) changes[k] = v === undefined ? {} : { newValue: structuredClone(v) };
      for (const fn of [...browser.storage.onChanged._listeners]) fn(changes, area);
    },
  };
}
