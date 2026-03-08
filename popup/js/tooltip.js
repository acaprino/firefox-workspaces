/* ============================================================
   Tab Preview Tooltip
   ============================================================ */

let _tooltipIdCounter = 0;

class TabPreviewTooltip {
  constructor(callBackgroundTask) {
    this._callBackgroundTask = callBackgroundTask;
    this._timeout = null;
    this._el = null;
  }

  attach(li, wspId, getDragState) {
    li.addEventListener("mouseenter", () => {
      // Don't show tooltip during drag operations
      if (getDragState()) return;

      this._timeout = setTimeout(async () => {
        const result = await this._callBackgroundTask("getTabPreviews", {
          wspId: wspId,
          limit: 15
        });
        if (!result || result.previews.length === 0) return;
        // Check if mouse has already left (timeout cleared)
        if (this._timeout === null) return;

        // Guard against race condition on rapid hover
        if (this._el && this._el.parentElement) {
          this._el.remove();
          this._el = null;
        }

        this._el = document.createElement("div");
        this._el.classList.add("wsp-tab-preview");

        for (const title of result.previews) {
          const row = document.createElement("div");
          row.classList.add("wsp-tab-preview-row");
          row.textContent = title;
          this._el.appendChild(row);
        }

        // Append to body so it's not clipped by .container overflow
        const liRect = li.getBoundingClientRect();
        this._el.style.position = "fixed";
        this._el.style.left = `${liRect.left + 6}px`;
        this._el.style.right = "6px";

        // Temporarily place offscreen to measure height
        this._el.style.visibility = "hidden";
        document.body.appendChild(this._el);
        const tooltipHeight = this._el.offsetHeight;
        this._el.style.visibility = "";

        // Place below or above, clamped to viewport
        const spaceBelow = window.innerHeight - liRect.bottom - 6;
        const spaceAbove = liRect.top - 6;

        if (spaceBelow >= tooltipHeight) {
          this._el.style.top = `${liRect.bottom + 2}px`;
        } else if (spaceAbove >= tooltipHeight) {
          this._el.style.top = `${liRect.top - tooltipHeight - 2}px`;
          this._el.classList.add("above");
        } else if (spaceBelow >= spaceAbove) {
          this._el.style.top = `${liRect.bottom + 2}px`;
          this._el.style.maxHeight = `${spaceBelow}px`;
        } else {
          this._el.style.top = "6px";
          this._el.style.maxHeight = `${spaceAbove}px`;
          this._el.classList.add("above");
        }

        // Scroll-fade indicators for overflowing tooltip
        const updateScrollFades = () => {
          const el = this._el;
          if (!el) return;
          const atTop = el.scrollTop > 2;
          const atBottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
          el.classList.toggle("scroll-top", atTop);
          el.classList.toggle("scroll-bottom", atBottom);
        };
        if (this._el.scrollHeight > this._el.clientHeight) {
          this._el.classList.add("scrollable");
          this._el.addEventListener("scroll", updateScrollFades, { passive: true });
          updateScrollFades();
        }

        // Accessibility
        const tooltipId = `wsp-preview-tooltip-${++_tooltipIdCounter}`;
        this._el.setAttribute("role", "tooltip");
        li.setAttribute("aria-describedby", tooltipId);
        this._el.id = tooltipId;
      }, 300);
    });

    li.addEventListener("mouseleave", () => {
      clearTimeout(this._timeout);
      this._timeout = null;
      li.removeAttribute("aria-describedby");

      if (this._el && this._el.parentElement) {
        const el = this._el;
        this._el = null;
        el.classList.add("exiting");
        el.addEventListener("animationend", () => el.remove(), { once: true });
        // Fallback removal if animation doesn't fire (reduced-motion)
        setTimeout(() => { if (el.parentElement) el.remove(); }, 150);
      }
    });
  }
}
