import {
  StateEffect,
  EditorState as State,
  Transaction,
  type TransactionSpec,
  StateField,
  EditorSelection,
  Prec,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  drawSelection,
  ViewPlugin,
  type ViewUpdate,
  type DecorationSet,
} from "@codemirror/view";
import {
  changeTableColumn,
  findTables,
  tableCellAt,
  type SourceTable,
} from "../../core/markdown/tableSource.js";

import { searchReveal, revealSearchMatch } from "./searchReveal.js";

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
function sourceRows(state: EditorState): readonly number[] {
  const match = state.field(searchReveal, false);
  if (match === undefined) return [];
  return findTables(state.doc.toString()).flatMap((table) =>
    [...table.rows, table.delimiter]
      .filter(
        (row) =>
          match.from <= row.to &&
          match.to >= row.from &&
          (row === table.delimiter ||
            !row.cells.some((cell) => match.from >= cell.from && match.to <= cell.to)),
      )
      .map((row) => row.from),
  );
}
/** The base renderer must reveal inline markers in a row being edited as source. */
export function tableSourceSelectionRanges(
  state: EditorState,
): readonly { from: number; to: number }[] {
  const rows = sourceRows(state);
  const tableFrom = state.field(rawTableField, false);
  if (rows.length === 0 && tableFrom === undefined) return [];
  return findTables(state.doc.toString()).flatMap((table) =>
    [...table.rows, table.delimiter].filter(
      (row) => tableFrom === table.from || rows.includes(row.from),
    ),
  );
}
const tableDecorations = StateField.define<DecorationSet>({
  create: build,
  update(value, transaction) {
    if (transaction.isUserEvent("input.type.compose")) return value.map(transaction.changes);
    if (
      !transaction.docChanged &&
      transaction.selection === undefined &&
      !transaction.isUserEvent("input.structural.settle") &&
      !transaction.effects.some((effect) => effect.is(rawTable) || effect.is(revealSearchMatch))
    )
      return value;
    return build(transaction.state);
  },
  provide: (field) => EditorView.outerDecorations.from(field),
});

function build(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const table of findTables(state.doc.toString())) {
    if (state.field(rawTableField) === table.from) continue;
    for (const [rowIndex, row] of table.rows.entries()) {
      if (sourceRows(state).includes(row.from)) continue;
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
    const selected = sourceRows(state).includes(table.delimiter.from);
    if (!selected) {
      ranges.push(Decoration.line({ class: "cm-table-delimiter" }).range(table.delimiter.from));
      ranges.push(Decoration.replace({}).range(table.delimiter.from, table.delimiter.to));
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * Raw row editing uses ordinary editor navigation, while cell navigation keeps
 * the existing table keymap. All source ranges remain writable.
 */
function isTableSourceActive(state: EditorState, table: SourceTable): boolean {
  if (state.field(rawTableField) === table.from) {
    return true;
  }
  return sourceRows(state).some((from) => from >= table.from && from <= table.to);
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
  public override coordsAt(dom: HTMLElement): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } {
    const rect = dom.getBoundingClientRect();
    return {
      left: rect.left + 7,
      right: rect.left + 7,
      top: rect.top + 4,
      bottom: rect.bottom - 4,
    };
  }
  public override ignoreEvent(): boolean {
    return true;
  }
}

export type TableAction =
  | "insert"
  | "row-append"
  | "column-append"
  | "row-add"
  | "row-delete"
  | "column-add"
  | "column-delete"
  | "align-left"
  | "align-center"
  | "align-right"
  | "source";

/** A context action may target a cell other than the visible caret. */
export function editTable(view: EditorView, action: TableAction, targetPosition?: number): boolean {
  if (view.composing || view.compositionStarted || (view.state.readOnly && action !== "source"))
    return false;
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
    (candidate) =>
      candidate.from <= (targetPosition ?? selected.head) &&
      candidate.to >= (targetPosition ?? selected.head),
  );
  if (table === undefined) return false;
  if (action === "source") {
    view.dispatch({
      effects: rawTable.of(view.state.field(rawTableField) === table.from ? undefined : table.from),
    });
    view.focus();
    return true;
  }
  const current = tableCellAt(table, targetPosition ?? selected.head) ?? { row: 0, column: 0 };
  let changes: ChangeSpec = [];
  let targetRow = current.row;
  let targetColumn = current.column;
  if (action === "row-add" || action === "row-append") {
    const row =
      action === "row-append"
        ? table.rows.at(-1) === table.rows[0]
          ? table.delimiter
          : table.rows.at(-1)
        : current.row === 0
          ? table.delimiter
          : table.rows[current.row];
    if (row === undefined) return false;
    changes = { from: row.to, insert: `\n|${"  |".repeat(table.columns)}` };
    targetRow = action === "row-append" ? table.rows.length : current.row + 1;
    if (action === "row-append") targetColumn = 0;
  } else if (action === "row-delete") {
    if (current.row === 0) return false;
    const row = table.rows[current.row];
    if (row === undefined) return false;
    changes = { from: row.from - 1, to: row.to, insert: "" };
    targetRow = Math.min(current.row, table.rows.length - 2);
  } else if (action === "column-add" || action === "column-delete" || action === "column-append") {
    changes = changeTableColumn(
      text,
      table,
      action === "column-append"
        ? table.columns
        : current.column + (action === "column-add" ? 1 : 0),
      action === "column-delete",
    );
    if (action === "column-append") targetColumn = table.columns;
    else if (action === "column-add") targetColumn += 1;
    else targetColumn = Math.min(current.column, table.columns - 2);
  } else {
    const cell = table.delimiter.cells[current.column];
    if (cell === undefined) return false;
    const value = action === "align-center" ? ":---:" : action === "align-right" ? "---:" : ":---";
    changes = { from: cell.contentFrom, to: cell.contentTo, insert: value };
  }
  const changeSet = view.state.changes(changes);
  if (changeSet.empty) return false;
  const next = findTables(changeSet.apply(view.state.doc).toString()).find(
    (candidate) => candidate.from === table.from,
  );
  const target = next?.rows[targetRow]?.cells[targetColumn];
  if (target === undefined) return false;
  const mapped = view.state.selection.map(changeSet);
  // Keep secondary selections; only the command's primary target moves.
  const selection = EditorSelection.create(
    mapped.ranges.map((range, index) =>
      index === mapped.mainIndex ? EditorSelection.cursor(target.contentFrom) : range,
    ),
    mapped.mainIndex,
  );
  view.dispatch({ changes: changeSet, selection, userEvent: "input.table", scrollIntoView: true });
  view.focus();
  return true;
}

function moveCell(view: EditorView, backwards: boolean, vertical = false): boolean {
  if (view.state.selection.ranges.length !== 1) return false;
  const table = findTables(view.state.doc.toString()).find(
    (candidate) => tableCellAt(candidate, view.state.selection.main.head) !== undefined,
  );
  if (table === undefined || isTableSourceActive(view.state, table)) return false;
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
    const lastCell = table.rows.at(-1)?.cells[index % table.columns];
    return (
      lastCell !== undefined &&
      editTable(view, vertical ? "row-add" : "row-append", lastCell.contentFrom)
    );
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
  if (view.state.selection.ranges.length !== 1) return false;
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
  if (view.state.selection.ranges.length !== 1) return false;
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

function clickCell(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0 || event.shiftKey || view.composing || view.compositionStarted)
    return false;
  const element =
    event.target instanceof Element ? event.target.closest<HTMLElement>("[data-table-cell]") : null;
  if (element === null) return false;
  const position = Number(element.dataset["tableCell"]);
  const table = findTables(view.state.doc.toString()).find((table) => tableCellAt(table, position));
  const cell = table === undefined ? undefined : tableCellAt(table, position)?.cell;
  if (cell === undefined) return false;
  const hit = view.posAtCoords({ x: event.clientX, y: event.clientY });
  const anchor = Math.max(cell.contentFrom, Math.min(cell.contentTo, hit ?? cell.contentFrom));
  event.preventDefault();
  view.dispatch({ selection: { anchor } });
  view.focus();
  return true;
}

/** Only normal cell input is protected. Explicit source edits and search replacement stay literal. */
function protectCells(transaction: Transaction): Transaction | readonly TransactionSpec[] {
  const state = transaction.startState;
  const tables = findTables(state.doc.toString());
  if (transaction.docChanged) {
    if (!(
      transaction.annotation(Transaction.userEvent) === "input" ||
      transaction.isUserEvent("input.type") ||
      transaction.isUserEvent("input.paste") ||
      transaction.isUserEvent("input.drop") ||
      transaction.isUserEvent("delete")
    ))
      return transaction;
    const cells = new Map<number, { from: number; to: number }>();
    const safety = { unsafe: false };
    transaction.changes.iterChanges((from, to) => {
      for (const table of tables) {
        if (to < table.from || from > table.to || isTableSourceActive(state, table)) continue;
        const cell = table.rows
          .flatMap((row) => row.cells)
          .find((cell) => from >= cell.contentFrom && to <= cell.contentTo);
        if (cell === undefined) safety.unsafe = true;
        else cells.set(cell.from, cell);
      }
    });
    if (safety.unsafe) return [];
    const corrections: ChangeSpec[] = [];
    for (const current of cells.values()) {
      const from = transaction.changes.mapPos(current.from, -1);
      const to = transaction.changes.mapPos(current.to, 1);
      const value = transaction.newDoc.sliceString(from, to);
      let escaped = false;
      for (let index = 0; index < value.length; index++) {
        const char = value[index];
        if (char === "|" && !escaped) corrections.push({ from: from + index, insert: "\\" });
        if (char === "\n")
          corrections.push({ from: from + index, to: from + index + 1, insert: " " });
        escaped = char === "\\" && !escaped;
      }
    }
    return corrections.length === 0
      ? transaction
      : [transaction, { changes: corrections, sequential: true }];
  }
  if (state.selection.ranges.length !== 1) return transaction;
  if (
    transaction.selection === undefined ||
    transaction.effects.some(
      (effect) => effect.is(revealSearchMatch) && effect.value !== undefined,
    ) ||
    transaction.state.field(searchReveal, false) !== undefined ||
    !transaction.newSelection.main.empty
  )
    return transaction;
  const head = transaction.newSelection.main.head;
  const target = tables.find((table) => table.from <= head && table.to >= head);
  if (target === undefined || isTableSourceActive(state, target)) return transaction;
  const cell =
    tableCellAt(target, head)?.cell ??
    target.rows
      .flatMap((row) => row.cells)
      .reduce((best, cell) =>
        Math.abs(cell.contentFrom - head) < Math.abs(best.contentFrom - head) ? cell : best,
      );
  const anchor = Math.max(cell.contentFrom, Math.min(cell.contentTo, head));
  return anchor === head ? transaction : [transaction, { selection: { anchor }, sequential: true }];
}

function tableControls(isEditable: () => boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly row = document.createElement("button");
      private readonly column = document.createElement("button");
      private hovered: number | undefined;
      private target: number | undefined;
      constructor(private readonly view: EditorView) {
        for (const [button, action, label] of [
          [this.row, "row-append", "末尾に行を追加"],
          [this.column, "column-append", "末尾に列を追加"],
        ] as const) {
          button.type = "button";
          button.className = "cm-table-add";
          button.dataset["tableAdd"] = action;
          button.textContent = "+";
          button.title = label;
          button.setAttribute("aria-label", label);
          button.hidden = true;
          button.addEventListener("mousedown", (event) => {
            event.preventDefault();
          });
          button.addEventListener("click", () => {
            if (isEditable() && this.target !== undefined) editTable(view, action, this.target);
          });
          view.dom.append(button);
        }
        view.dom.addEventListener("mouseover", this.over);
        view.dom.addEventListener("mouseleave", this.leave);
        view.scrollDOM.addEventListener("scroll", this.measure);
        this.measure();
      }
      private readonly over = (event: MouseEvent): void => {
        const element =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-table-from]")
            : null;
        if (element !== null) this.hovered = Number(element.dataset["tableFrom"]);
        else if (event.target !== this.row && event.target !== this.column)
          this.hovered = undefined;
        this.measure();
      };
      private readonly leave = (): void => {
        this.hovered = undefined;
        this.measure();
      };
      private readonly measure = (): void => {
        this.view.requestMeasure({
          key: this,
          read: (view) => {
            const table = findTables(view.state.doc.toString()).find(
              (table) =>
                this.hovered === table.from ||
                tableCellAt(table, view.state.selection.main.head) !== undefined,
            );
            if (table === undefined || isTableSourceActive(view.state, table)) return undefined;
            const rows = view.contentDOM.querySelectorAll<HTMLElement>(
              `[data-table-from="${String(table.from)}"]`,
            );
            const first = rows[0]?.getBoundingClientRect();
            const last = rows[rows.length - 1]?.getBoundingClientRect();
            const root = view.dom.getBoundingClientRect();
            if (
              first === undefined ||
              last === undefined ||
              last.bottom < root.top ||
              first.top > root.bottom
            )
              return undefined;
            return {
              first,
              last,
              root,
              target: tableCellAt(table, view.state.selection.main.head)
                ? view.state.selection.main.head
                : table.rows[0]?.cells[0]?.contentFrom,
            };
          },
          write: (bounds) => {
            this.target = bounds?.target;
            for (const button of [this.row, this.column]) {
              button.hidden = bounds === undefined;
              button.disabled = !isEditable();
            }
            if (bounds === undefined) return;
            const { first, last, root } = bounds;
            this.column.style.left = `${String(Math.max(0, Math.min(first.right - root.left, root.width - 28)))}px`;
            this.column.style.top = `${String(Math.max(0, first.top - root.top))}px`;
            this.row.style.left = `${String(Math.max(0, Math.min(first.left - root.left + 8, root.width - 28)))}px`;
            this.row.style.top = `${String(Math.max(0, Math.min(last.bottom - root.top - 1, root.height - 26)))}px`;
          },
        });
      };
      update(update: ViewUpdate): void {
        if (update.docChanged && this.hovered !== undefined)
          this.hovered = update.changes.mapPos(this.hovered);
        this.measure();
      }
      destroy(): void {
        this.view.dom.removeEventListener("mouseover", this.over);
        this.view.dom.removeEventListener("mouseleave", this.leave);
        this.view.scrollDOM.removeEventListener("scroll", this.measure);
        this.row.remove();
        this.column.remove();
      }
    },
  );
}

export function tableEditing(isEditable: () => boolean): Extension {
  return [
    rawTableField,
    searchReveal,
    drawSelection(),
    State.transactionFilter.of(protectCells),
    tableControls(isEditable),
    EditorView.domEventHandlers({ mousedown: clickCell }),
    tableDecorations,
    Prec.highest(
      keymap.of([
        { key: "Tab", stopPropagation: true, run: (view) => isEditable() && moveCell(view, false) },
        {
          key: "Shift-Tab",
          stopPropagation: true,
          run: (view) => isEditable() && moveCell(view, true),
        },
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
      ".cm-table-add": {
        position: "absolute",
        zIndex: "5",
        width: "26px",
        height: "26px",
        padding: "0",
        cursor: "pointer",
        color: "var(--vscode-button-foreground, white)",
        background: "var(--vscode-button-background, #1675b9)",
        border: "1px solid var(--vscode-focusBorder, #888)",
        borderRadius: "3px",
      },
      ".cm-table-add[hidden]": { display: "none" },
      ".cm-table-add:focus-visible": { outline: "2px solid var(--vscode-focusBorder)" },
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
