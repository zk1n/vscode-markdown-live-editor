import {
  StateEffect,
  StateField,
  Prec,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import {
  changeTableColumn,
  findTables,
  tableCellAt,
  type SourceTable,
} from "../../core/markdown/tableSource.js";

// The cells are the main CodeMirror contentDOM: native selection, clipboard,
// IME, Save and history all retain the same source and controller owner.
const rawTable = StateEffect.define<number | undefined>();
const rawTableField = StateField.define<number | undefined>({
  create: () => undefined,
  update(value, transaction) {
    let next = value === undefined ? undefined : transaction.changes.mapPos(value);
    for (const effect of transaction.effects) if (effect.is(rawTable)) next = effect.value;
    return next;
  },
});
const tableDecorations = StateField.define<DecorationSet>({
  create: build,
  update(value, transaction) {
    if (transaction.isUserEvent("input.type.compose")) return value.map(transaction.changes);
    if (
      !transaction.docChanged &&
      transaction.selection === undefined &&
      !transaction.effects.some((effect) => effect.is(rawTable))
    )
      return value;
    return build(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function build(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const table of findTables(state.doc.toString())) {
    if (isTableSourceActive(state, table)) continue;
    for (const [rowIndex, row] of table.rows.entries()) {
      ranges.push(
        Decoration.line({
          class: "cm-table-row",
          attributes: { "data-table-from": String(table.from) },
        }).range(row.from),
      );
      for (const [column, cell] of row.cells.entries()) {
        const css = `cm-table-cell${rowIndex === 0 ? " cm-table-header" : ""}`;
        const attrs = {
          style: `text-align:${table.alignments[column] ?? "left"}`,
          "data-table-cell": String(cell.contentFrom),
        };
        if (cell.from < cell.to)
          ranges.push(Decoration.mark({ class: css, attributes: attrs }).range(cell.from, cell.to));
        else
          ranges.push(
            Decoration.widget({ widget: new EmptyCell(cell.from), side: 1 }).range(cell.from),
          );
      }
      for (const pipe of row.pipes) ranges.push(Decoration.replace({}).range(pipe, pipe + 1));
    }
    const selected = state.selection.ranges.some(
      (range) => range.from <= table.delimiter.to && range.to >= table.delimiter.from,
    );
    if (!selected) {
      ranges.push(Decoration.line({ class: "cm-table-delimiter" }).range(table.delimiter.from));
      ranges.push(Decoration.replace({}).range(table.delimiter.from, table.delimiter.to));
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * Table pipes and delimiter text are replaced only while the table is in its
 * presentation mode. A source selection can be created by Find / Replace,
 * keyboard navigation, or a mouse click, so it must reveal the entire table
 * rather than leaving a selected source character hidden in a replacement.
 */
function isTableSourceActive(state: EditorState, table: SourceTable): boolean {
  if (state.field(rawTableField) === table.from) {
    return true;
  }
  const sourcePositions = [...table.rows.flatMap((row) => row.pipes), ...table.delimiter.pipes];
  return state.selection.ranges.some((selection) => {
    // A caret just before a pipe is still the preceding cell's insertion point.
    if (selection.empty && tableCellAt(table, selection.head) !== undefined) return false;
    return (
      sourcePositions.some((position) =>
        selection.empty
          ? selection.head === position
          : selection.from <= position && selection.to > position,
      ) ||
      (selection.from <= table.delimiter.to && selection.to >= table.delimiter.from)
    );
  });
}

class EmptyCell extends WidgetType {
  public constructor(private readonly position: number) {
    super();
  }
  public override eq(other: EmptyCell): boolean {
    return other.position === this.position;
  }
  public override toDOM(view: EditorView): HTMLElement {
    const cell = document.createElement("span");
    cell.className = "cm-table-cell";
    cell.textContent = "\u200b";
    cell.dataset["tableCell"] = String(this.position);
    cell.addEventListener("mousedown", (event) => {
      event.preventDefault();
      // A widget mousedown can be observed while CodeMirror is reconciling
      // its native selection. Queue the presentation selection so it remains
      // on the same EditorView without recursively dispatching mid-update.
      queueMicrotask((): void => {
        view.dispatch({ selection: { anchor: this.position } });
      });
    });
    cell.addEventListener("click", (): void => {
      // Focus after the mouse event's selection reconciliation has completed.
      queueMicrotask((): void => {
        view.focus();
      });
    });
    return cell;
  }
  public override ignoreEvent(): boolean {
    return true;
  }
}

export type TableAction =
  | "insert"
  | "row-add"
  | "row-delete"
  | "column-add"
  | "column-delete"
  | "align-left"
  | "align-center"
  | "align-right"
  | "source";

export function editTable(view: EditorView, action: TableAction): boolean {
  if (view.composing || view.compositionStarted || view.state.readOnly) return false;
  const text = view.state.doc.toString();
  const selected = view.state.selection.main;
  if (action === "insert") {
    const prefix = selected.from > 0 && text[selected.from - 1] !== "\n" ? "\n\n" : "";
    const insert = `${prefix}| 見出し | 見出し |\n| --- | --- |\n|  |  |\n\n`;
    view.dispatch({
      changes: { from: selected.from, to: selected.to, insert },
      selection: { anchor: selected.from + prefix.length + 2 },
      userEvent: "input.table",
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }
  const table = findTables(text).find(
    (candidate) => candidate.from <= selected.head && candidate.to >= selected.head,
  );
  if (table === undefined) return false;
  if (action === "source") {
    view.dispatch({
      effects: rawTable.of(view.state.field(rawTableField) === table.from ? undefined : table.from),
    });
    view.focus();
    return true;
  }
  const current = tableCellAt(table, selected.head) ?? { row: 0, column: 0 };
  let changes: ChangeSpec = [];
  if (action === "row-add") {
    const row = current.row === 0 ? table.delimiter : table.rows[current.row];
    if (row === undefined) return false;
    changes = { from: row.to, insert: `\n|${"  |".repeat(table.columns)}` };
  } else if (action === "row-delete") {
    if (current.row === 0) return false;
    const row = table.rows[current.row];
    if (row === undefined) return false;
    changes = { from: row.from - 1, to: row.to, insert: "" };
  } else if (action === "column-add" || action === "column-delete") {
    changes = changeTableColumn(
      text,
      table,
      current.column + (action === "column-add" ? 1 : 0),
      action === "column-delete",
    );
  } else {
    const cell = table.delimiter.cells[current.column];
    if (cell === undefined) return false;
    const value = action === "align-center" ? ":---:" : action === "align-right" ? "---:" : ":---";
    changes = { from: cell.contentFrom, to: cell.contentTo, insert: value };
  }
  view.dispatch({ changes, userEvent: "input.table", scrollIntoView: true });
  view.focus();
  return true;
}

function moveCell(view: EditorView, backwards: boolean, vertical = false): boolean {
  const table = findTables(view.state.doc.toString()).find(
    (candidate) => tableCellAt(candidate, view.state.selection.main.head) !== undefined,
  );
  if (table === undefined || view.state.field(rawTableField) === table.from) return false;
  const current = tableCellAt(table, view.state.selection.main.head);
  if (current === undefined) return false;
  const index =
    current.row * table.columns +
    current.column +
    (backwards ? -1 : 1) * (vertical ? table.columns : 1);
  if (index < 0) {
    view.dispatch({ selection: { anchor: Math.max(0, table.from - 1) }, scrollIntoView: true });
    return true;
  }
  const rowIndex = Math.floor(index / table.columns);
  if (rowIndex >= table.rows.length) {
    const position = table.to + 1 + 2 + (index % table.columns) * 3;
    view.dispatch({
      changes: { from: table.to, insert: `\n|${"  |".repeat(table.columns)}` },
      selection: { anchor: position },
      userEvent: "input.table",
      scrollIntoView: true,
    });
    return true;
  }
  const target = table.rows[rowIndex]?.cells[index % table.columns];
  if (target === undefined) return false;
  view.dispatch({
    selection: { anchor: target.contentFrom, head: target.contentTo },
    scrollIntoView: true,
  });
  return true;
}

function leaveTable(view: EditorView): boolean {
  const table = findTables(view.state.doc.toString()).find(
    (candidate) =>
      candidate.from <= view.state.selection.main.head &&
      candidate.to >= view.state.selection.main.head,
  );
  if (table === undefined) return false;
  if (table.to === view.state.doc.length)
    view.dispatch({
      changes: { from: table.to, insert: "\n\n" },
      selection: { anchor: table.to + 2 },
      userEvent: "input.table",
      scrollIntoView: true,
    });
  else {
    const firstAfterTable = table.to + 1;
    const position =
      view.state.doc.sliceString(firstAfterTable, firstAfterTable + 1) === "\n"
        ? firstAfterTable + 1
        : firstAfterTable;
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
  }
  return true;
}

function cellBoundary(view: EditorView, end: boolean, extend = false): boolean {
  const table = findTables(view.state.doc.toString()).find(
    (candidate) => tableCellAt(candidate, view.state.selection.main.head) !== undefined,
  );
  if (table === undefined || isTableSourceActive(view.state, table)) return false;
  const current = tableCellAt(table, view.state.selection.main.head);
  if (current === undefined) return false;
  const head = end ? current.cell.contentTo : current.cell.contentFrom;
  view.dispatch({
    selection: { anchor: extend ? view.state.selection.main.anchor : head, head },
    scrollIntoView: true,
  });
  return true;
}

export function tableEditing(isEditable: () => boolean): Extension {
  return [
    rawTableField,
    tableDecorations,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: (view) => isEditable() && moveCell(view, false) },
        { key: "Shift-Tab", run: (view) => isEditable() && moveCell(view, true) },
        { key: "Enter", run: (view) => isEditable() && moveCell(view, false, true) },
        { key: "Shift-Enter", run: (view) => isEditable() && moveCell(view, true, true) },
        { key: "Home", run: (view) => isEditable() && cellBoundary(view, false) },
        { key: "End", run: (view) => isEditable() && cellBoundary(view, true) },
        { key: "Shift-Home", run: (view) => isEditable() && cellBoundary(view, false, true) },
        { key: "Shift-End", run: (view) => isEditable() && cellBoundary(view, true, true) },
        { key: "Mod-Enter", run: (view) => isEditable() && leaveTable(view) },
        { key: "Escape", run: (view) => isEditable() && leaveTable(view) },
      ]),
    ),
    EditorView.baseTheme({
      ".cm-line.cm-table-row": {
        display: "table",
        tableLayout: "fixed",
        whiteSpace: "pre",
        width: "max-content",
        minWidth: "0",
        lineHeight: "1.6",
        padding: "0",
      },
      ".cm-table-cell": {
        display: "table-cell",
        boxSizing: "border-box",
        verticalAlign: "top",
        width: "14em",
        minWidth: "14em",
        minHeight: "1.8em",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        padding: "3px 6px",
        border:
          "1px solid var(--vscode-textSeparator-foreground, var(--vscode-editorWidget-border, #8886))",
      },
      ".cm-table-header": {
        fontWeight: "600",
        backgroundColor: "var(--vscode-editorWidget-background)",
      },
      ".cm-line.cm-table-delimiter": { fontSize: "0", lineHeight: "1px", minHeight: "1px" },
      ".cm-table-cell:focus-within": { outline: "1px solid var(--vscode-focusBorder)" },
    }),
  ];
}
