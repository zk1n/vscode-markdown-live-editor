// @vitest-environment happy-dom

import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
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
      extensions: [
        engine.extension,
        tableEditing((): boolean => true),
        history(),
        EditorState.allowMultipleSelections.of(true),
      ],
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
  it("returns from invalid table source without rewriting it", () => {
    const source = "before\n\n| h | v |\n| --- | --- |\n| a | b |\n\nafter";
    const view = createView(source, source.indexOf("h"));
    expect(editTable(view, "source")).toBe(true);
    const start = source.indexOf("| ---");
    view.dispatch({
      changes: { from: start, to: start + 13, insert: "broken" },
      userEvent: "input.type",
    });
    const invalid = view.state.doc.toString();
    expect(view.dom.querySelector(".cm-table-cell")).toBeNull();
    expect(editTable(view, "source")).toBe(true);
    expect(view.state.doc.toString()).toBe(invalid);
    expect(editTable(view, "source")).toBe(false);
  });
  it("crosses cell boundaries with arrows without selecting cells or adding rows", () => {
    const source = "before\n\n| aa | bb |\n| --- | --- |\n| xx | yy |\n\nafter";
    const view = createView(source, source.indexOf("aa") + 2);
    press(view, "ArrowRight");
    expect(view.state.selection.main.head).toBe(source.indexOf("bb"));
    expect(view.state.selection.main.empty).toBe(true);
    press(view, "ArrowLeft");
    expect(view.state.selection.main.head).toBe(source.indexOf("aa") + 2);
    press(view, "ArrowDown");
    expect(view.state.selection.main.head).toBeGreaterThanOrEqual(source.indexOf("xx"));
    expect(view.state.selection.main.head).toBeLessThanOrEqual(source.indexOf("xx") + 2);
    press(view, "ArrowDown");
    expect(view.state.selection.main.head).toBeGreaterThan(table(source).to);
    expect(view.state.doc.toString()).toBe(source);
  });
  it("protects multiple cell carets and composition input without changing table shape", () => {
    const source = "| h | v |\n| --- | --- |\n| a | b |";
    const view = createView(source);
    const a = source.lastIndexOf("a");
    const b = source.lastIndexOf("b");
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(a + 1),
        EditorSelection.cursor(b + 1),
      ]),
    });
    view.dispatch({ ...view.state.replaceSelection("|"), userEvent: "input.type.compose" });
    expect(view.state.doc.toString()).toBe(
      source.replace(" a ", " a\\| ").replace(" b ", " b\\| "),
    );
    const before = view.state.doc.toString();
    view.dispatch({
      changes: { from: a, to: view.state.doc.length, insert: "" },
      userEvent: "delete.selection",
    });
    expect(view.state.doc.toString()).toBe(before);
    expect(findTables(before)[0]?.rows[1]?.cells).toHaveLength(2);
    view.dispatch({ ...view.state.replaceSelection("\n"), userEvent: "input" });
    expect(findTables(view.state.doc.toString())[0]?.rows).toHaveLength(2);
    expect(view.state.doc.lines).toBe(3);
  });
  it("allows an explicit selection covering every table to replace or cut source", () => {
    const source = "before\n| h | v |\n| --- | --- |\n| a | b |\nafter";
    const view = createView(source);
    view.dispatch({ selection: { anchor: 0, head: source.length } });
    view.dispatch({ ...view.state.replaceSelection("replacement"), userEvent: "input.paste" });
    expect(view.state.doc.toString()).toBe("replacement");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);

    view.dispatch({ selection: { anchor: 0, head: source.length } });
    view.dispatch({ ...view.state.replaceSelection(""), userEvent: "delete.selection" });
    expect(view.state.doc.toString()).toBe("");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });
  it("allows one fully selected table block while rejecting a partial table intersection", () => {
    const source = [
      "# First",
      "",
      "| h | v |",
      "| --- | --- |",
      "| a | b |",
      "",
      "first paragraph",
      "",
      "# Second",
      "",
      "| x | y |",
      "| --- | --- |",
      "| c | d |",
      "",
      "second paragraph",
      "",
    ].join("\n");
    const [first, second] = findTables(source);
    if (first === undefined || second === undefined) throw new Error("Expected two tables.");
    const firstBlockEnd = source.indexOf("\n\n# Second");
    const view = createView(source);
    view.dispatch({ selection: { anchor: first.from, head: firstBlockEnd } });
    view.dispatch({ ...view.state.replaceSelection("replacement\n"), userEvent: "input.paste" });
    expect(view.state.doc.toString()).toContain("| x | y |");
    expect(view.state.doc.toString()).toContain("| c | d |");
    const partial = createView(source);
    partial.dispatch({ selection: { anchor: second.from, head: second.from + 3 } });
    partial.dispatch({ ...partial.state.replaceSelection("bad"), userEvent: "input.paste" });
    expect(partial.state.doc.toString()).toBe(source);
  });
  it("protects delimiters after deletion and owns pipe escaping during input", () => {
    const source = "| a | b |\n| :--- | ---: |\n| text | keep `code` [link](a.md) |\n\nafter";
    const view = createView(source, source.indexOf("text"));
    const start = view.state.selection.main.head;
    view.dispatch({ changes: { from: start - 1, to: start }, userEvent: "delete.backward" });
    expect(view.state.doc.toString()).toBe(source);
    view.dispatch({
      changes: { from: start, to: start + 4, insert: "" },
      selection: { anchor: start },
      userEvent: "delete.selection",
    });
    expect(table(view.state.doc.toString()).columns).toBe(2);
    view.dispatch({ ...view.state.replaceSelection("a|b"), userEvent: "input.type" });
    expect(view.state.doc.toString()).toContain("a\\|b");
    const escape = view.state.doc.toString().indexOf("\\|");
    view.dispatch({ selection: { anchor: escape + 1 } });
    view.dispatch({ changes: { from: escape, to: escape + 1 }, userEvent: "delete.backward" });
    expect(table(view.state.doc.toString()).columns).toBe(2);
    expect(view.state.doc.toString()).toContain("keep `code` [link](a.md)");
  });
  it("appends a column at the active row and a row at the first column", () => {
    const source = "| a | b |\n| --- | --- |\n| c | d |\n\nafter";
    const view = createView(source, source.indexOf("d |"));
    expect(editTable(view, "column-append")).toBe(true);
    expect(view.state.selection.main.head).toBe(
      table(view.state.doc.toString()).rows[1]?.cells[2]?.contentFrom,
    );
    expect(editTable(view, "row-append")).toBe(true);
    expect(view.state.selection.main.head).toBe(
      table(view.state.doc.toString()).rows[2]?.cells[0]?.contentFrom,
    );
    expect(view.hasFocus).toBe(true);
  });
  it("keeps a one-column table recognized when removing a column without outer pipes", () => {
    const source = "a | b\n--- | ---\n c | d\n\nafter";
    const view = createView(source, source.indexOf("d\n"));
    expect(editTable(view, "column-delete")).toBe(true);
    expect(table(view.state.doc.toString()).columns).toBe(1);
    expect(view.state.doc.toString()).toBe("|a |\n|--- |\n| c |\n\nafter");
  });
  it("keeps ordinary pipe and padding navigation in table form until explicit source editing", () => {
    const source = "| **h** | b |\n| --- | --- |\n| `code` | [l](a.md) |\n\nafter";
    const view = createView(source);
    const row = table(source).rows[1];
    if (row === undefined) throw new Error("Missing row");
    view.dispatch({ selection: { anchor: row.from } });
    view.dispatch({ selection: { anchor: row.cells[1]?.contentFrom ?? 0 } });
    expect(view.contentDOM.querySelectorAll(".cm-table-row")).toHaveLength(2);
    expect(editTable(view, "source")).toBe(true);
    expect(view.contentDOM.textContent).toContain("| `code` | [l](a.md) |");
    expect(editTable(view, "source")).toBe(true);
    view.dispatch({ selection: { anchor: source.length } });
    expect(view.contentDOM.querySelectorAll(".cm-table-row")).toHaveLength(2);
    expect(view.state.doc.toString()).toBe(source);
  });
  it("retains secondary selections on cell commands and does not collapse them on Tab", () => {
    const source = "| a | b |\n| --- | --- |\n| c | d |\n\nafter";
    const view = createView(source, source.indexOf("c |"));
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(source.indexOf("c |")),
        EditorSelection.cursor(source.length),
      ]),
    });
    expect(editTable(view, "column-add")).toBe(true);
    expect(view.state.selection.ranges).toHaveLength(2);
    expect(view.state.selection.ranges[1]?.head).toBe(view.state.doc.length);
    press(view, "Tab");
    expect(view.state.selection.ranges).toHaveLength(2);
  });
  it.each(["row-delete", "column-delete"] as const)(
    "%s selects a remaining adjacent cell",
    (action) => {
      const source = "| a | b |\n| --- | --- |\n| c | d |\n| e | f |\n\nafter";
      const view = createView(source, source.indexOf("f |"));
      expect(editTable(view, action)).toBe(true);
      const next = table(view.state.doc.toString());
      const target = next.rows.at(-1)?.cells.at(-1);
      expect(view.state.selection.main.head).toBe(target?.contentFrom);
      expect(view.hasFocus).toBe(true);
    },
  );
  it.each(["row-add", "column-add"] as const)(
    "%s puts immediate input inside the new target cell",
    (action) => {
      const source = "before\n| h1 | h2 |\n| --- | --- |\n| a | b |\n| c | d |\n\nafter";
      const view = createView(source, source.indexOf("a |"));
      expect(editTable(view, action)).toBe(true);
      const target = table(view.state.doc.toString()).rows[action === "row-add" ? 2 : 1]?.cells[
        action === "row-add" ? 0 : 1
      ];
      if (target === undefined) throw new Error("Missing inserted cell");
      expect(view.state.selection.main.empty).toBe(true);
      expect(view.state.selection.main.head).toBeGreaterThan(target.from);
      expect(view.state.selection.main.head).toBeLessThan(target.to);
      expect(view.hasFocus).toBe(true);
      view.dispatch(view.state.replaceSelection("即入力"));
      expect(view.state.doc.toString()).toContain("| 即入力 |");
      expect(table(view.state.doc.toString()).columns).toBe(action === "row-add" ? 2 : 3);
    },
  );
  it("keeps cell-end insertion visible and scopes Home/End to the cell", () => {
    const source = "| h1 | h2 |\n| --- | --- |\n| 日本語 | second |\n\nafter";
    const cell = table(source).rows[1]?.cells[0];
    if (cell === undefined) throw new Error("Missing data cell");
    const view = createView(source, cell.contentTo);
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

  it("keeps hidden pipe selection in table form and supports an empty-cell widget", async () => {
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
    expect(view.contentDOM.querySelectorAll(".cm-table-row")).toHaveLength(2);
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
