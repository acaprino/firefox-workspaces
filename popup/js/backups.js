// File-history UI: keep only the selected preview in memory. Never mirror
// archives into extension storage or render file-supplied strings as HTML.
const byId = id => document.getElementById(id);
let archive = null;
let busy = false;
let selection = 0;

async function request(action, values = {}) {
  const reply = await browser.runtime.sendMessage({ action, ...values });
  if (reply?._error) throw new Error(reply.message);
  return reply;
}

function report(message, error = false) {
  byId("status").textContent = message;
  byId("status").dataset.error = String(error);
}

function controls() {
  const wsp = archive?.workspaces[Number(byId("workspaces").value)];
  for (const id of ["backup-now", "refresh", "disable"]) byId(id).disabled = busy;
  for (const element of document.querySelectorAll("select, input, #limit-form button")) element.disabled = busy;
  byId("restore-tab").disabled = busy || !wsp?.snapshot.tabs[Number(byId("tabs").value)];
  byId("restore-workspace").disabled = busy || !wsp;
  byId("restore-all").disabled = busy || !archive;
}

async function action(fn) {
  if (busy) return;
  busy = true;
  controls();
  try { await fn(); } catch (e) { report(e.message || "Operation failed", true); }
  finally { busy = false; controls(); }
}

function option(value, label) {
  const node = document.createElement("option");
  node.value = String(value);
  node.textContent = label;
  return node;
}

function showTabs() {
  const wsp = archive?.workspaces[Number(byId("workspaces").value)];
  byId("tabs").replaceChildren(...(wsp?.snapshot.tabs || []).map((tab, i) => {
    const container = archive.containers.find(c => c.cookieStoreId === tab.cookieStoreId);
    const group = wsp.snapshot.groups.find(g => g.key === tab.groupKey);
    return option(i, `${tab.title || tab.url} | ${container?.name || "Default"}${group ? " | " + group.title : ""} | ${tab.url}`);
  }));
  if (wsp?.snapshot.tabs.length) byId("tabs").value = "0";
  controls();
}

function preview(value) {
  if (!value || value.format !== "firefox-workspaces-backup" || value.version !== 1 || !Array.isArray(value.workspaces)) {
    throw new Error("This is not a supported Workspaces JSON backup");
  }
  archive = value;
  const count = archive.workspaces.reduce((n, w) => n + w.snapshot.tabs.length, 0);
  byId("summary").textContent = `${new Date(archive.createdAt).toLocaleString()} · ${archive.workspaces.length} workspaces · ${count} tabs`;
  byId("workspaces").replaceChildren(...archive.workspaces.map((w, i) => option(i, `${w.name} (${w.snapshot.tabs.length} tabs)`)));
  byId("workspaces").value = "0";
  showTabs();
}

function clearPreview() {
  archive = null;
  byId("summary").textContent = "Select a JSON version to preview its workspaces and tabs.";
  byId("workspaces").replaceChildren();
  byId("tabs").replaceChildren();
  controls();
}

async function status() {
  const state = await request("backupStatus");
  byId("directory").textContent = state.directory || "Backups connect to this Firefox profile automatically.";
  byId("limit").value = state.limit;
  byId("disable").textContent = state.enabled ? "Pause automatic backups" : "Resume automatic backups";
  byId("disable").dataset.enabled = String(state.enabled);
  const last = state.savedAt ? ` Last saved: ${new Date(state.savedAt).toLocaleString()}.` : " No saved backup confirmed yet.";
  report(state.error || `${state.enabled ? "Automatic backups enabled." : "Automatic backups paused."}${last}${state.warning ? " " + state.warning : ""}`, Boolean(state.error));
}

async function refresh() {
  const files = await request("backupHistory");
  const previous = byId("versions").value;
  byId("versions").replaceChildren(...files.map(file => {
    const match = /^workspaces-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(file.id);
    const label = match ? new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`).toLocaleString() : file.id;
    return option(file.id, `${label} · ${Math.ceil(file.bytes / 1024)} KB`);
  }));
  byId("versions").value = files.some(f => f.id === previous) ? previous : (files[0]?.id || "");
  clearPreview();
  if (files.length) preview(await request("backupRead", { filename: byId("versions").value }));
  if (!files.length) byId("summary").textContent = "No JSON versions found in the connected profile folder.";
}

function confirmRestore(message) {
  const dialog = byId("confirmation");
  byId("confirmation-text").textContent = message;
  dialog.returnValue = "cancel";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "restore"), { once: true });
    dialog.showModal();
  });
}

async function restore(scope) {
  if (!archive) return;
  const workspaceIndex = Number(byId("workspaces").value);
  const tabIndex = Number(byId("tabs").value);
  const count = scope === "all" ? archive.workspaces.reduce((n, w) => n + w.snapshot.tabs.length, 0)
    : scope === "workspace" ? archive.workspaces[workspaceIndex].snapshot.tabs.length : 1;
  if (!await confirmRestore(`Restore ${count} tab(s)? ${scope === "tab" ? "The tab will be added to the active workspace." : "New workspaces will be created."} Existing tabs will stay open.`)) return;
  const window = await browser.windows.getCurrent();
  const result = await request("backupRestore", { archive, scope, workspaceIndex, tabIndex, windowId: window.id });
  const restored = result.results?.reduce((n, w) => n + w.tabCount, 0) ?? result.tabCount;
  const partial = result.complete === false || (result.requested != null && result.tabCount < result.requested);
  report(`${restored} tab(s) restored.${partial ? " Restore was incomplete. Check the opened workspaces before retrying. " + (result.error || "") : ""}`, partial);
}

byId("versions").addEventListener("change", () => action(async () => {
  clearPreview();
  const ticket = ++selection;
  const value = await request("backupRead", { filename: byId("versions").value });
  if (ticket === selection) preview(value);
}));
byId("workspaces").addEventListener("change", showTabs);
byId("tabs").addEventListener("change", controls);
byId("refresh").addEventListener("click", () => action(async () => { await status(); await refresh(); }));
byId("backup-now").addEventListener("click", () => action(async () => {
  const result = await request("backupNow");
  if (!result.ok) throw new Error(result.error || "Automatic backup connection is unavailable");
  await status(); await refresh();
}));
byId("disable").addEventListener("click", () => action(async () => {
  await request(byId("disable").dataset.enabled === "true" ? "backupDisable" : "backupResume");
  await status();
}));
byId("limit-form").addEventListener("submit", event => {
  event.preventDefault();
  void action(async () => { await request("backupLimit", { limit: Number(byId("limit").value) }); await status(); });
});
byId("import").addEventListener("change", () => action(async () => {
  clearPreview();
  const file = byId("import").files[0];
  if (!file || file.size > 8 * 1024 * 1024) throw new Error("Choose a JSON backup of at most 8 MiB");
  const value = JSON.parse(await file.text());
  await request("backupValidate", { archive: value });
  preview(value);
}));
for (const scope of ["tab", "workspace", "all"]) byId("restore-" + scope).addEventListener("click", () => action(() => restore(scope)));
void action(async () => { await status(); await refresh(); });
