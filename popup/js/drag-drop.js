/* ============================================================
   Drag & Drop Handler for Workspace List
   ============================================================ */

class DragDropHandler {
  constructor(callBackgroundTask, currentWindowId) {
    this._callBackgroundTask = callBackgroundTask;
    this._currentWindowId = currentWindowId;
    this.dragSrcEl = null;
  }

  attach(li, wspId) {
    li.addEventListener("dragstart", (e) => {
      this.dragSrcEl = li;
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", wspId.toString());
    });

    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (li !== this.dragSrcEl) {
        li.classList.add("drag-over");
      }
    });

    li.addEventListener("dragleave", () => {
      li.classList.remove("drag-over");
    });

    li.addEventListener("drop", async (e) => {
      e.preventDefault();
      li.classList.remove("drag-over");
      if (this.dragSrcEl === li) return;

      const wspList = document.getElementById("wsp-list");
      const items = [...wspList.querySelectorAll("li.wsp-list-item")];
      const fromIdx = items.indexOf(this.dragSrcEl);
      const toIdx = items.indexOf(li);

      if (fromIdx < toIdx) {
        li.after(this.dragSrcEl);
      } else {
        li.before(this.dragSrcEl);
      }

      await this._saveOrder();
    });

    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
      this.dragSrcEl = null;
    });
  }

  // Keyboard alternative to dragging (Alt+Up / Alt+Down on a row): swap the
  // row with its neighbour and save. The neighbour is the node that moves,
  // so the row keeps keyboard focus (moving a focused node drops focus).
  async moveBy(li, delta) {
    const sibling = delta < 0 ? li.previousElementSibling : li.nextElementSibling;
    if (!sibling || !sibling.classList.contains("wsp-list-item")) return;
    if (delta < 0) {
      li.after(sibling);
    } else {
      li.before(sibling);
    }
    await this._saveOrder();
  }

  async _saveOrder() {
    // Save new order (wspIds are UUID strings -- do NOT coerce to Number)
    const wspList = document.getElementById("wsp-list");
    const newOrder = [...wspList.querySelectorAll("li.wsp-list-item")].map(
      el => el.dataset.wspId
    );
    await this._callBackgroundTask("saveWorkspaceOrder", {
      windowId: this._currentWindowId,
      orderedIds: newOrder
    });
  }
}
