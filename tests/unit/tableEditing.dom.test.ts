// @vitest-environment happy-dom

import { history, undo } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { findTables } from "../../src/core/markdown/tableSource.js";
import { editTable, tableEditing } from "../../src/webview/livePreview/tableEditing.js";
import { createLivePreviewEngine } from "../../src/webview/livePreview/LivePreviewEngine.js";

const views: EditorView[] = [];
const engines: ReturnType<typeof createLivePreviewEngine>[] = [];

afterEach((): void => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  for (const engine of engines.splice(0)) {
    engine.dispose();
  }
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
      extensions: [engine.extension, tableEditing((): boolean => true), history()],
    }),
    parent,
  });
  views.push(view);
  return view;
}

function table(source: string): NonNullable<ReturnType<typeof findTables>[number]> {
  const found = findTables(source)[0];
  if (found === undefined) {
    throw new Error("Expected a parser-recognized table.");
  }
  return found;
}

function press(
  view: EditorView,
  key: string,
  options: Readonly<KeyboardEventInit> = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: key === "Tab" || key === "Enter" || key === "Escape" ? key : `Key${key.toUpperCase()}`,
    key,
    ...options,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("table editing in the main CodeMirror content DOM", () => {
  it("keeps cell-end insertion visible and scopes Home/End to the cell", () => {
    const source = "| h1 | h2 |\n| --- | --- |\n| 日本語 | second |\n\nafter";
    const cell = table(source).rows[1]?.cells[0];
    if (cell === undefined) throw new Error("Missing data cell");
    const view = createView(source, cell.to);
    expect(view.contentDOM.querySelector(".cm-table-cell")).not.toBeNull();
    press(view, "End");
    expect(view.state.selection.main.head).toBe(cell.contentTo);
    press(view, "Home", { shiftKey: true });
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "日本語",
    );
    expect(view.state.doc.toString()).toBe(source);
  });
  it("keeps table cells, inline Markdown, and edits on the same source-backed contentDOM", () => {
    const source = [
      "before",
      "| **見出し** | [リンク](docs/a.md) |",
      "| :--- | ---: |",
      "| 日本語 | a very long cell that must remain selectable in source |",
      "",
      "after",
    ].join("\n");
    const view = createView(source);
    const parsed = table(source);
    const expectedCells = [...parsed.rows.flatMap((row) => row.cells)].map((cell) =>
      String(cell.contentFrom),
    );

    const cellOffsets = new Set(
      [...view.contentDOM.querySelectorAll<HTMLElement>("[data-table-cell]")].map(
        (cell) => cell.dataset["tableCell"],
      ),
    );
    expect(expectedCells.every((offset) => cellOffsets.has(offset))).toBe(true);
    expect(view.contentDOM.querySelector(".cm-table-cell .cm-live-preview-strong")).not.toBeNull();
    expect(view.contentDOM.querySelector(".cm-table-cell .cm-live-preview-link")).not.toBeNull();
    expect(view.contentDOM.textContent).toContain("見出し");
    expect(view.contentDOM.textContent).toContain("日本語");

    const target = source.indexOf("日本語");
    view.dispatch({
      changes: { from: target, to: target + "日本語".length, insert: "更新" },
      annotations: Transaction.userEvent.of("input.type"),
    });
    expect(view.state.doc.toString()).toContain("| 更新 | a very long cell");
    expect(view.state.doc.toString()).toContain("[リンク](docs/a.md)");
    expect(view.contentDOM.querySelector(".cm-table-cell")).not.toBeNull();
  });

  it("reveals raw source when a hidden pipe is selected and supports an empty-cell widget", async () => {
    const source = "| a | b |\n| --- | --- |\n|| value |";
    const parsed = table(source);
    const view = createView(source);
    const emptyCell = parsed.rows[1]?.cells[0];
    if (emptyCell === undefined) {
      throw new Error("Expected an empty data cell.");
    }
    const widget = view.contentDOM.querySelector<HTMLElement>(
      `[data-table-cell="${String(emptyCell.from)}"]`,
    );
    expect(widget).not.toBeNull();
    widget?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(view.state.selection.main.head).toBe(emptyCell.from);
    expect(view.state.doc.toString()).toBe(source);

    const pipe = source.indexOf("|");
    view.dispatch({ selection: { anchor: pipe, head: pipe + 1 } });
    expect(view.contentDOM.querySelector(".cm-table-cell")).toBeNull();
    expect(view.contentDOM.textContent).toContain("| a | b |");
    expect(view.state.doc.toString()).toBe(source);
  });

  it("moves through header and cells, leaves to surrounding text, and appends a row from the final cell", () => {
    const source = "before\n| h1 | h2 |\n| --- | --- |\n| a | b |\n\nafter";
    const parsed = table(source);
    const firstHeader = parsed.rows[0]?.cells[0];
    const finalCell = parsed.rows[1]?.cells[1];
    if (firstHeader === undefined || finalCell === undefined) {
      throw new Error("Expected table cells.");
    }
    const view = createView(source, firstHeader.contentFrom);

    const before = press(view, "Tab", { shiftKey: true });
    expect(before.defaultPrevented).toBe(true);
    expect(view.state.selection.main.head).toBe(parsed.from - 1);
    view.dispatch({ selection: { anchor: firstHeader.contentFrom } });
    press(view, "Tab");
    expect(view.state.selection.main).toMatchObject({
      from: parsed.rows[0]?.cells[1]?.contentFrom,
      to: parsed.rows[0]?.cells[1]?.contentTo,
    });
    view.dispatch({ selection: { anchor: finalCell.contentFrom } });
    press(view, "Enter");
    expect(view.state.doc.toString()).toContain("| a | b |\n|  |  |");

    const latest = table(view.state.doc.toString());
    view.dispatch({ selection: { anchor: latest.rows[1]?.cells[0]?.contentFrom ?? 0 } });
    press(view, "Enter", { ctrlKey: true });
    expect(view.state.selection.main.head).toBe(latest.to + 2);
    expect(
      view.state.sliceDoc(view.state.selection.main.head, view.state.selection.main.head + 5),
    ).toBe("after");
  });

  it("uses ordinary transactions for table actions, preserves literals, and is undoable", () => {
    const source = "| **h** | [l](a.md) |\n| --- | --- |\n| keep | `code` |\n\nplain";
    const parsed = table(source);
    const view = createView(source, parsed.rows[1]?.cells[0]?.contentFrom ?? 0);

    expect(editTable(view, "column-add")).toBe(true);
    expect(view.state.doc.toString()).toContain("| **h** |  | [l](a.md) |");
    expect(view.state.doc.toString()).toContain("| keep |  | `code` |");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);

    expect(editTable(view, "align-center")).toBe(true);
    expect(view.state.doc.toString()).toContain("| :---: | --- |");
    expect(editTable(view, "source")).toBe(true);
    expect(view.contentDOM.querySelector(".cm-table-cell")).toBeNull();
    expect(view.state.doc.toString()).toContain("[l](a.md)");
  });

  it("makes insert, row, and column commands explicit source transactions", () => {
    const inserted = createView("before after", "before".length);
    expect(editTable(inserted, "insert")).toBe(true);
    expect(inserted.state.doc.toString()).toBe(
      "before\n\n| 見出し | 見出し |\n| --- | --- |\n|  |  |\n\n after",
    );

    const source = "| h1 | h2 |\n| --- | --- |\n| a | b |";
    const parsed = table(source);
    const view = createView(source, parsed.rows[1]?.cells[0]?.contentFrom ?? 0);
    expect(editTable(view, "row-add")).toBe(true);
    expect(view.state.doc.toString()).toContain("| a | b |\n|  |  |");
    expect(undo(view)).toBe(true);
    expect(editTable(view, "row-delete")).toBe(true);
    expect(view.state.doc.toString()).toBe("| h1 | h2 |\n| --- | --- |");
    expect(undo(view)).toBe(true);
    expect(editTable(view, "column-delete")).toBe(true);
    expect(view.state.doc.toString()).toBe("| h2 |\n| --- |\n| b |");
  });

  it("does not claim an editing path for malformed source", () => {
    const source = "| h | x |\n| --- |\n| a | b |";
    const view = createView(source, source.indexOf("a"));
    expect(view.contentDOM.querySelector(".cm-table-cell")).toBeNull();
    expect(editTable(view, "row-add")).toBe(false);
    expect(view.state.doc.toString()).toBe(source);
  });
});
