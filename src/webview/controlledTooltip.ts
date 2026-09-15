/** A small tooltip for extension-owned controls whose placement we can guarantee. */
export interface ControlledTooltip {
  attach(target: HTMLElement, label: string): void;
  hide(): void;
  reposition(): void;
  destroy(): void;
}

const GAP = 14;
const VIEWPORT_MARGIN = 8;

export function createControlledTooltip(container: HTMLElement): ControlledTooltip {
  const document = container.ownerDocument;
  const tooltip = document.createElement("div");
  tooltip.className = "cm-controlled-tooltip";
  tooltip.id = `cm-controlled-tooltip-${String(nextId++)}`;
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  Object.assign(tooltip.style, {
    position: "fixed",
    boxSizing: "border-box",
    zIndex: "30",
    maxWidth: "min(320px, calc(100vw - 16px))",
    overflow: "auto",
    pointerEvents: "none",
    padding: "4px 6px",
    color: "var(--vscode-editorHoverWidget-foreground, inherit)",
    background: "var(--vscode-editorHoverWidget-background, #252526)",
    border: "1px solid var(--vscode-editorHoverWidget-border, #888)",
    font: "12px var(--vscode-font-family, sans-serif)",
  });
  container.append(tooltip);
  let active: HTMLElement | undefined;
  let pointerOver: HTMLElement | undefined;
  let keyboardFocused: HTMLElement | undefined;

  const hide = (): void => {
    if (pointerOver || keyboardFocused) return;
    tooltip.hidden = true;
    active = undefined;
  };
  const place = (): void => {
    if (!active || tooltip.hidden) return;
    const anchor = active.getBoundingClientRect();
    tooltip.style.maxHeight = "";
    const natural = tooltip.getBoundingClientRect();
    const aboveRoom = anchor.top - VIEWPORT_MARGIN - GAP;
    const belowRoom = window.innerHeight - anchor.bottom - VIEWPORT_MARGIN - GAP;
    const above = aboveRoom >= natural.height || aboveRoom >= belowRoom;
    const room = Math.max(0, above ? aboveRoom : belowRoom);
    tooltip.style.maxHeight = `${String(Math.max(20, room))}px`;
    const measured = tooltip.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        anchor.left + (anchor.width - measured.width) / 2,
        window.innerWidth - measured.width - VIEWPORT_MARGIN,
      ),
    );
    const top = above
      ? Math.max(VIEWPORT_MARGIN, anchor.top - GAP - measured.height)
      : Math.min(window.innerHeight - measured.height - VIEWPORT_MARGIN, anchor.bottom + GAP);
    tooltip.dataset["side"] = above ? "above" : "below";
    Object.assign(tooltip.style, { left: `${String(left)}px`, top: `${String(top)}px` });
  };
  const show = (target: HTMLElement, label: string): void => {
    active = target;
    tooltip.textContent = label;
    tooltip.hidden = false;
    place();
  };
  const reposition = (): void => {
    place();
  };
  const clearForWindowBlur = (): void => {
    pointerOver = keyboardFocused = undefined;
    hide();
  };
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("blur", clearForWindowBlur);

  return {
    reposition,
    attach(target, label) {
      target.removeAttribute("title");
      target.setAttribute("aria-describedby", tooltip.id);
      target.addEventListener("pointerenter", () => {
        // A mouse click focuses its button too.  Keep that focus from turning a
        // pointer tooltip into a keyboard tooltip which would linger after leave.
        if (keyboardFocused === target) keyboardFocused = undefined;
        pointerOver = target;
        show(target, label);
      });
      target.addEventListener("pointerleave", () => {
        if (pointerOver === target) pointerOver = undefined;
        hide();
      });
      target.addEventListener("focus", () => {
        if (pointerOver !== target) {
          keyboardFocused = target;
          show(target, label);
        }
      });
      target.addEventListener("blur", () => {
        if (keyboardFocused === target) keyboardFocused = undefined;
        hide();
      });
    },
    hide() {
      pointerOver = keyboardFocused = undefined;
      hide();
    },
    destroy() {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("blur", clearForWindowBlur);
      tooltip.remove();
      active = undefined;
      pointerOver = keyboardFocused = undefined;
    },
  };
}

let nextId = 1;
