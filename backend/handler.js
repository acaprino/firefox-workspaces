browser.runtime.onMessage.addListener(async (message, sender) => {
  if (sender.id !== browser.runtime.id) return;
  try {
    return await _handleMessage(message);
  } catch (e) {
    console.error("[Workspaces] Handler error:", message.action, e);
    return { _error: true, message: "An internal error occurred" };
  }
});

const CONTAINER_RE = /^firefox-container-\d+$/;
// Matches 6-digit hex color codes (with/without leading #). Used to validate
// user-supplied workspace colors before they are persisted.
const HEX_COLOR_RE = /^#?[0-9a-f]{6}$/i;
// Control characters, bidi overrides, and zero-width chars that can be used
// for visual spoofing in toolbar tooltips or log injection via newlines.
// Stripping these from workspace names is defense-in-depth — popup rendering
// uses .textContent (no XSS risk) but setTitle/console.log are not HTML-safe.
const CONTROL_AND_BIDI_RE = /[\x00-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

function _validateWspId(id) {
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new Error("Invalid wspId: " + String(id));
  }
}
function _validateWindowId(id) {
  if (typeof id !== "number" || id <= 0 || !Number.isInteger(id)) {
    throw new Error("Invalid windowId: " + String(id));
  }
}
function _validateContainerId(id) {
  // Null is a valid "no container" value. Any non-null must match the exact
  // Firefox container-id grammar. Empty string is NOT accepted — the caller
  // must normalize `""` to `null` before calling this validator.
  if (id === null) return;
  if (typeof id !== "string" || !CONTAINER_RE.test(id)) {
    throw new Error("Invalid containerId: " + String(id));
  }
}
// User-facing reply for an edit aimed at a workspace that no longer exists
// (Workspace.NOT_FOUND_MESSAGE), or null for any other error.
function _notFoundRefusal(e) {
  const msg = e?.message ?? String(e);
  if (!msg.startsWith("Workspace not found")) return null;
  console.log("[Handler] refused:", msg);
  return { _error: true, _userFacing: true, message: msg };
}
function _sanitizeName(name) {
  if (typeof name !== "string") return name;
  return name.replace(CONTROL_AND_BIDI_RE, '').trim().slice(0, 200);
}
// Validate user-supplied workspace metadata that is persisted to storage:
// icon must be a known value from the UIService whitelist (or falsy), color
// must be a 6-digit hex (or falsy), containerId must match the Firefox grammar
// (or null). Caller-supplied `id` is stripped so crypto.randomUUID() always
// assigns a fresh id — the popup never needs to pick its own wspId.
function _sanitizeCreatePayload(message) {
  if ("id" in message) delete message.id;
  if (message.icon != null && message.icon !== "") {
    if (!UIService._VALID_ICONS.has(message.icon)) {
      console.warn("[Handler] rejecting unknown icon:", message.icon);
      message.icon = "";
    }
  }
  if (message.color != null && message.color !== "") {
    if (typeof message.color !== "string" || !HEX_COLOR_RE.test(message.color)) {
      console.warn("[Handler] rejecting malformed color:", message.color);
      message.color = null;
    }
  }
  // Normalize empty-string container to null, then validate.
  if (!message.containerId) message.containerId = null;
  _validateContainerId(message.containerId);
}

// Actions that mutate workspace/tab state. Rejected while the background is
// initializing or restoring: during that window the stored tab arrays may
// reference reused tab IDs from the previous session, so a destroy/activate
// could act on the WRONG live tabs or interleave with the repair machinery.
// Read-only actions and the recovery surface (banner actions, diagnostics,
// dark-mode hint) stay available in every state.
const _MUTATING_ACTIONS = new Set([
  "createWorkspace", "createWorkspaceWithTab", "renameWorkspace",
  "destroyWsp", "activateWorkspace", "hideInactiveWspTabs",
  "setWorkspaceContainer", "restoreClosedTab", "clearClosedTabs",
  "saveWorkspaceOrder", "exportWorkspaceToBookmarks",
  "restoreWorkspaceFromBookmarks",
]);

async function _handleMessage(message) {
  const { action, ...args } = message;
  if (WSP_DEBUG) {
    // Summarize args to avoid dumping large workspace objects in logs.
    // Gated: building + stringifying this on every message is a hot-path tax.
    const argsSummary = Object.fromEntries(
      Object.entries(args).map(([k, v]) =>
        Array.isArray(v) ? [k, `[array len=${v.length}]`] :
        (v && typeof v === "object") ? [k, `{${Object.keys(v).join(",")}}` ] :
        [k, v]
      )
    );
    console.log("[Handler] action:", action, "args:", JSON.stringify(argsSummary));
  }

  if (_MUTATING_ACTIONS.has(action) && Brainer._state !== 'ready') {
    console.warn("[Handler] refused", action, "while state is", Brainer._state);
    return {
      _error: true,
      _userFacing: true,
      retriable: true,
      message: "Workspaces is still starting up (restoring the previous session). Please try again in a moment.",
    };
  }

  let result;

  switch (action) {
    case "getWorkspaces":
      _validateWindowId(message.windowId);
      result = await WorkspaceService.getOrderedWorkspaces(message.windowId);
      console.log("[Handler] getWorkspaces -> count:", result?.length);
      return result;
    case "createWorkspace":
      _validateWindowId(message.windowId);
      message.name = _sanitizeName(message.name);
      _sanitizeCreatePayload(message);
      await WorkspaceService.createWorkspace(message);
      console.log("[Handler] createWorkspace -> success");
      return { success: true };
    case "createWorkspaceWithTab":
      _validateWindowId(message.windowId);
      message.name = _sanitizeName(message.name);
      _sanitizeCreatePayload(message);
      result = await WorkspaceService.createWorkspaceWithTab(message);
      console.log("[Handler] createWorkspaceWithTab -> wspId:", result?.wspId, "tabId:", result?.tabId);
      return result;
    case "renameWorkspace":
      _validateWspId(message.wspId);
      message.wspName = _sanitizeName(message.wspName);
      // Normalize icon/color on rename as well — same validation rules apply.
      if (message.wspIcon != null && message.wspIcon !== "" && !UIService._VALID_ICONS.has(message.wspIcon)) {
        console.warn("[Handler] renameWorkspace rejecting icon:", message.wspIcon);
        message.wspIcon = "";
      }
      if (message.wspColor != null && message.wspColor !== "" &&
          (typeof message.wspColor !== "string" || !HEX_COLOR_RE.test(message.wspColor))) {
        console.warn("[Handler] renameWorkspace rejecting color:", message.wspColor);
        message.wspColor = null;
      }
      try {
        await WorkspaceService.renameWorkspace(message.wspId, { name: message.wspName, icon: message.wspIcon, color: message.wspColor });
      } catch (e) {
        // Deleted while the edit dialog was open: say so instead of a
        // generic error (and instead of the old silent zombie write).
        const refusal = _notFoundRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
      console.log("[Handler] renameWorkspace -> success");
      return { success: true };
    case "getNumWorkspaces":
      _validateWindowId(message.windowId);
      result = await WSPStorageManager.getNumWorkspaces(message.windowId);
      console.log("[Handler] getNumWorkspaces -> count:", result);
      return result;
    case "hideInactiveWspTabs":
      _validateWindowId(message.windowId);
      await WorkspaceService.hideInactiveWspTabs(message.windowId, message.activeWspId ?? null);
      console.log("[Handler] hideInactiveWspTabs -> success");
      return { success: true };
    case "destroyWsp":
      _validateWspId(message.wspId);
      // windowId is optional here (popup normally passes it), so we don't
      // hard-validate. WorkspaceService.destroyWsp falls back to a per-wsp
      // state lookup if windowId is null.
      if (message.windowId != null) _validateWindowId(message.windowId);
      try {
        result = await WorkspaceService.destroyWsp(message.wspId, message.windowId ?? null);
      } catch (e) {
        // Surface user-actionable errors ("Cannot destroy the last workspace",
        // "Workspace not found") with a distinct _error shape so the popup
        // can show a targeted message instead of a generic "internal error".
        const msg = e?.message ?? String(e);
        if (msg.startsWith("Cannot destroy") || msg.startsWith("Workspace not found")) {
          console.log("[Handler] destroyWsp -> refused:", msg);
          return { _error: true, _userFacing: true, message: msg };
        }
        throw e;
      }
      console.log("[Handler] destroyWsp -> success, activatedWspId:", result?.activatedWspId);
      return { success: true, activatedWspId: result?.activatedWspId };
    case "activateWorkspace":
      _validateWspId(message.wspId);
      _validateWindowId(message.windowId);
      await WorkspaceService.activateWsp(message.wspId, message.windowId, message.tabId ?? null);
      console.log("[Handler] activateWorkspace -> success");
      return { success: true };
    case "getWorkspaceName":
      result = WorkspaceService.generateWspName();
      console.log("[Handler] getWorkspaceName ->", result);
      return result;
    case "getPrimaryWindowId":
      result = await WSPStorageManager.getPrimaryWindowId();
      console.log("[Handler] getPrimaryWindowId ->", result);
      return result;

    // Tier 2: Containers
    case "getContainers":
      result = await WorkspaceService.getContainerList();
      console.log("[Handler] getContainers -> count:", result?.length);
      return result;
    case "setWorkspaceContainer":
      _validateWspId(message.wspId);
      _validateContainerId(message.containerId);
      try {
        await WorkspaceService.setWorkspaceContainer(message.wspId, message.containerId || null);
      } catch (e) {
        const refusal = _notFoundRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
      console.log("[Handler] setWorkspaceContainer -> success");
      return { success: true };
    // Tier 2: Closed tabs
    case "getClosedTabs":
      _validateWspId(message.wspId);
      result = await TabService.getClosedTabs(message.wspId);
      console.log("[Handler] getClosedTabs -> count:", result?.length);
      return result;
    case "restoreClosedTab":
      _validateWspId(message.wspId);
      _validateWindowId(message.windowId);
      // Entries are addressed by identity (url + closedAt), not index: the
      // stored array can mutate while the popup is open.
      if (typeof message.url !== "string" || !Number.isInteger(message.closedAt)) {
        throw new Error("Invalid closed-tab identity");
      }
      result = await TabService.restoreClosedTab(message.wspId,
        { url: message.url, closedAt: message.closedAt }, message.windowId);
      console.log("[Handler] restoreClosedTab -> url:", result?.url);
      return result;
    case "clearClosedTabs":
      _validateWspId(message.wspId);
      await TabService.clearClosedTabs(message.wspId);
      console.log("[Handler] clearClosedTabs -> success");
      return { success: true };

    // Tier 3: Workspace order
    case "saveWorkspaceOrder": {
      _validateWindowId(message.windowId);
      const ids = message.orderedIds;
      if (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && UUID_RE.test(id))) {
        console.warn("[Handler] saveWorkspaceOrder -> invalid orderedIds:", ids);
        return { _error: true, message: "orderedIds must be an array of valid UUIDs" };
      }
      await WorkspaceService.saveWorkspaceOrder(message.windowId, ids);
      console.log("[Handler] saveWorkspaceOrder -> success, length:", ids.length);
      return { success: true };
    }

    // Tier 3: Tab search
    case "searchTabs":
      _validateWindowId(message.windowId);
      result = await TabService.searchTabs(message.query, message.windowId);
      console.log("[Handler] searchTabs -> results:", result?.length);
      return result;

    // Tier 3: Tab previews
    case "getTabPreviews":
      _validateWspId(message.wspId);
      result = await TabService.getTabPreviews(message.wspId, message.limit);
      console.log("[Handler] getTabPreviews -> previews:", result?.previews?.length, "total:", result?.total);
      return result;

    // Tier 4: Bookmark export/restore
    case "exportWorkspaceToBookmarks": {
      _validateWspId(message.wspId);
      result = await BookmarkService.exportWorkspace(message.wspId);
      console.log("[Handler] exportWorkspaceToBookmarks -> exported:", result?.exported, "of", result?.total);
      // Atomic export+destroy: if the popup requested destroy, handle it here
      // so the operation completes even if the popup closes mid-flow.
      if (message.destroyAfter && result) {
        if (result.exported < result.total) {
          // Partial export: some tabs were skipped (non-bookmarkable URLs
          // like about:, file:, reader view) or their bookmarks.create failed.
          // Destroying now would close tabs that have no bookmark backup.
          console.warn("[Handler] exportWorkspaceToBookmarks destroy refused: exported",
            result.exported, "of", result.total);
          result.destroyed = false;
          result.destroyRefusedMessage =
            `Only ${result.exported} of ${result.total} tabs could be exported to bookmarks ` +
            `(pages like about:, file: or reader view cannot be bookmarked). ` +
            `The workspace was NOT closed, so no tab was lost.`;
        } else {
          if (message.windowId != null) _validateWindowId(message.windowId);
          try {
            const destroyResult = await WorkspaceService.destroyWsp(message.wspId, message.windowId ?? null);
            result.destroyed = true;
            result.activatedWspId = destroyResult?.activatedWspId;
          } catch (e) {
            const msg = e?.message ?? String(e);
            console.warn("[Handler] exportWorkspaceToBookmarks destroy failed:", msg);
            result.destroyed = false;
            result.destroyRefusedMessage = `Export succeeded but the workspace could not be closed: ${msg}`;
          }
        }
      }
      return result;
    }
    case "getBookmarkWorkspaces":
      result = await BookmarkService.getExportedWorkspaces();
      console.log("[Handler] getBookmarkWorkspaces -> count:", result?.length);
      return result;
    case "restoreWorkspaceFromBookmarks":
      _validateWindowId(message.windowId);
      if (typeof message.folderId !== "string" || !message.folderId) {
        throw new Error("Invalid folderId");
      }
      try {
        result = await BookmarkService.restoreWorkspace(message.folderId, message.windowId);
      } catch (e) {
        const msg = e?.message ?? String(e);
        if (msg.startsWith("No bookmarks") || msg.startsWith("Too many") ||
            msg.startsWith("Bookmark folder") || msg.startsWith("Folder is not") ||
            msg.startsWith("Failed to restore")) {
          console.log("[Handler] restoreWorkspaceFromBookmarks -> refused:", msg);
          return { _error: true, _userFacing: true, message: msg };
        }
        throw e;
      }
      console.log("[Handler] restoreWorkspaceFromBookmarks -> wspId:", result?.wspId, "tabs:", result?.tabCount);
      return result;

    // Refuse-to-wipe error surface. Popup queries on open to render a banner
    // when the previous restart aborted because the restore would have wiped
    // workspace tab arrays.
    //
    // Two distinct user actions:
    //   - acknowledgeLastRestoreError: dismisses the banner only. Leaves
    //     primaryWindowLastId intact so the next restart can still retry the
    //     restore. Also clears the in-memory _refuseToWipeActive flag so a
    //     re-attempt can run during the same Firefox session.
    //   - giveUpRestoreRetry: destructive. Also clears primaryWindowLastId
    //     so the next start enters the first-startup path and creates a
    //     fresh default workspace. Old `ld-wsp-{wspId}` records become
    //     orphaned (recoverable only via the diagnostic dump).
    case "getLastRestoreError":
      result = await WSPStorageManager.getLastRestoreError();
      console.log("[Handler] getLastRestoreError ->", result ? "present" : "none");
      return result;
    case "acknowledgeLastRestoreError": {
      // Compare-and-clear: the popup echoes the `when` of the payload it
      // displayed. A mismatch means the background replaced the warning while
      // the popup was open (e.g. a session-loss flag landing after a stale
      // refuse-to-wipe banner was rendered) -- clearing blindly would destroy
      // a warning the user never saw. Old popups that send no `when` keep the
      // unconditional behavior.
      const ackWhen = Number.isFinite(message.when) ? message.when : null;
      if (ackWhen != null) {
        const pending = await WSPStorageManager.getLastRestoreError();
        if (pending && Number.isFinite(pending.when) && pending.when !== ackWhen) {
          console.log("[Handler] acknowledgeLastRestoreError -> stale ack ignored (payload changed since display)");
          return { success: false, stale: true };
        }
      }
      await WSPStorageManager.clearLastRestoreError();
      Brainer.setRefuseToWipeActive(false);
      // Drop the "!" warning badge now that the banner is dismissed. The
      // helper falls back to the last-focused window when no primary exists
      // (refuse-to-wipe / phase4-failure states).
      await UIService.refreshWarnBadge();
      console.log("[Handler] acknowledgeLastRestoreError -> banner cleared, retry signal kept");
      return { success: true };
    }
    case "giveUpRestoreRetry": {
      // Compare-and-clear, same as acknowledgeLastRestoreError: this action
      // is destructive (drops the retry signal), so a payload that changed
      // while the confirm dialog was open must not be silently discarded.
      const giveUpWhen = Number.isFinite(message.when) ? message.when : null;
      if (giveUpWhen != null) {
        const pending = await WSPStorageManager.getLastRestoreError();
        if (pending && Number.isFinite(pending.when) && pending.when !== giveUpWhen) {
          console.log("[Handler] giveUpRestoreRetry -> stale request ignored (payload changed since display)");
          return { success: false, stale: true };
        }
      }
      // Before orphaning the old records, export their URL snapshots to
      // bookmark folders: the extension holds everything needed to rebuild
      // (names + ordered URL lists), and "give up" used to discard the only
      // user-reachable copy. Exported folders are restorable later via the
      // normal restore-from-bookmarks flow. _exportSnapshotsSafe never throws
      // and dedupes against the automatic session-loss export, so a loss that
      // was already backed up is not duplicated here.
      let exported = { folders: 0, urls: 0, deduped: false };
      const lastId = await WSPStorageManager.getPrimaryWindowLastId();
      if (lastId != null) {
        const orphans = await WSPStorageManager.getWorkspaces(lastId);
        exported = await Brainer._exportSnapshotsSafe(orphans);
      }
      await WSPStorageManager.clearLastRestoreError();
      await WSPStorageManager.removePrimaryWindowLastId();
      Brainer.setRefuseToWipeActive(false);
      await UIService.refreshWarnBadge();
      console.log("[Handler] giveUpRestoreRetry -> banner + retry signal cleared,",
        exported.folders, "workspace snapshot(s) exported to bookmarks",
        exported.deduped ? "(deduped -- already exported)" : "");
      return { success: true, exportedWorkspaces: exported.folders, alreadyExported: exported.deduped };
    }

    // Diagnostic dump for incident response. Returns every ld-wsp-* key plus
    // primary IDs and schema version. URL contents are returned as-is so the
    // user can decide what to share -- the popup can warn before copying to
    // clipboard.
    case "getDiagnostics":
      result = await WSPStorageManager.getDiagnostics();
      console.log("[Handler] getDiagnostics -> keys:", Object.keys(result || {}).length);
      return result;

    // Dark-mode hint from popup (popup has real DOM, bypasses resistFingerprinting)
    case "setDarkModeHint": {
      const newHint = message.isDark === true;
      // Authoritative: the popup probe has a real rendering context. The
      // accessor persists the hint (survives popup closings, available before
      // any popup opens) and drops the badge-color cache when it flipped.
      const changed = UIService.setDarkModeHint(newHint, { authoritative: true });
      console.log("[Handler] setDarkModeHint ->", newHint, "(changed:", changed, ")");
      if (changed) {
        // The hint just corrected a stale detection (e.g. the OS scheme flipped
        // and the hidden background page could not see it). Redraw now --
        // without this the old icon variant lingers until an unrelated
        // tab/focus event happens to call updateToolbarButton.
        const hintPrimaryWindowId = await WSPStorageManager.getPrimaryWindowId();
        if (hintPrimaryWindowId) await UIService.updateToolbarButton(hintPrimaryWindowId);
      }
      return { success: true };
    }

    default:
      console.warn("[Workspaces] Unknown message action:", action);
      return { _error: true, message: `Unknown action: ${action}` };
  }
}
