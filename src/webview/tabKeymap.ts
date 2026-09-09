import {
  countColumn,
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
} from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";

export interface TabKeymapGate {
  isTabEditable: () => boolean;
  getInsertSpaces: () => boolean;
  getTabSize: () => number;
  getIndentSize?: () => number;
}

export function createTabKeymap(gate: TabKeymapGate): readonly KeyBinding[] {
  const handleTab = (view: EditorView): boolean => {
    if (!gate.isTabEditable()) {
      return true;
    }
    if (hasMultilineSelection(view.state)) {
      indentSelectedLines(
        view,
        gate.getInsertSpaces(),
        gate.getTabSize(),
        gate.getIndentSize?.() ?? gate.getTabSize(),
      );
      return true;
    }
    insertTabAtCollapsedCarets(
      view,
      gate.getInsertSpaces(),
      gate.getTabSize(),
      gate.getIndentSize?.() ?? gate.getTabSize(),
    );
    return true;
  };

  const handleShiftTab = (view: EditorView): boolean => {
    if (!gate.isTabEditable()) {
      return true;
    }
    outdentSelectedLines(
      view,
      gate.getInsertSpaces(),
      gate.getTabSize(),
      gate.getIndentSize?.() ?? gate.getTabSize(),
    );
    return true;
  };

  return [
    {
      key: "Tab",
      preventDefault: true,
      run: handleTab,
      stopPropagation: true,
    },
    {
      key: "Shift-Tab",
      preventDefault: true,
      run: handleShiftTab,
      stopPropagation: true,
    },
  ];
}

function hasMultilineSelection(state: EditorState): boolean {
  return state.selection.ranges.some(
    (selection) =>
      state.doc.lineAt(selection.from).number !== state.doc.lineAt(selection.to).number,
  );
}

function insertTabAtCollapsedCarets(
  view: EditorView,
  insertSpaces: boolean,
  tabSize: number,
  indentSize: number,
): void {
  const normalizedTabSize = normalizeTabSize(tabSize);
  const transaction = view.state.changeByRange((selection) => {
    const line = view.state.doc.lineAt(selection.from);
    const column = countColumn(line.text, normalizedTabSize, selection.from - line.from);
    const insertionSize = nextTabStopDistance(column, normalizeTabSize(indentSize));
    const insert = insertSpaces ? " ".repeat(insertionSize) : "\t";
    return {
      changes: { from: selection.from, to: selection.to, insert },
      range: EditorSelection.cursor(selection.from + insert.length),
    };
  });
  view.dispatch({ ...transaction, userEvent: "input.indent", scrollIntoView: true });
}

function indentSelectedLines(
  view: EditorView,
  insertSpaces: boolean,
  tabSize: number,
  indentSize: number,
): void {
  const size = normalizeTabSize(insertSpaces ? indentSize : tabSize);
  const changes = selectedLines(view.state).map((line) => {
    const leading = /^[\t ]*/u.exec(line.text)?.[0] ?? "";
    const column = countColumn(leading, normalizeTabSize(tabSize));
    const target = column + nextTabStopDistance(column, size);
    const insert = insertSpaces ? " ".repeat(target) : "\t".repeat(Math.floor(target / size));
    return { from: line.from, to: line.from + leading.length, insert };
  });
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: "input.indent" });
  }
}

function outdentSelectedLines(
  view: EditorView,
  insertSpaces: boolean,
  tabSize: number,
  indentSize: number,
): void {
  const normalizedTabSize = normalizeTabSize(insertSpaces ? indentSize : tabSize);
  const changes: ChangeSpec[] = [];
  for (const line of selectedLines(view.state)) {
    const leading = /^[\t ]*/u.exec(line.text)?.[0] ?? "";
    const column = countColumn(leading, normalizeTabSize(tabSize));
    if (column > 0) {
      const target = column - (column % normalizedTabSize || normalizedTabSize);
      const insert = insertSpaces ? " ".repeat(target) : "\t".repeat(target / normalizedTabSize);
      changes.push({ from: line.from, to: line.from + leading.length, insert });
    }
  }
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: "delete.outdent" });
  }
}

function selectedLines(state: EditorState): readonly Line[] {
  const lineNumbers = new Set<number>();
  for (const selection of state.selection.ranges) {
    const first = state.doc.lineAt(selection.from).number;
    const endLine = state.doc.lineAt(selection.to);
    const last =
      selection.empty || selection.to !== endLine.from ? endLine.number : endLine.number - 1;
    for (let lineNumber = first; lineNumber <= Math.max(first, last); lineNumber += 1) {
      lineNumbers.add(lineNumber);
    }
  }
  return [...lineNumbers]
    .sort((left, right) => left - right)
    .map((lineNumber) => state.doc.line(lineNumber));
}

function nextTabStopDistance(column: number, tabSize: number): number {
  const remainder = column % tabSize;
  return remainder === 0 ? tabSize : tabSize - remainder;
}

function normalizeTabSize(tabSize: number): number {
  if (!Number.isFinite(tabSize) || tabSize <= 0) {
    return 1;
  }
  return Math.max(1, Math.trunc(tabSize));
}
