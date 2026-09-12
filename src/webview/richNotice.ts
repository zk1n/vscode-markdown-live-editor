/** Short-lived operational notices. Data-protection warnings have a separate owner. */
export class RichNotice {
  private element: HTMLElement | undefined;
  private timer: number | undefined;
  private lastNote = "";
  private lastShown = 0;
  private disposed = false;
  private hovered = false;
  private readonly escape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.close();
  };
  public show(note: string): void {
    if (this.disposed || (note === this.lastNote && Date.now() - this.lastShown < 4000)) return;
    this.close();
    this.lastNote = note;
    this.lastShown = Date.now();
    const element = document.createElement("div");
    element.className = "markdown-rich-notice";
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    const text = document.createElement("span");
    text.textContent = note;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "通知を閉じる");
    close.addEventListener("click", () => {
      this.close();
    });
    element.append(text, close);
    element.addEventListener("mouseenter", () => {
      this.hovered = true;
      this.clearTimer();
    });
    element.addEventListener("mouseleave", () => {
      this.hovered = false;
      this.schedule();
    });
    element.addEventListener("focusin", () => {
      this.clearTimer();
    });
    element.addEventListener("focusout", () => {
      queueMicrotask(() => {
        if (!this.disposed && this.element === element) this.schedule();
      });
    });
    this.element = element;
    document.body.append(element);
    window.addEventListener("keydown", this.escape);
    this.schedule();
  }
  private clearTimer(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule(): void {
    this.clearTimer();
    if (this.hovered || this.element?.contains(document.activeElement) === true) return;
    this.timer = window.setTimeout(() => {
      this.close();
    }, 4000);
  }
  public close(): void {
    this.clearTimer();
    this.element?.remove();
    this.element = undefined;
    this.hovered = false;
    window.removeEventListener("keydown", this.escape);
  }
  public dispose(): void {
    this.disposed = true;
    this.close();
  }
}
