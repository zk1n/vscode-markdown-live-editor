// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createFloatingSearch } from "../../src/webview/search/floatingSearch.js";
import {
  planSearch,
  type SearchRequest,
  type SearchResult,
} from "../../src/webview/search/searchPlan.js";
import { tableEditing } from "../../src/webview/livePreview/tableEditing.js";
import { createLivePreviewEngine } from "../../src/webview/livePreview/LivePreviewEngine.js";

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
  it("finds hidden source, replaces all in one undo operation and resumes input on Escape", async () => {
    const source = "| needle | b |\n| --- | --- |\n| [l](needle.md) | needle |\n\nafter needle";
    const { view, open } = create(source);
    open();
    input("query", "needle");
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent).toBe("1 / 4");
    expect(view.dom.querySelectorAll(".cm-table-row")).toHaveLength(2);
    key(field("query"), "Enter");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "needle",
    );
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
});
