// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFloatingSearch } from "../../src/webview/search/floatingSearch.js";
import {
  planSearch,
  type SearchRequest,
  type SearchResult,
} from "../../src/webview/search/searchPlan.js";
import { tableEditing } from "../../src/webview/livePreview/tableEditing.js";
import { createLivePreviewEngine } from "../../src/webview/livePreview/LivePreviewEngine.js";
import { searchReveal } from "../../src/webview/livePreview/searchReveal.js";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
function create(
  source: string,
  executor = (request: SearchRequest): Promise<SearchResult> =>
    Promise.resolve(planSearch(request)),
): { view: EditorView; open: () => void } {
  document.documentElement.lang = "ja";
  const search = createFloatingSearch({
    isReady: () => true,
    isEditable: () => true,
    save: () => undefined,
    executor,
  });
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: source,
      extensions: [
        createLivePreviewEngine().extension,
        tableEditing(() => true),
        search.extension,
        history(),
      ],
    }),
  });
  views.push(view);
  return {
    view,
    open: () => {
      search.open(view, true);
    },
  };
}
function field(name: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`[data-search-input="${name}"]`);
  if (!found) throw new Error("input missing");
  return found;
}
function input(name: string, value: string): void {
  const element = field(name);
  element.focus();
  element.value = value;
  element.dispatchEvent(new InputEvent("input", { bubbles: true }));
}
function click(label: string): void {
  const element = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!element) throw new Error(label);
  element.focus();
  element.click();
}
function key(element: HTMLElement, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  element.dispatchEvent(event);
  return event;
}

describe("floating full-source search", () => {
  it("keeps user selection and rendered Markdown while query generations expire", async () => {
    const source = "# asdf\n\n**asdf** [label](hidden.md)\n\nend";
    const { view, open } = create(source);
    view.dispatch({ selection: { anchor: 2, head: 6 } });
    const saved = view.state.selection;
    open();
    input("query", "asdf");
    await settle();
    expect(view.state.selection.eq(saved)).toBe(true);
    expect(view.contentDOM.textContent).not.toContain("#");
    expect(view.contentDOM.textContent).not.toContain("**");
    input("query", "asdfg");
    await settle();
    expect(view.dom.querySelectorAll(".cm-source-search-match")).toHaveLength(0);
    expect(view.dom.querySelectorAll(".cm-source-search-current")).toHaveLength(0);
    expect(view.state.selection.eq(saved)).toBe(true);
    click("置換");
    expect(view.state.doc.toString()).toBe(source);
    key(field("query"), "Escape");
    expect(view.state.selection.eq(saved)).toBe(true);
  });
  it("finds hidden source, replaces all in one undo operation and resumes input on Escape", async () => {
    const source = "| needle | b |\n| --- | --- |\n| [l](needle.md) | needle |\n\nafter needle";
    const { view, open } = create(source);
    open();
    input("query", "needle");
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent).toBe("1 / 4");
    expect(view.dom.querySelectorAll(".cm-table-row")).toHaveLength(2);
    key(field("query"), "Enter");
    const match = view.state.field(searchReveal);
    expect(match && view.state.sliceDoc(match.from, match.to)).toBe("needle");
    expect(view.contentDOM.textContent).toContain("[l](needle.md)");
    input("replacement", "new");
    await settle();
    click("すべて置換");
    await settle();
    expect(view.state.doc.toString()).toBe(source.replaceAll("needle", "new"));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("すべて置換");
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) throw new Error("no focused control");
    key(active, "Escape");
    expect(view.hasFocus).toBe(true);
    expect(document.querySelector(".cm-floating-search")).toBeNull();
    // happy-dom dispatches selectionchange synchronously during DOM replacement.
    // Native focused Undo is exercised in the actual browser/Host fixture.
    view.contentDOM.blur();
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source.replaceAll("needle", "new"));
  });
  it("retains the current match when editing replacement and performs single replacement", async () => {
    const { view, open } = create("a a");
    open();
    input("query", "a");
    await settle();
    input("replacement", "B");
    await settle();
    click("置換");
    await settle();
    expect(view.state.doc.toString()).toBe("B a");
  });
  it("keeps Tab and IME confirmation Enter in the form and preserves original selection without matches", async () => {
    const { view, open } = create("| a | b |\n| --- | --- |\n| x | y |");
    view.dispatch({ selection: { anchor: 2, head: 3 } });
    open();
    input("query", "missing");
    await settle();
    const before = view.state.selection;
    key(field("query"), "Enter", { isComposing: true });
    expect(view.state.selection.eq(before)).toBe(true);
    expect(key(field("query"), "Tab").defaultPrevented).toBe(true);
    expect(view.state.doc.lines).toBe(3);
    key(field("query"), "Escape");
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(3);
  });
  it("distinguishes a pending query from a confirmed empty result", async () => {
    let resolve: ((result: SearchResult) => void) | undefined;
    const { open } = create(
      "needle",
      () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    );
    open();
    input("query", "missing");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("");
    resolve?.({ matches: [] });
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent).toBe("一致なし");
  });
  it("defers the busy label while cancelling stale generation timers", async () => {
    vi.useFakeTimers();
    try {
      const completions: { resolve(result: SearchResult): void }[] = [];
      const { open } = create(
        "needle",
        () => new Promise((resolve) => completions.push({ resolve })),
      );
      open();
      input("query", "first");
      expect(document.querySelector('[role="status"]')?.textContent).toBe("");
      vi.advanceTimersByTime(199);
      expect(document.querySelector('[role="status"]')?.textContent).toBe("");
      input("query", "second");
      vi.advanceTimersByTime(199);
      expect(document.querySelector('[role="status"]')?.textContent).toBe("");
      vi.advanceTimersByTime(1);
      expect(document.querySelector('[role="status"]')?.textContent).toBe("検索中…");
      completions.at(-1)?.resolve({ matches: [] });
      await settle();
      expect(document.querySelector('[role="status"]')?.textContent).toBe("一致なし");
    } finally {
      vi.useRealTimers();
    }
  });
  it("maps selection scope through replacement and discards asynchronous stale results", async () => {
    const completions: { request: SearchRequest; resolve(value: SearchResult): void }[] = [];
    const { view, open } = create(
      "one one one",
      (request) => new Promise((resolve) => completions.push({ request, resolve })),
    );
    view.dispatch({ selection: { anchor: 4, head: 7 } });
    open();
    input("query", "one");
    click("選択範囲内");
    view.dispatch({ changes: { from: 0, insert: "prefix " } });
    await settle();
    for (const completion of completions) completion.resolve(planSearch(completion.request));
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent).toBe("1 / 1");
    expect(view.state.selection.main.from).toBe(11);
    key(field("query"), "Escape");
    expect(view.hasFocus).toBe(true);
  });
  it("uses one shared input column for Find and Replace", async () => {
    const { open } = create("needle middle needle");
    open();
    input("query", "needle");
    await settle();
    const queryBox = field("query").parentElement;
    const replacementBox = field("replacement").parentElement;
    expect(queryBox?.className).toBe("cm-search-query-box");
    expect(replacementBox?.className).toContain("cm-search-query-box");
    expect(queryBox?.parentElement?.children[1]).toBe(queryBox);
    expect(replacementBox?.parentElement?.children[1]).toBe(replacementBox);
  });
  it("reserves a stable status column and exposes full counts beyond four digits", async () => {
    const matches = Array.from({ length: 10000 }, (_, from) => ({
      from,
      to: from + 1,
      insert: "",
    }));
    const { open } = create("x".repeat(10000), () => Promise.resolve({ matches }));
    open();
    input("query", "x");
    await settle();
    const status = document.querySelector<HTMLElement>('[role="status"]');
    expect(status?.textContent).toBe("1 / 9999+");
    expect(status?.getAttribute("aria-label")).toBe("1 / 10000");
  });
  it("returns to the current match only when Escape starts in the search form", async () => {
    const { view, open } = create("needle middle needle");
    open();
    input("query", "needle");
    await settle();
    key(field("query"), "Escape");
    expect(view.state.selection.main.from).toBe(6);
    expect(view.hasFocus).toBe(true);
  });
  it("closes from editor focus without restoring an old match or stealing another focus", async () => {
    const { view, open } = create("needle middle needle");
    open();
    input("query", "needle");
    await settle();
    view.focus();
    await settle();
    view.dispatch({ selection: { anchor: 7 } });
    const escape = key(view.contentDOM, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(document.querySelector(".cm-floating-search")).toBeNull();
    expect(view.state.selection.main.from).toBe(7);
    expect(view.hasFocus).toBe(true);
  });
  it("leaves the search open while IME is composing and ignores delayed results after close", async () => {
    let resolve: ((result: SearchResult) => void) | undefined;
    const { view, open } = create(
      "needle",
      () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    );
    open();
    input("query", "needle");
    key(field("query"), "Escape", { isComposing: true });
    expect(document.querySelector(".cm-floating-search")).not.toBeNull();
    key(field("query"), "Escape");
    resolve?.({ matches: [{ from: 0, to: 6, insert: "" }] });
    await settle();
    expect(document.querySelector(".cm-floating-search")).toBeNull();
    expect(view.dom.querySelectorAll(".cm-source-search-match")).toHaveLength(0);
  });
  it("closes search before the table Escape keymap and keeps the current cell", async () => {
    const { view, open } = create("| a | b |\n| --- | --- |\n| c | d |\n\nafter");
    open();
    view.focus();
    view.dispatch({ selection: { anchor: 2 } });
    await settle();
    const selection = view.state.selection;
    key(view.contentDOM, "Escape");
    expect(document.querySelector(".cm-floating-search")).toBeNull();
    expect(view.state.selection.eq(selection)).toBe(true);
  });
  it("handles Escape in sibling editor UI without stealing focus or changing selection", () => {
    const { view, open } = create("before after");
    open();
    const sibling = document.createElement("button");
    view.dom.append(sibling);
    sibling.focus();
    const selection = view.state.selection;
    key(sibling, "Escape");
    expect(document.querySelector(".cm-floating-search")).toBeNull();
    expect(document.activeElement).toBe(sibling);
    expect(view.state.selection.eq(selection)).toBe(true);
  });
  it("handles Escape delivered to the owner document after focus leaves the webview", () => {
    const { view, open } = create("before after");
    open();
    view.dom.ownerDocument.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(document.querySelector(".cm-floating-search")).toBeNull();
  });
});
