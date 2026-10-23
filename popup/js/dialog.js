/* ============================================================
   Icon Picker Data (Fluent UI System Icons)
   ============================================================ */

const WORKSPACE_ICONS = [
  "briefcase", "home", "games", "music", "book", "laptop", "beaker", "paint-brush",
  "mail", "cart", "money", "graduation", "airplane", "food", "flash", "lock",
  "globe", "phone", "target", "rocket", "heart", "star", "fire", "lightbulb",
  "document", "folder", "database", "chart", "wrench", "video", "camera", "code",
];

const WORKSPACE_COLORS = [
  { name: "blue",      hex: "#37adff" },
  { name: "turquoise", hex: "#00c79a" },
  { name: "green",     hex: "#51cd00" },
  { name: "yellow",    hex: "#ffcb00" },
  { name: "orange",    hex: "#ff9f00" },
  { name: "red",       hex: "#ff613d" },
  { name: "pink",      hex: "#ff4bda" },
  { name: "purple",    hex: "#af51f5" },
];

const ICON_BASE_PATH = "img/workspace-icons/";

function _initIconPicker() {
  const grid = document.getElementById("icon-grid");
  if (grid.children.length > 0) return; // already initialized

  for (const icon of WORKSPACE_ICONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.icon = icon;

    const img = document.createElement("img");
    img.src = `${ICON_BASE_PATH}${icon}.svg`;
    img.alt = icon;
    img.draggable = false;
    btn.appendChild(img);

    grid.appendChild(btn);
  }
}

function _createIconElement(iconName, className) {
  const img = document.createElement("img");
  img.src = `${ICON_BASE_PATH}${iconName}.svg`;
  img.alt = iconName;
  img.classList.add(className);
  img.draggable = false;
  return img;
}

/* ============================================================
   Custom Dialog (with Container picker support)
   ============================================================ */

// Resolves false on Cancel / Escape. On OK: the form values, or true for a
// plain confirmation or an `infoOnly` notice (a single OK button).
function showCustomDialog({ message, withInput = false, defaultValue = "", defaultIcon = "", showContainerPicker = false, defaultContainerId = null, containers = [], showColorPicker = false, defaultColor = null, showCheckbox = false, checkboxLabel = "", checkboxDefault = false, showFolderPicker = false, folders = [], infoOnly = false }) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById("custom-dialog-backdrop");
    const msgEl = document.getElementById("custom-dialog-message");
    const inputRow = document.getElementById("custom-dialog-input-row");
    const inputEl = document.getElementById("custom-dialog-input");
    const iconBtn = document.getElementById("custom-dialog-icon-btn");
    const iconPicker = document.getElementById("icon-picker");
    const iconGrid = document.getElementById("icon-grid");
    const iconClearBtn = document.getElementById("icon-clear-btn");
    const containerRow = document.getElementById("custom-dialog-container-row");
    const containerSelect = document.getElementById("custom-dialog-container-select");
    const colorRow = document.getElementById("custom-dialog-color-row");
    const colorSwatches = document.getElementById("color-swatches");
    const checkboxRow = document.getElementById("custom-dialog-checkbox-row");
    const checkboxEl = document.getElementById("custom-dialog-checkbox");
    const checkboxLabelEl = document.getElementById("custom-dialog-checkbox-label");
    const folderRow = document.getElementById("custom-dialog-folder-row");
    const folderSelect = document.getElementById("custom-dialog-folder-select");
    const okBtn = document.getElementById("custom-dialog-ok");
    const cancelBtn = document.getElementById("custom-dialog-cancel");
    const footerEl = backdrop.querySelector(".custom-dialog-footer");

    _initIconPicker();

    msgEl.textContent = message;
    inputRow.hidden = !withInput;
    inputEl.value = defaultValue;
    // A notice has nothing to cancel: a lone OK button.
    cancelBtn.hidden = infoOnly;

    // Container picker setup
    containerRow.hidden = !showContainerPicker;
    if (showContainerPicker) {
      containerSelect.innerHTML = "";
      const noneOpt = document.createElement("option");
      noneOpt.value = "";
      noneOpt.textContent = "None";
      containerSelect.appendChild(noneOpt);
      for (const c of containers) {
        const opt = document.createElement("option");
        opt.value = c.cookieStoreId;
        opt.textContent = c.name;
        opt.style.color = c.colorCode || "";
        if (c.cookieStoreId === defaultContainerId) opt.selected = true;
        containerSelect.appendChild(opt);
      }
    }

    // Color picker setup
    colorRow.hidden = !showColorPicker;
    let selectedColor = defaultColor || null;
    if (showColorPicker) {
      colorSwatches.innerHTML = "";
      for (const c of WORKSPACE_COLORS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.classList.add("color-swatch");
        btn.dataset.color = c.hex;
        btn.style.backgroundColor = c.hex;
        btn.title = c.name;
        btn.setAttribute("role", "radio");
        btn.setAttribute("aria-label", c.name);
        const isSelected = c.hex === selectedColor;
        btn.setAttribute("aria-checked", String(isSelected));
        if (isSelected) btn.classList.add("selected");
        colorSwatches.appendChild(btn);
      }
      // "Remove color" button
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.classList.add("color-swatch", "color-swatch-remove");
      removeBtn.title = "Remove color";
      removeBtn.setAttribute("role", "radio");
      removeBtn.setAttribute("aria-label", "Remove color");
      const noColor = !selectedColor;
      removeBtn.setAttribute("aria-checked", String(noColor));
      if (noColor) removeBtn.classList.add("selected");
      colorSwatches.appendChild(removeBtn);
    }

    // Checkbox setup
    checkboxRow.hidden = !showCheckbox;
    if (showCheckbox) {
      checkboxEl.checked = checkboxDefault;
      checkboxLabelEl.textContent = checkboxLabel;
    }

    // Folder picker setup
    folderRow.hidden = !showFolderPicker;
    if (showFolderPicker) {
      folderSelect.innerHTML = "";
      for (const f of folders) {
        const opt = document.createElement("option");
        opt.value = f.id;
        opt.textContent = `${f.title} (${f.bookmarkCount} tabs)`;
        folderSelect.appendChild(opt);
      }
    }

    // Initialize icon state (scoped to this dialog invocation)
    let selectedIcon = defaultIcon || "";
    _updateIconBtn(iconBtn, selectedIcon);
    iconPicker.classList.remove("open");
    // The collapsed picker is only visually hidden (max-height: 0), so keep
    // its 33 buttons out of the Tab order and the accessibility tree.
    iconPicker.inert = true;
    iconBtn.classList.remove("picker-open");
    iconBtn.setAttribute("aria-expanded", "false");

    // Clear previous selection highlights
    for (const btn of iconGrid.children) {
      const isSel = btn.dataset.icon === selectedIcon;
      btn.classList.toggle("selected", isSel);
      btn.setAttribute("aria-pressed", String(isSel));
    }

    updateOkButtonState();

    // Expand popup viewport so Firefox doesn't clip the dialog
    function syncPopupHeight() {
      if (showFolderPicker) {
        document.body.style.minHeight = "180px";
        return;
      }
      if (showCheckbox) {
        // Grow for a long message (the diagnostics notice) so the checkbox
        // and the buttons stay in view.
        let minHeight = 180;
        if (backdrop.classList.contains("show")) {
          const bodyEl = backdrop.querySelector(".custom-dialog-body");
          const need = Math.ceil(msgEl.offsetHeight + bodyEl.scrollHeight + footerEl.offsetHeight);
          if (Number.isFinite(need)) minHeight = Math.max(minHeight, need);
        }
        document.body.style.minHeight = `${minHeight}px`;
        return;
      }
      if (!withInput) {
        // Grow for long messages (the Give up warning keeps its paragraph
        // breaks) so the buttons stay in view. Measured at natural height,
        // not at the flex-stretched height of the current viewport.
        let minHeight = 140;
        if (backdrop.classList.contains("show")) {
          msgEl.style.flex = "none";
          const need = Math.ceil(msgEl.offsetHeight + footerEl.offsetHeight);
          msgEl.style.flex = "";
          if (Number.isFinite(need)) minHeight = Math.max(minHeight, need);
        }
        document.body.style.minHeight = `${minHeight}px`;
        return;
      }
      const pickerOpen = iconPicker.classList.contains("open");
      document.body.style.minHeight = pickerOpen ? "520px" : "280px";
    }

    // Toggle confirm mode class for delete dialogs (no body content)
    const dialog = backdrop.querySelector(".custom-dialog");
    const hasBody = withInput || showCheckbox || showFolderPicker;
    if (hasBody) {
      dialog.classList.remove("dialog-confirm");
    } else {
      dialog.classList.add("dialog-confirm");
    }
    // Forms are dialogs; confirmations and notices interrupt, so they are
    // alert dialogs (wsp.html sets aria-modal and the message as the label).
    dialog.setAttribute("role", hasBody ? "dialog" : "alertdialog");

    // Remember the control that opened the dialog: the list behind it goes
    // display:none, and focus must return there when the dialog closes.
    const returnFocusTo = document.activeElement;
    let closed = false;

    backdrop.classList.add("show");
    syncPopupHeight();

    // Move focus into the dialog. Confirmations start on Cancel, so a stray
    // Enter cannot delete a workspace, give up the restore retry or close a
    // workspace after export; notices start on their only button.
    if (withInput) {
      requestAnimationFrame(() => {
        if (closed) return;
        inputEl.focus();
        inputEl.select();
      });
    } else if (showFolderPicker) {
      folderSelect.focus();
    } else {
      (infoOnly ? okBtn : cancelBtn).focus();
    }

    function _updateIconBtn(btn, iconName) {
      btn.innerHTML = "";
      if (iconName) {
        const img = document.createElement("img");
        img.src = `${ICON_BASE_PATH}${iconName}.svg`;
        img.alt = iconName;
        img.draggable = false;
        btn.appendChild(img);
        btn.classList.add("has-icon");
      } else {
        // Default placeholder icon (briefcase outline)
        const img = document.createElement("img");
        img.src = `${ICON_BASE_PATH}briefcase.svg`;
        img.alt = "Choose icon";
        img.draggable = false;
        btn.appendChild(img);
        btn.classList.remove("has-icon");
      }
    }

    function setIcon(icon) {
      selectedIcon = icon;
      _updateIconBtn(iconBtn, icon);
      for (const btn of iconGrid.children) {
        const isSel = btn.dataset.icon === icon;
        btn.classList.toggle("selected", isSel);
        btn.setAttribute("aria-pressed", String(isSel));
      }
    }

    function closePicker() {
      iconPicker.classList.remove("open");
      iconPicker.inert = true;
      iconBtn.classList.remove("picker-open");
      iconBtn.setAttribute("aria-expanded", "false");
      syncPopupHeight();
    }

    function onIconBtn(e) {
      e.stopPropagation();
      const isOpen = iconPicker.classList.toggle("open");
      iconPicker.inert = !isOpen;
      iconBtn.classList.toggle("picker-open", isOpen);
      iconBtn.setAttribute("aria-expanded", String(isOpen));
      syncPopupHeight();
    }

    function onIconGridClick(e) {
      const btn = e.target.closest("button[data-icon]");
      if (!btn) return;
      setIcon(btn.dataset.icon);
      closePicker();
      inputEl.focus();
    }

    function onIconClear() {
      setIcon("");
      closePicker();
      inputEl.focus();
    }

    function onColorSwatchClick(e) {
      const btn = e.target.closest("button.color-swatch");
      if (!btn) return;
      if (btn.classList.contains("color-swatch-remove")) {
        selectedColor = null;
      } else {
        selectedColor = btn.dataset.color;
      }
      for (const s of colorSwatches.children) {
        const isSel = s === btn;
        s.classList.toggle("selected", isSel);
        s.setAttribute("aria-checked", String(isSel));
      }
    }

    function cleanup(result) {
      closed = true;
      // Remove listeners immediately to prevent double-fire
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      inputEl.removeEventListener("input", updateOkButtonState);
      document.removeEventListener("keydown", onKeyDown);
      iconBtn.removeEventListener("click", onIconBtn);
      iconGrid.removeEventListener("click", onIconGridClick);
      iconClearBtn.removeEventListener("click", onIconClear);
      colorSwatches.removeEventListener("click", onColorSwatchClick);

      // Exit animation
      backdrop.classList.add("hiding");
      function onAnimEnd() {
        backdrop.removeEventListener("animationend", onAnimEnd);
        backdrop.classList.remove("show", "hiding");
        dialog.classList.remove("dialog-confirm");
        closePicker();
        document.body.style.minHeight = "";
        // The list is displayed again, so its controls can take focus back.
        if (returnFocusTo && returnFocusTo !== document.body &&
            returnFocusTo.isConnected && !backdrop.contains(returnFocusTo)) {
          returnFocusTo.focus();
        }
        resolve(result);
      }
      backdrop.addEventListener("animationend", onAnimEnd);

      // Fallback if animation is skipped (reduced motion)
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (prefersReducedMotion) {
        backdrop.removeEventListener("animationend", onAnimEnd);
        onAnimEnd();
      }
    }

    function onOk() {
      if (withInput) {
        const result = { name: inputEl.value, icon: selectedIcon, color: selectedColor };
        if (showContainerPicker) {
          result.containerId = containerSelect.value || null;
        }
        cleanup(result);
      } else if (showFolderPicker) {
        cleanup({ folderId: folderSelect.value });
      } else if (showCheckbox) {
        cleanup({ confirmed: true, checked: checkboxEl.checked });
      } else {
        cleanup(true);
      }
    }

    function onCancel() {
      cleanup(false);
    }

    function updateOkButtonState() {
      if (withInput) {
        okBtn.disabled = inputEl.value.trim().length === 0;
      } else if (showFolderPicker) {
        okBtn.disabled = folders.length === 0;
      } else {
        okBtn.disabled = false;
      }
    }

    // This document listener runs before the browser turns Enter on a
    // focused button into a click, so Enter confirms only from the name
    // field or a non-interactive target. On Cancel, OK, a swatch, the icon
    // button, the checkbox or a select the control's own action runs instead
    // (confirming here made Enter on Cancel delete the workspace).
    function onKeyDown(e) {
      // Keys that commit or cancel an IME composition belong to the IME.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") {
        // Auto-repeat of the Enter that opened the dialog must not act on it.
        if (e.repeat) {
          e.preventDefault();
          return;
        }
        const t = e.target;
        if (t !== inputEl && typeof t?.closest === "function" &&
            t.closest("button, input, select, textarea, a[href], [role=button], [role=radio]")) {
          return;
        }
        e.preventDefault();
        if (!okBtn.disabled) onOk();
      } else if (e.key === "Escape") {
        if (iconPicker.classList.contains("open")) {
          closePicker();
          iconBtn.focus();
        } else {
          onCancel();
        }
      }
    }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    inputEl.addEventListener("input", updateOkButtonState);
    document.addEventListener("keydown", onKeyDown);
    iconBtn.addEventListener("click", onIconBtn);
    iconGrid.addEventListener("click", onIconGridClick);
    iconClearBtn.addEventListener("click", onIconClear);
    colorSwatches.addEventListener("click", onColorSwatchClick);
  });
}
