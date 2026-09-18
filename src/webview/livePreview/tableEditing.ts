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
  BlockWrapper,
  EditorView,
  WidgetType,
  keymap,
  drawSelection,
  type DecorationSet,
  type MouseSelectionStyle,
} from "@codemirror/view";
import {
  changeTableColumn,
  findTables,
  tableCellAt,
  type TableCell,
  type SourceTable,
} from "../../core/markdown/tableSource.js";

import { searchReveal, revealSearchMatch } from "./searchReveal.js";
import { tableControls } from "./tableControls.js";
import { editorPreferences } from "../editorPreferences.js";
import { sourceLineSelection } from "../sourceLines.js";
import { tableWidths, setTableWidths } from "./tableMeasurements.js";

// The cells are the main CodeMirror contentDOM: native selection, clipboard,
// IME, Save and history all retain the same source and controller owner.
const rawTable = StateEffect.define<{ from: number; to: number } | undefined>();
const rawTableField = StateField.define<{ from: number; to: number } | undefined>({
  create: () => undefined,
  update(value, transaction) {
    let next =
      value === undefined
        ? undefined
        : {
            from: transaction.changes.mapPos(value.from, -1),
            to: transaction.changes.mapPos(value.to, 1),
          };
    transaction.changes.iterChangedRanges((from, to) => {
      if (value && from <= value.from && to >= value.to && from < to) next = undefined;
    });
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
  const raw = state.field(rawTableField, false);
  return [
    ...(raw === undefined ? [] : [raw]),
    ...findTables(state.doc.toString()).flatMap((table) =>
      [...table.rows, table.delimiter].filter((row) => rows.includes(row.from)),
    ),
  ];
}
export function returnTableToLive(view: EditorView): boolean {
  if (
    view.state.field(rawTableField, false) === undefined ||
    view.composing ||
    view.compositionStarted
  )
    return false;
  view.dispatch({ effects: rawTable.of(undefined) });
  view.focus();
  return true;
}
export function tableSourceActive(state: EditorState): boolean {
  return state.field(rawTableField, false) !== undefined;
}
const tableDecorations = StateField.define<DecorationSet>({
  create: build,
  update(value, transaction) {
    if (transaction.isUserEvent("input.type.compose")) return value.map(transaction.changes);
    if (
      !transaction.docChanged &&
      transaction.selection === undefined &&
      !transaction.isUserEvent("input.structural.settle") &&
      transaction.startState.facet(editorPreferences) ===
        transaction.state.facet(editorPreferences) &&
      !transaction.effects.some(
        (effect) =>
          effect.is(rawTable) || effect.is(revealSearchMatch) || effect.is(setTableWidths),
      )
    )
      return value;
    return build(transaction.state);
  },
  provide: (field) => [
    EditorView.outerDecorations.from(field),
    EditorView.blockWrappers.compute([field], (state) =>
      BlockWrapper.set(
        findTables(state.doc.toString())
          .filter((table) => !isTableSourceActive(state, table))
          .map((table) =>
            BlockWrapper.create({
              tagName: "div",
              attributes: { class: "cm-table-scroll", "data-table-scroll": String(table.from) },
            }).range(table.from, table.to),
          ),
      ),
    ),
  ],
});

function build(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const table of findTables(state.doc.toString())) {
    if (state.field(rawTableField)?.from === table.from) continue;
    ranges.push(
      Decoration.widget({
        widget: new TableAppendSpace(state.facet(editorPreferences).tableBandSize + 4),
        block: true,
        side: -1,
      }).range(table.from),
    );
    const widths = Array.from({ length: table.columns }, (_, index) =>
      Math.max(
        0,
        ...table.rows.map(
          (row) => state.field(tableWidths).get(row.cells[index]?.contentFrom ?? -1) ?? 0,
        ),
      ),
    );
    for (const [rowIndex, row] of table.rows.entries()) {
      if (sourceRows(state).includes(row.from)) continue;
      ranges.push(
        Decoration.line({
          class: `cm-table-row${rowIndex === table.rows.length - 1 ? " cm-table-last-row" : ""}`,
          attributes: { "data-table-from": String(table.from), "data-table-row": String(rowIndex) },
        }).range(row.from),
      );
      for (const [column, cell] of row.cells.entries()) {
        const css = `cm-table-cell${rowIndex === 0 ? " cm-table-header" : ""}`;
        const attrs = {
          style: `text-align:${table.alignments[column] ?? "left"};${(widths[column] ?? 0) > 0 ? `width:${String(widths[column])}px;min-width:${String(widths[column])}px` : ""}`,
          "data-table-cell": String(cell.contentFrom),
        };
        if (cell.from < cell.to)
          ranges.push(Decoration.mark({ class: css, attributes: attrs }).range(cell.from, cell.to));
        else
          ranges.push(
            Decoration.widget({ widget: new EmptyCell(cell.from, widths[column]), side: 1 }).range(
              cell.from,
            ),
          );
      }
      for (const pipe of row.pipes) ranges.push(Decoration.replace({}).range(pipe, pipe + 1));
    }
    const selected = sourceRows(state).includes(table.delimiter.from);
    if (!selected) {
      ranges.push(Decoration.line({ class: "cm-table-delimiter" }).range(table.delimiter.from));
      ranges.push(Decoration.replace({}).range(table.delimiter.from, table.delimiter.to));
    }
    if (!sourceRows(state).includes(table.rows[table.rows.length - 1]?.from ?? table.to))
      ranges.push(
        Decoration.widget({
          widget: new TableAppendSpace(state.facet(editorPreferences).tableBandSize + 4),
          block: true,
          side: 1,
        }).range(table.to),
      );
  }
  return Decoration.set(ranges, true);
}

/** A measured, non-editable block; line margins are absent from CM's height map. */
class TableAppendSpace extends WidgetType {
  public constructor(private readonly height: number) {
    super();
  }
  public override eq(other: TableAppendSpace): boolean {
    return this.height === other.height;
  }
  public override get estimatedHeight(): number {
    return this.height;
  }
  public override toDOM(): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-table-append-space";
    dom.style.height = `${String(this.height)}px`;
    dom.setAttribute("aria-hidden", "true");
    return dom;
  }
}

/**
 * Raw row editing uses ordinary editor navigation, while cell navigation keeps
 * the existing table keymap. All source ranges remain writable.
 */
function isTableSourceActive(state: EditorState, table: SourceTable): boolean {
  if (state.field(rawTableField)?.from === table.from) {
    return true;
  }
  return sourceRows(state).some((from) => from >= table.from && from <= table.to);
}

class EmptyCell extends WidgetType {
  public constructor(
    private readonly position: number,
    private readonly width?: number,
  ) {
    super();
  }
  public override eq(other: EmptyCell): boolean {
    return other.position === this.position && other.width === this.width;
  }
  public override toDOM(view: EditorView): HTMLElement {
    const cell = document.createElement("span");
    cell.className = "cm-table-cell";
    if (this.width !== undefined) {
      cell.style.width = `${String(this.width)}px`;
      cell.style.minWidth = cell.style.width;
    }
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

interface TableSelectionRectangle {
  readonly table: SourceTable;
  readonly topRow: number;
  readonly bottomRow: number;
  readonly leftColumn: number;
  readonly rightColumn: number;
}

function isMultiCellRectangle(rectangle: TableSelectionRectangle): boolean {
  return rectangle.topRow !== rectangle.bottomRow || rectangle.leftColumn !== rectangle.rightColumn;
}

function tableSelectionRectangle(state: EditorState): TableSelectionRectangle | undefined {
  if (
    state.selection.ranges.length !== 1 ||
    state.selection.main.empty ||
    state.field(sourceLineSelection, false) === true
  )
    return undefined;
  const selection = state.selection.main;
  const tables = findTables(state.doc.toString());
  const table = tables.find(
    (candidate) =>
      candidate.from < selection.to &&
      candidate.to > selection.from &&
      selection.from >= candidate.from &&
      selection.to <= candidate.to,
  );
  if (table === undefined || isTableSourceActive(state, table)) return undefined;
  // An explicit source selection keeps CodeMirror's native clipboard behavior.
  if (selection.from <= table.from && selection.to >= table.to) return undefined;
  const start = tableCellAt(table, selection.from);
  const end = tableCellAt(table, Math.max(selection.from, selection.to - 1));
  if (start === undefined || end === undefined) return undefined;
  return {
    table,
    topRow: Math.min(start.row, end.row),
    bottomRow: Math.max(start.row, end.row),
    leftColumn: Math.min(start.column, end.column),
    rightColumn: Math.max(start.column, end.column),
  };
}

function rectangleCells(
  rectangle: TableSelectionRectangle,
): readonly (readonly TableCell[])[] | undefined {
  const rows: (readonly TableCell[])[] = [];
  for (let row = rectangle.topRow; row <= rectangle.bottomRow; row += 1) {
    const cells = rectangle.table.rows[row]?.cells.slice(
      rectangle.leftColumn,
      rectangle.rightColumn + 1,
    );
    if (cells?.length !== rectangle.rightColumn - rectangle.leftColumn + 1) return undefined;
    rows.push(cells);
  }
  return rows;
}

function tableClipboardText(
  state: EditorState,
  rectangle: TableSelectionRectangle,
): string | undefined {
  const rows = rectangleCells(rectangle);
  if (rows === undefined || (rows.length === 1 && rows[0]?.length === 1)) return undefined;
  return rows
    .map((cells) =>
      cells.map((cell) => state.sliceDoc(cell.contentFrom, cell.contentTo)).join("\t"),
    )
    .join("\n");
}

function setClipboardText(clipboard: DataTransfer | null, text: string): boolean {
  if (clipboard === null) return false;
  try {
    clipboard.clearData();
    clipboard.setData("text/plain", text);
    if (clipboard.getData("text/plain") !== text) return false;
  } catch {
    return false;
  }
  // Keep an explicit TSV flavor when the browser permits custom clipboard
  // types so one-column multi-row copies remain distinguishable from prose.
  try {
    clipboard.setData("text/tab-separated-values", text);
  } catch {
    // Some hosts expose only text/plain. It is still a successful clipboard
    // write for cut safety; paste falls back to tab-containing text.
  }
  return true;
}

function escapeTableCellValue(value: string): string {
  let result = "";
  let escaped = false;
  for (const char of value) {
    if (char === "\n" || char === "\r") result += " ";
    else if (char === "|" && !escaped) result += "\\|";
    else result += char;
    escaped = char === "\\" && !escaped;
  }
  return result;
}

interface ClipboardMatrix {
  readonly rows: readonly (readonly string[])[] | undefined;
}

function clipboardMatrix(text: string, explicitTsv: boolean): ClipboardMatrix | undefined {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!explicitTsv && !normalized.includes("\t")) return undefined;
  const withoutTrailingBreak = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const rows = withoutTrailingBreak.split("\n").map((row) => row.split("\t"));
  const width = rows[0]?.length ?? 0;
  if (width <= 1 && rows.length <= 1) return undefined;
  if (width === 0 || rows.some((row) => row.length !== width)) return { rows: undefined };
  return { rows };
}

function clipboardPasteTarget(
  state: EditorState,
): { readonly table: SourceTable; readonly row: number; readonly column: number } | undefined {
  if (state.selection.ranges.length !== 1 || state.field(sourceLineSelection, false) === true)
    return undefined;
  const position = state.selection.main.from;
  const table = findTables(state.doc.toString()).find(
    (candidate) => candidate.from <= position && candidate.to >= position,
  );
  if (table === undefined || isTableSourceActive(state, table)) return undefined;
  const cell = tableCellAt(table, position);
  return cell === undefined ? undefined : { table, row: cell.row, column: cell.column };
}

function handleTableCopy(event: ClipboardEvent, view: EditorView): boolean {
  if (view.composing || view.compositionStarted) return false;
  const rectangle = tableSelectionRectangle(view.state);
  if (rectangle === undefined) return false;
  const text = tableClipboardText(view.state, rectangle);
  if (text === undefined) return false;
  // A rectangle is an explicit table operation. When a ClipboardEvent carries
  // a DataTransfer, do not let CM fall back to a source-range copy if writing
  // that transfer fails. A null transfer is the old capture-copy path, which
  // remains owned by CM.
  if (event.clipboardData === null) return false;
  event.preventDefault();
  setClipboardText(event.clipboardData, text);
  return true;
}

function handleTableCut(
  event: ClipboardEvent,
  view: EditorView,
  isEditable: () => boolean,
): boolean {
  if (view.composing || view.compositionStarted || !isEditable() || view.state.readOnly)
    return false;
  const rectangle = tableSelectionRectangle(view.state);
  if (rectangle === undefined) return false;
  const text = tableClipboardText(view.state, rectangle);
  if (text === undefined) return false;
  event.preventDefault();
  // Never clear source until the clipboard write has been confirmed.
  if (!setClipboardText(event.clipboardData, text)) return true;
  const rows = rectangleCells(rectangle);
  if (rows === undefined) return true;
  const changes = rows.flatMap((cells) =>
    cells
      .filter((cell) => cell.contentFrom !== cell.contentTo)
      .map((cell) => ({ from: cell.contentFrom, to: cell.contentTo, insert: "" })),
  );
  if (changes.length > 0) view.dispatch({ changes, userEvent: "delete.cut", scrollIntoView: true });
  return true;
}

function handleTablePaste(
  event: ClipboardEvent,
  view: EditorView,
  isEditable: () => boolean,
): boolean {
  if (
    view.composing ||
    view.compositionStarted ||
    !isEditable() ||
    view.state.readOnly ||
    event.clipboardData === null
  )
    return false;
  // File/image transfers remain owned by imageEditing and the browser's native
  // route. Only text-only TSV is a table matrix operation.
  if ([...event.clipboardData.items].some((item) => item.kind === "file")) return false;
  const explicitTsv = [...event.clipboardData.types].some(
    (type) => type.toLowerCase() === "text/tab-separated-values",
  );
  let text: string;
  try {
    text = event.clipboardData.getData("text/plain");
    if (text === "" && explicitTsv) text = event.clipboardData.getData("text/tab-separated-values");
  } catch {
    return false;
  }
  const target = clipboardPasteTarget(view.state);
  if (target === undefined) return false;
  const selectionRectangle = tableSelectionRectangle(view.state);
  const matrix = clipboardMatrix(
    text,
    explicitTsv || (selectionRectangle !== undefined && isMultiCellRectangle(selectionRectangle)),
  );
  if (matrix === undefined) return false;
  event.preventDefault();
  if (matrix.rows === undefined) return true;
  const rows = matrix.rows;
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  if (
    height === 0 ||
    width === 0 ||
    target.row + height > target.table.rows.length ||
    target.column + width > target.table.columns
  )
    return true;
  const cells: { readonly cell: TableCell; readonly value: string }[] = [];
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const cell = target.table.rows[target.row + row]?.cells[target.column + column];
      const value = rows[row]?.[column];
      if (cell === undefined || value === undefined) return true;
      cells.push({ cell, value: escapeTableCellValue(value) });
    }
  }
  const changes = cells.map(({ cell, value }) => ({
    from: cell.contentFrom,
    to: cell.contentTo,
    insert: value,
  }));
  const changeSet = view.state.changes(changes);
  if (changeSet.empty) return true;
  const last = cells.at(-1);
  if (last === undefined) return true;
  const caret = changeSet.mapPos(last.cell.contentFrom, -1) + last.value.length;
  view.dispatch({
    changes: changeSet,
    selection: { anchor: caret },
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  return true;
}

/** A context action may target a cell other than the visible caret. */
export function editTable(view: EditorView, action: TableAction, targetPosition?: number): boolean {
  if (view.composing || view.compositionStarted || (view.state.readOnly && action !== "source"))
    return false;
  const text = view.state.doc.toString();
  const selected = view.state.selection.main;
  if (action === "source" && targetPosition === undefined && returnTableToLive(view)) return true;
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
      effects: rawTable.of(
        view.state.field(rawTableField)?.from === table.from
          ? undefined
          : { from: table.from, to: table.to },
      ),
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
    // Keep the header and at least one data row. A header-only table is not a
    // valid editable target, and deleting its final data row loses the table's
    // body without offering a recovery path through the table controls.
    if (current.row === 0 || table.rows.length <= 2) return false;
    const row = table.rows[current.row];
    if (row === undefined) return false;
    changes = { from: row.from - 1, to: row.to, insert: "" };
    targetRow = Math.min(current.row, table.rows.length - 2);
  } else if (action === "column-add" || action === "column-delete" || action === "column-append") {
    if (action === "column-delete" && table.columns <= 1) return false;
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
  if (view.composing || view.compositionStarted || view.state.selection.ranges.length !== 1)
    return false;
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

/** Arrow motion never adds source or selects whole cells. Geometry is measured only on a key. */
function arrowCell(view: EditorView, forward: boolean, vertical: boolean): boolean {
  if (view.composing || view.compositionStarted || view.state.selection.ranges.length !== 1)
    return false;
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const table = findTables(view.state.doc.toString()).find((item) =>
    tableCellAt(item, selection.head),
  );
  if (!table || isTableSourceActive(view.state, table)) return false;
  const current = tableCellAt(table, selection.head);
  if (!current) return false;
  let anchor: number | undefined;
  let goalColumn = selection.goalColumn;
  if (!vertical) {
    if (
      forward ? selection.head < current.cell.contentTo : selection.head > current.cell.contentFrom
    )
      return false; // CM's grapheme/bidi motion inside the content.
    const index = current.row * table.columns + current.column + (forward ? 1 : -1);
    const target =
      table.rows[Math.floor(index / table.columns)]?.cells[(index + table.columns) % table.columns];
    anchor = target ? (forward ? target.contentFrom : target.contentTo) : undefined;
  } else {
    const coords = view.coordsAtPos(selection.head);
    const edge = view.coordsAtPos(forward ? current.cell.contentTo : current.cell.contentFrom);
    const contentLeft = view.contentDOM.getBoundingClientRect().left;
    const x = goalColumn === undefined ? coords?.left : contentLeft + goalColumn;
    if (goalColumn === undefined && x !== undefined) goalColumn = x - contentLeft;
    if (coords && edge && (forward ? coords.bottom < edge.top : coords.top > edge.bottom)) {
      const element = view.contentDOM.querySelector<HTMLElement>(
        `[data-table-cell="${String(current.cell.contentFrom)}"]`,
      );
      const lineHeight = element
        ? Number.parseFloat(getComputedStyle(element).lineHeight)
        : view.defaultLineHeight;
      const y = (coords.top + coords.bottom) / 2 + (forward ? 1 : -1) * lineHeight;
      const moved = cellPositionAtCoords(view, x ?? coords.left, y);
      if (
        moved !== null &&
        moved >= current.cell.contentFrom &&
        moved <= current.cell.contentTo &&
        moved !== selection.head
      ) {
        view.dispatch({
          selection: EditorSelection.create([
            EditorSelection.cursor(moved, 0, undefined, goalColumn),
          ]),
          scrollIntoView: true,
          userEvent: "select",
        });
        return true;
      }
    }
    const target = table.rows[current.row + (forward ? 1 : -1)]?.cells[current.column];
    if (target) {
      const targetCoords = view.coordsAtPos(forward ? target.contentFrom : target.contentTo);
      const hit =
        x !== undefined && targetCoords
          ? cellPositionAtCoords(view, x, (targetCoords.top + targetCoords.bottom) / 2)
          : null;
      anchor = Math.max(target.contentFrom, Math.min(target.contentTo, hit ?? target.contentFrom));
    }
  }
  // At a document boundary retain a visible end cell; adding a paragraph is an explicit Enter action.
  anchor ??= forward
    ? table.to < view.state.doc.length
      ? table.to + 1
      : table.rows.at(-1)?.cells.at(-1)?.contentTo
    : table.from > 0
      ? table.from - 1
      : table.rows[0]?.cells[0]?.contentFrom;
  if (anchor === undefined) return false;
  view.dispatch({
    selection: EditorSelection.create([
      EditorSelection.cursor(anchor, 0, undefined, vertical ? goalColumn : undefined),
    ]),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

function cellPositionAtCoords(view: EditorView, x: number, y: number): number | null {
  // CSS table cells wrap independently inside one CM source line. The standard
  // CSSOM caret hit test follows those rendered text fragments before mapping
  // back to the *same* EditorView source (no alternate editor/selection owner).
  const owner = view.dom.ownerDocument;
  const position =
    typeof owner.caretPositionFromPoint === "function" ? owner.caretPositionFromPoint(x, y) : null;
  if (position && view.contentDOM.contains(position.offsetNode))
    return view.posAtDOM(position.offsetNode, position.offset);
  return view.posAtCoords({ x, y });
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
  if (view.composing || view.compositionStarted || view.state.selection.ranges.length !== 1)
    return false;
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

function tablePointerSelection(view: EditorView, event: MouseEvent): MouseSelectionStyle | null {
  if (
    event.button !== 0 ||
    event.detail > 1 ||
    view.composing ||
    view.compositionStarted ||
    findTables(view.state.doc.toString()).length === 0
  )
    return null;
  const hit = (event: MouseEvent): number => {
    const element = view.dom.ownerDocument.elementFromPoint(event.clientX, event.clientY);
    // CSS table-cell fragments do not have inline source order. Use the browser's
    // text hit test for those fragments, through CM's own mouse-selection lifecycle.
    if (element?.closest("[data-table-cell]") && view.contentDOM.contains(element))
      return (
        cellPositionAtCoords(view, event.clientX, event.clientY) ?? view.state.selection.main.head
      );
    return view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  };
  let start = hit(event);
  let selection = view.state.selection;
  return {
    get(current, extend, multiple) {
      const range = EditorSelection.range(extend ? selection.main.anchor : start, hit(current));
      return multiple ? selection.addRange(range) : EditorSelection.create([range]);
    },
    update(update) {
      if (update.docChanged) {
        start = update.changes.mapPos(start);
        selection = selection.map(update.changes);
      }
    },
  };
}

/** Only normal cell input is protected. Explicit source edits and search replacement stay literal. */
function replacesExplicitWholeTableSelection(
  transaction: Transaction,
  tables: readonly SourceTable[],
): boolean {
  const selection = transaction.startState.selection;
  if (selection.ranges.length !== 1 || selection.main.empty) return false;
  const selectedTables = tables.filter(
    (table) => table.from < selection.main.to && table.to > selection.main.from,
  );
  if (
    selectedTables.length === 0 ||
    !selectedTables.every(
      (table) => selection.main.from <= table.from && selection.main.to >= table.to,
    )
  )
    return false;
  let count = 0;
  let matches = true;
  transaction.changes.iterChanges((from, to) => {
    count++;
    if (from !== selection.main.from || to !== selection.main.to) matches = false;
  });
  return count === 1 && matches;
}
function protectCells(transaction: Transaction): Transaction | readonly TransactionSpec[] {
  const state = transaction.startState;
  if (state.field(sourceLineSelection, false) === true && !state.selection.main.empty)
    return transaction;
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
    // Ctrl+A and an explicit table-spanning source selection are literal source
    // operations. Do not turn a paste or cut into a no-op merely because it
    // crosses cell delimiters; partial/multiple-cell edits remain protected.
    if (replacesExplicitWholeTableSelection(transaction, tables)) return transaction;
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
  if (state.selection.ranges.length !== 1 || transaction.isUserEvent("input.type.compose"))
    return transaction;
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

export function tableEditing(isEditable: () => boolean): Extension {
  return [
    rawTableField,
    tableWidths,
    searchReveal,
    drawSelection(),
    State.transactionFilter.of(protectCells),
    Prec.highest(
      EditorView.domEventHandlers({
        copy: (event, view) => handleTableCopy(event, view),
        cut: (event, view) => handleTableCut(event, view, isEditable),
        paste: (event, view) => handleTablePaste(event, view, isEditable),
      }),
    ),
    tableControls(isEditable, isTableSourceActive, editTable),
    EditorView.mouseSelectionStyle.of(tablePointerSelection),
    tableDecorations,
    Prec.highest(
      keymap.of([
        { key: "ArrowLeft", run: (view) => arrowCell(view, false, false) },
        { key: "ArrowRight", run: (view) => arrowCell(view, true, false) },
        { key: "ArrowUp", run: (view) => arrowCell(view, false, true) },
        { key: "ArrowDown", run: (view) => arrowCell(view, true, true) },
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
        width: "18px",
        height: "18px",
        boxSizing: "border-box",
        padding: "0",
        cursor: "pointer",
        margin: "0",
        color: "transparent",
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: "3px",
      },
      ".cm-table-add[hidden]": { display: "none" },
      ".cm-table-add:hover, .cm-table-add:focus-visible": {
        color: "var(--vscode-editor-foreground, currentColor)",
        background: "var(--vscode-toolbar-hoverBackground, #80808044)",
        borderColor: "var(--vscode-contrastBorder, transparent)",
      },
      ".cm-table-scroll": { maxWidth: "100%", overflowX: "auto", scrollbarWidth: "thin" },
      ".cm-table-delete:hover, .cm-table-delete:focus-visible": {
        color: "var(--vscode-errorForeground, #d44)",
        background: "var(--vscode-inputValidation-errorBackground, #d443)",
      },
      ".cm-table-add:disabled": { cursor: "not-allowed" },
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
      // Always reserve the append band's space. It must never cover the
      // next source line, and hovering must not change the height map.
      ".cm-table-append-space": { height: "22px", pointerEvents: "none" },
      ".cm-table-cell": {
        display: "table-cell",
        boxSizing: "border-box",
        verticalAlign: "top",
        width: "var(--cm-table-min-width, 4.75em)",
        minWidth: "var(--cm-table-min-width, 4.75em)",
        minHeight: "1.8em",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        padding: "3px 6px",
        border:
          "1px solid var(--vscode-textSeparator-foreground, var(--vscode-editorWidget-border, #8886))",
      },
      ".cm-table-header": {
        fontWeight: "600",
        // A translucent tint lets CM's selection layer beneath content stay visible.
        backgroundColor:
          "color-mix(in srgb, var(--vscode-editor-foreground, #888) 8%, transparent)",
      },
      ".cm-line.cm-table-delimiter": { fontSize: "0", lineHeight: "1px", minHeight: "1px" },
      ".cm-table-cell:focus-within": { outline: "1px solid var(--vscode-focusBorder)" },
    }),
  ];
}
