// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichNotice } from "../../src/webview/richNotice.js";
let notice: RichNotice | undefined;
afterEach(() => {
  notice?.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});
describe("ordinary notice lifecycle", () => {
  it("expires after four seconds, deduplicates, and does not take focus", () => {
    vi.useFakeTimers();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    notice = new RichNotice();
    notice.show("案内");
    expect(document.activeElement).toBe(input);
    const first = document.querySelector(".markdown-rich-notice");
    notice.show("案内");
    expect(document.querySelector(".markdown-rich-notice")).toBe(first);
    vi.advanceTimersByTime(3999);
    expect(first?.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(first?.isConnected).toBe(false);
  });
  it("old timers cannot clear newer notices; hover and focus pause expiry", () => {
    vi.useFakeTimers();
    notice = new RichNotice();
    notice.show("古い案内");
    vi.advanceTimersByTime(3000);
    notice.show("新しい案内");
    vi.advanceTimersByTime(1000);
    const element = document.querySelector<HTMLElement>(".markdown-rich-notice");
    expect(element?.textContent).toContain("新しい案内");
    element?.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(10000);
    expect(element?.isConnected).toBe(true);
    element?.dispatchEvent(new MouseEvent("mouseleave"));
    element?.querySelector("button")?.focus();
    vi.advanceTimersByTime(5000);
    expect(element?.isConnected).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(element?.isConnected).toBe(false);
  });
  it("dispose removes timer/listener and cannot update again or remove protection warnings", () => {
    vi.useFakeTimers();
    const protection = document.createElement("div");
    protection.id = "editor-status";
    protection.textContent = "保護警告";
    document.body.append(protection);
    notice = new RichNotice();
    notice.show("通常案内");
    notice.dispose();
    notice.show("後発");
    vi.runAllTimers();
    expect(document.querySelector(".markdown-rich-notice")).toBeNull();
    expect(protection.isConnected).toBe(true);
  });
  it("resumes expiry after keyboard focus leaves the notice", async () => {
    vi.useFakeTimers();
    notice = new RichNotice();
    notice.show("案内");
    const element = document.querySelector<HTMLElement>(".markdown-rich-notice");
    element?.querySelector("button")?.focus();
    vi.advanceTimersByTime(5000);
    expect(element?.isConnected).toBe(true);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await Promise.resolve();
    vi.advanceTimersByTime(4000);
    expect(element?.isConnected).toBe(false);
  });
});
