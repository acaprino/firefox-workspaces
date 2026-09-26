/* ============================================================
   Drag & Drop Handler for Workspace List
   ============================================================ */

class DragDropHandler {
  constructor(callBackgroundTask, currentWindowId) {
    this._callBackgroundTask = callBackgroundTask;
    this._currentWindowId = currentWindowId;
    this.dragSrcEl = null;
  }

  // A drop is a reorder only when the drag started on a workspace row of
  // this list. Anything else (a footer link, selected text, a file from the
  // desktop) is refused: no drop effect, no drop, and no `li.after(null)`
  // inserting a literal "null" text node.
  _isRowDrag() {
    const src = this.dragSrcEl;
    return !!src && src.isConnected && src.matches("#wsp-list > li.wsp-list-item");
  }

  _rows() {
    return [...document.getElementById("wsp-list").querySelectorAll("li.wsp-list-item")];
  }

  // Dropping on `li` puts the dragged row after it when moving down, before
  // it when moving up. The drop line marks that side.
  _movesDown(li) {
    const rows = this._rows();
    return rows.indexOf(this.dragSrcEl) < rows.indexOf(li);
  }

  attach(li, wspId) {
    li.addEventListener("dragstart", (e) => {
      this.dragSrcEl = li;
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", wspId.toString());
    });

    li.addEventListener("dragover", (e) => {
      if (!this._isRowDrag()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (li !== this.dragSrcEl) {
        li.classList.add("drag-over");
        li.classList.toggle("drag-over-below", this._movesDown(li));
      }
    });

    li.addEventListener("dragleave", () => {
      li.classList.remove("drag-over", "drag-over-below");
    });

    li.addEventListener("drop", async (e) => {
      if (!this._isRowDrag()) return;
      e.preventDefault();
      li.classList.remove("drag-over", "drag-over-below");
      const src = this.dragSrcEl;
      if (src === li) return;

      const previous = this._order();
      if (this._movesDown(li)) {
        li.after(src);
      } else {
        li.before(src);
      }

      await this._saveOrder(previous);
    });

    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over", "drag-over-below"));
      this.dragSrcEl = null;
    });
  }

  // Keyboard alternative to dragging (Alt+Up / Alt+Down on a row): swap the
  // row with its neighbour and save. The neighbour is the node that moves,
  // so the row keeps keyboard focus (moving a focused node drops focus).
  async moveBy(li, delta) {
    const sibling = delta < 0 ? li.previousElementSibling : li.nextElementSibling;
    if (!sibling || !sibling.classList.contains("wsp-list-item")) return;
    const previous = this._order();
    if (delta < 0) {
      li.after(sibling);
    } else {
      li.before(sibling);
    }
    await this._saveOrder(previous);
  }

  _order() {
    return this._rows().map(el => el.dataset.wspId);
  }

  // Save the new order. If the background refuses or fails (the popup
  // already said why), put the rows back in `previous` order, so the list
  // shows the order that is actually stored.
  async _saveOrder(previous) {
    // wspIds are UUID strings -- do NOT coerce to Number
    const result = await this._callBackgroundTask("saveWorkspaceOrder", {
      windowId: this._currentWindowId,
      orderedIds: this._order()
    });
    // _callBackgroundTask resolves null only on failure.
    if (result === null) this._restoreOrder(previous);
  }

  _restoreOrder(ids) {
    const wspList = document.getElementById("wsp-list");
    const byId = new Map(this._rows().map(el => [el.dataset.wspId, el]));
    // Re-inserting a node drops its focus; give it back.
    const focused = document.activeElement;
    for (const id of ids) {
      const row = byId.get(id);
      if (row) wspList.appendChild(row);
    }
    if (focused && focused !== document.activeElement && focused.isConnected) focused.focus();
  }
}
