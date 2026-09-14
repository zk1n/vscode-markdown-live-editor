// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createControlledTooltip } from "../../src/webview/controlledTooltip.js";

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

afterEach(() => {
  document.body.replaceChildren();
});

describe("controlled tooltip", () => {
  it("uses an accessible upper placement with a 14px gap", () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    target.title = "native";
    host.append(target);
    document.body.append(host);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 300 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    target.getBoundingClientRect = () => rect(100, 100, 40, 20);
    const tooltip = createControlledTooltip(host);
    const element = host.querySelector<HTMLElement>(".cm-controlled-tooltip");
    if (!element) throw new Error("tooltip missing");
    element.getBoundingClientRect = () => rect(0, 0, 80, 30);

    tooltip.attach(target, "説明");
    target.dispatchEvent(new Event("pointerenter"));

    expect(target.title).toBe("");
    expect(target.getAttribute("aria-describedby")).toBe(element.id);
    expect(element.hidden).toBe(false);
    expect(element.dataset["side"]).toBe("above");
    expect(element.style.top).toBe("56px");
    expect(element.style.left).toBe("80px");
    tooltip.destroy();
  });

  it("falls below only when the upper viewport room is insufficient and clamps its height", () => {
    const host = document.createElement("div");
    const target = document.createElement("button");
    host.append(target);
    document.body.append(host);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 300 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    target.getBoundingClientRect = () => rect(100, 10, 40, 20);
    const tooltip = createControlledTooltip(host);
    const element = host.querySelector<HTMLElement>(".cm-controlled-tooltip");
    if (!element) throw new Error("tooltip missing");
    element.getBoundingClientRect = () => rect(0, 0, 80, 30);

    tooltip.attach(target, "説明");
    target.dispatchEvent(new Event("focus"));

    expect(element.dataset["side"]).toBe("below");
    expect(element.style.top).toBe("44px");
    expect(element.style.maxHeight).toBe("248px");
    tooltip.destroy();
  });

  it("keeps the next control's tooltip visible while the previous control loses hover", () => {
    const host = document.createElement("div");
    const first = document.createElement("button");
    const second = document.createElement("button");
    host.append(first, second);
    document.body.append(host);
    first.getBoundingClientRect = () => rect(30, 100, 20, 20);
    second.getBoundingClientRect = () => rect(70, 100, 20, 20);
    const tooltip = createControlledTooltip(host);
    const element = host.querySelector<HTMLElement>(".cm-controlled-tooltip");
    if (!element) throw new Error("tooltip missing");
    element.getBoundingClientRect = () => rect(0, 0, 40, 20);
    tooltip.attach(first, "最初");
    tooltip.attach(second, "次");

    first.dispatchEvent(new Event("pointerenter"));
    second.dispatchEvent(new Event("pointerenter"));
    first.dispatchEvent(new Event("pointerleave"));
    expect(element.hidden).toBe(false);
    expect(element.textContent).toBe("次");
    second.dispatchEvent(new Event("pointerleave"));
    expect(element.hidden).toBe(true);
    tooltip.destroy();
  });
});
