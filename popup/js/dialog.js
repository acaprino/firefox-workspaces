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

function showCustomDialog({ message, withInput = false, defaultValue = "", defaultIcon = "", showContainerPicker = false, defaultContainerId = null, containers = [], showColorPicker = false, defaultColor = null }) {
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
    const okBtn = document.getElementById("custom-dialog-ok");
    const cancelBtn = document.getElementById("custom-dialog-cancel");

    _initIconPicker();

    msgEl.textContent = message;
    inputRow.hidden = !withInput;
    inputEl.value = defaultValue;

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

    // Initialize icon state (scoped to this dialog invocation)
    let selectedIcon = defaultIcon || "";
    _updateIconBtn(iconBtn, selectedIcon);
    iconPicker.classList.remove("open");
    iconBtn.classList.remove("picker-open");

    // Clear previous selection highlights
    for (const btn of iconGrid.children) {
      btn.classList.toggle("selected", btn.dataset.icon === selectedIcon);
    }

    updateOkButtonState();

    // Expand popup viewport so Firefox doesn't clip the dialog
    function syncPopupHeight() {
      if (!withInput) {
        document.body.style.minHeight = "140px";
        return;
      }
      const pickerOpen = iconPicker.classList.contains("open");
      document.body.style.minHeight = pickerOpen ? "520px" : "280px";
    }

    // Toggle confirm mode class for delete dialogs
    const dialog = backdrop.querySelector(".custom-dialog");
    if (withInput) {
      dialog.classList.remove("dialog-confirm");
    } else {
      dialog.classList.add("dialog-confirm");
    }

    syncPopupHeight();
    backdrop.classList.add("show");

    if (withInput) {
      requestAnimationFrame(() => {
        inputEl.focus();
        inputEl.select();
      });
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
        btn.classList.toggle("selected", btn.dataset.icon === icon);
      }
    }

    function closePicker() {
      iconPicker.classList.remove("open");
      iconBtn.classList.remove("picker-open");
      syncPopupHeight();
    }

    function onIconBtn(e) {
      e.stopPropagation();
      const isOpen = iconPicker.classList.toggle("open");
      iconBtn.classList.toggle("picker-open", isOpen);
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
      } else {
        cleanup(true);
      }
    }

    function onCancel() {
      cleanup(false);
    }

    function updateOkButtonState() {
      okBtn.disabled = withInput && inputEl.value.trim().length === 0;
    }

    function onKeyDown(e) {
      if (e.key === "Enter" && !okBtn.disabled) {
        onOk();
      } else if (e.key === "Escape") {
        if (iconPicker.classList.contains("open")) {
          closePicker();
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
