// @vitest-environment happy-dom

import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { findTables } from "../../src/core/markdown/tableSource.js";
import { createLivePreviewEngine } from "../../src/webview/livePreview/LivePreviewEngine.js";
import { editTable, tableEditing } from "../../src/webview/livePreview/tableEditing.js";

const views: EditorView[] = [];
const engines: ReturnType<typeof createLivePreviewEngine>[] = [];

afterEach((): void => {
  for (const view of views.splice(0)) view.destroy();
  for (const engine of engines.splice(0)) engine.dispose();
  document.body.replaceChildren();
});

function createView(text: string, selection = text.length): EditorView {
  const engine = createLivePreviewEngine();
  engines.push(engine);
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: { anchor: selection },
      extensions: [engine.extension, tableEditing(() => true), history()],
    }),
    parent,
  });
  views.push(view);
  return view;
}

function clipboard(text?: string): DataTransfer {
  const data = new DataTransfer();
  if (text !== undefined) data.setData("text/plain", text);
  return data;
}

function dispatchClipboard(
  view: EditorView,
  type: "copy" | "cut" | "paste",
  data: DataTransfer,
): ClipboardEvent {
  const event = new ClipboardEvent(type, {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function sourceTable(source: string): NonNullable<ReturnType<typeof findTables>[number]> {
  const table = findTables(source)[0];
  if (table === undefined) throw new Error("Expected a parsed table.");
  return table;
}

describe("rectangular table clipboard editing", () => {
  it("copies and cuts a cell rectangle as TSV, with one undo unit", () => {
    const source = "| h1 | h2 | h3 |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |";
    const parsed = sourceTable(source);
    const first = parsed.rows[1]?.cells[0];
    const last = parsed.rows[2]?.cells[1];
    if (first === undefined || last === undefined) throw new Error("Expected rectangle cells.");
    const view = createView(source, first.contentFrom);
    view.dispatch({ selection: { anchor: first.contentFrom, head: last.contentTo } });

    const data = clipboard();
    const copied = dispatchClipboard(view, "copy", data);
    expect(copied.defaultPrevented).toBe(true);
    expect(data.getData("text/plain")).toBe("a\tb\nd\te");

    const cutData = clipboard();
    const cut = dispatchClipboard(view, "cut", cutData);
    expect(cut.defaultPrevented).toBe(true);
    expect(cutData.getData("text/plain")).toBe("a\tb\nd\te");
    expect(view.state.doc.toString()).not.toContain("| a | b |");
    expect(view.state.doc.toString()).not.toContain("| d | e |");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("pastes a bounded TSV rectangle atomically and escapes table pipes", () => {
    const source = "| h1 | h2 | h3 |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |";
    const parsed = sourceTable(source);
    const target = parsed.rows[1]?.cells[0];
    if (target === undefined) throw new Error("Expected paste target.");
    const view = createView(source, target.contentFrom);
    const event = dispatchClipboard(view, "paste", clipboard("one|part\ttwo\nthree\tfour"));
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toContain("| one\\|part | two |");
    expect(view.state.doc.toString()).toContain("| three | four |");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("keeps ordinary multiline text in one cell on the native paste path", () => {
    const source = "| h1 | h2 |\n| --- | --- |\n| a | b |\n| c | d |";
    const parsed = sourceTable(source);
    const target = parsed.rows[1]?.cells[0];
    if (target === undefined) throw new Error("Expected paste target.");
    const view = createView(source, target.contentFrom);
    view.dispatch({ selection: { anchor: target.contentFrom, head: target.contentTo } });
    dispatchClipboard(view, "paste", clipboard("one\ntwo"));
    expect(view.state.doc.toString()).toContain("| one two | b |");
    expect(view.state.doc.toString()).toContain("| c | d |");
  });

  it("recognizes one-column multi-row TSV copies through the explicit flavor", () => {
    const source = "| h1 | h2 |\n| --- | --- |\n| a | b |\n| c | d |";
    const parsed = sourceTable(source);
    const target = parsed.rows[1]?.cells[0];
    if (target === undefined) throw new Error("Expected paste target.");
    const view = createView(source, target.contentFrom);
    const data = clipboard();
    data.setData("text/tab-separated-values", "one\ntwo");
    const event = dispatchClipboard(view, "paste", data);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toContain("| one | b |");
    expect(view.state.doc.toString()).toContain("| two | d |");
  });

  it("rejects TSV overflow without changing source", () => {
    const source = "| h1 | h2 |\n| --- | --- |\n| a | b |\n| c | d |";
    const parsed = sourceTable(source);
    const target = parsed.rows[2]?.cells[1];
    if (target === undefined) throw new Error("Expected paste target.");
    const view = createView(source, target.contentFrom);
    const event = dispatchClipboard(view, "paste", clipboard("one\tone\ntwo\ttwo"));
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("does not clear cells when clipboard write fails during cut", () => {
    const source = "| h1 | h2 |\n| --- | --- |\n| a | b |\n| c | d |";
    const parsed = sourceTable(source);
    const first = parsed.rows[1]?.cells[0];
    const last = parsed.rows[2]?.cells[1];
    if (first === undefined || last === undefined) throw new Error("Expected rectangle cells.");
    const view = createView(source, first.contentFrom);
    view.dispatch({ selection: { anchor: first.contentFrom, head: last.contentTo } });
    const data = clipboard();
    data.setData = (): void => {
      throw new Error("clipboard unavailable");
    };
    const event = dispatchClipboard(view, "cut", data);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("protects the final data row from row-delete", () => {
    const source = "| h | v |\n| --- | --- |\n| a | b |";
    const table = sourceTable(source);
    const view = createView(source, table.rows[1]?.cells[0]?.contentFrom ?? 0);
    expect(editTable(view, "row-delete")).toBe(false);
    expect(view.state.doc.toString()).toBe(source);
  });
});
