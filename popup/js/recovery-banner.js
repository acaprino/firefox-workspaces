// Pure presentation policy for the recovery-warning protocol. DOM, messages,
// storage subscriptions and action races belong to the popup controller.
function getRecoveryBannerModel(payload, formatWhen = timestamp => new Date(timestamp).toLocaleString()) {
  if (!payload) return null;
  const isFiniteNum = value => typeof value === "number" && Number.isFinite(value);
  const when = isFiniteNum(payload.when) ? payload.when : null;
  const whenText = when === null ? "earlier" : formatWhen(when);
  const model = {
    when,
    text: "",
    acknowledgeLabel: "Dismiss",
    acknowledgeTitle: "Dismiss this warning.",
    canGiveUp: false,
    canReopen: false,
  };

  if (payload.reason === "init-failure") {
    model.text = `Workspaces could not start at ${whenText}. ` +
      `Workspace actions are unavailable until startup succeeds. ` +
      `Use "Retry startup" to try again, or restart Firefox.`;
    model.acknowledgeLabel = "Retry startup";
    model.acknowledgeTitle = "Dismiss this warning and retry starting Workspaces now.";
    return model;
  }

  if (payload.reason === "manual-restore-incomplete") {
    model.text = "The JSON restore was incomplete. Opened tabs were kept, but some tabs or group metadata could not be restored. " +
      "Automatic file backups are paused to preserve earlier versions. Review the opened workspaces and Backup history before dismissing this warning.";
    model.acknowledgeLabel = "Reviewed - resume backups";
    return model;
  }

  if (payload.reason === "primary-window-closed") {
    const counts = isFiniteNum(payload.hiddenTabCount) && isFiniteNum(payload.hiddenWspCount)
      ? ` with ${payload.hiddenTabCount} hidden tab(s) in ${payload.hiddenWspCount} inactive workspace(s)`
      : " while it held inactive workspace tabs";
    model.text = `The primary window closed at ${whenText}${counts}. ` +
      `Use "Reopen window" to try restoring it and its workspaces from Firefox's Recently Closed Windows. ` +
      `You can also check History > Recently closed windows in Firefox.`;
    model.canReopen = true;
    return model;
  }

  const wspCount = isFiniteNum(payload.wspCount) ? payload.wspCount : "?";
  const urlCount = isFiniteNum(payload.snapshotUrlCount) ? payload.snapshotUrlCount : "?";
  const exportedUrls = isFiniteNum(payload.exportedUrls) ? payload.exportedUrls : null;
  const exportedNote = folders => {
    if (payload.backupFormat !== "json") {
      return folders > 0
        ? "An earlier version reported a bookmarks backup. Those existing bookmarks can still be opened from Firefox's bookmarks menu. "
        : "No earlier backup was confirmed. Check Backup history for available JSON files. ";
    }
    if (folders <= 0) return "No new JSON backup could be saved. ";
    const counts = exportedUrls != null && exportedUrls !== urlCount
      ? `${exportedUrls} of ${urlCount} URL(s)` : `${urlCount} URL(s)`;
    return `The saved tab lists (${counts}) were saved as JSON files. ` +
      `Use "Backup history" to reopen them. `;
  };

  if (payload.reason === "session-not-restored" || payload.reason === "tabs-closed-at-startup") {
    // Missing tabs do not establish when or why they closed. Legacy payloads
    // describe past automatic recovery without authorizing another recovery.
    const exported = isFiniteNum(payload.exportedWorkspaces) ? payload.exportedWorkspaces : 0;
    const restoredCount = isFiniteNum(payload.restoredCount) ? payload.restoredCount : 0;
    const outcome = payload.reason === "tabs-closed-at-startup"
      ? (restoredCount > 0
        ? `An earlier automatic recovery reopened ${restoredCount} tab(s). `
        : "An earlier automatic recovery did not report any reopened tabs. ")
      : "Closed tabs were not reopened automatically. ";
    model.text =
      `Workspace tabs were not fully restored when the browser started at ${whenText}. ` +
      `Saved tab lists for ${wspCount} workspace(s) contained ${urlCount} URL(s). ` +
      outcome + exportedNote(exported) +
      `Review the saved lists before restoring - they may include tabs you intentionally closed. ` +
      `You can also check History > Recently closed tabs in Firefox.`;
    return model;
  }

  if (payload.reason === "phase4-failure") {
    model.text = `A previous restore attempt failed mid-way at ${whenText}. ` +
      "Recovery did not complete. Restart Firefox to retry before making workspace changes.";
    model.acknowledgeTitle = "Dismiss this banner. The next Firefox restart will retry the restore.";
    model.canGiveUp = true;
    return model;
  }

  // Keep the paused-restore presentation for older payloads and unknown
  // reasons, including the existing Give up confirmation flow.
  const reason = `Workspace restore was paused at ${whenText} to prevent data loss.`;
  const lossNote = payload.sessionLost === true
    ? ` Some workspace tabs were missing during startup. ` +
      exportedNote(isFiniteNum(payload.exportedWorkspaces) ? payload.exportedWorkspaces : 0)
    : " Try restarting Firefox to retry the restore. ";
  model.text = `${reason} ${wspCount} workspace(s) had ${urlCount} previously open URL(s) recorded. ` +
    "User data was left untouched." + lossNote +
    `Use "Give up" only if you no longer need the workspaces from before the failed restart.`;
  model.acknowledgeTitle = "Dismiss this banner. The next Firefox restart will retry the restore.";
  model.canGiveUp = true;
  return model;
}
