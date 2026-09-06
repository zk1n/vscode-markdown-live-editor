import { countColumn, type ChangeSpec, type EditorState, type Line } from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";

export interface TabKeymapGate {
  isTabEditable: () => boolean;
  getInsertSpaces: () => boolean;
  getTabSize: () => number;
}

export function createTabKeymap(gate: TabKeymapGate): readonly KeyBinding[] {
  const handleTab = (view: EditorView): boolean => {
    if (!gate.isTabEditable()) {
      return true;
    }
    if (hasSelection(view.state)) {
      indentSelectedLines(view, gate.getInsertSpaces(), gate.getTabSize());
      return true;
    }
    insertTabAtCollapsedCarets(view, gate.getInsertSpaces(), gate.getTabSize());
    return true;
  };

  const handleShiftTab = (view: EditorView): boolean => {
    if (!gate.isTabEditable()) {
      return true;
    }
    outdentSelectedLines(view, gate.getTabSize());
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

function hasSelection(state: EditorState): boolean {
  return state.selection.ranges.some((selection) => selection.from !== selection.to);
}

function insertTabAtCollapsedCarets(
  view: EditorView,
  insertSpaces: boolean,
  tabSize: number,
): void {
  if (!insertSpaces) {
    view.dispatch(view.state.replaceSelection("\t"));
    return;
  }

  const normalizedTabSize = normalizeTabSize(tabSize);
  const changes = view.state.selection.ranges.map((selection) => {
    const line = view.state.doc.lineAt(selection.from);
    const column = countColumn(line.text, normalizedTabSize, selection.from - line.from);
    const insertionSize = nextTabStopDistance(column, normalizedTabSize);
    return {
      from: selection.from,
      to: selection.to,
      insert: " ".repeat(insertionSize),
    };
  });
  view.dispatch({ changes });
}

function indentSelectedLines(view: EditorView, insertSpaces: boolean, tabSize: number): void {
  const unit = insertSpaces ? " ".repeat(normalizeTabSize(tabSize)) : "\t";
  const changes = selectedLines(view.state).map((line) => ({ from: line.from, insert: unit }));
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: "input.indent" });
  }
}

function outdentSelectedLines(view: EditorView, tabSize: number): void {
  const normalizedTabSize = normalizeTabSize(tabSize);
  const changes: ChangeSpec[] = [];
  for (const line of selectedLines(view.state)) {
    if (line.text.startsWith("\t")) {
      changes.push({ from: line.from, to: line.from + 1, insert: "" });
      continue;
    }
    const leadingSpaces = /^ +/u.exec(line.text)?.[0].length ?? 0;
    const deleteCount = Math.min(leadingSpaces, normalizedTabSize);
    if (deleteCount > 0) {
      changes.push({ from: line.from, to: line.from + deleteCount, insert: "" });
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
