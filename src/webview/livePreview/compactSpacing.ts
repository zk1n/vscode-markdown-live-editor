import { EditorState, Prec, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { structuralBlanks } from "../structuralSpacing.js";

class StructuralGap extends WidgetType {
  public override eq(): boolean {
    return true;
  }
  public override toDOM(): HTMLElement {
    const gap = document.createElement("div");
    gap.className = "cm-structural-gap";
    gap.setAttribute("aria-hidden", "true");
    return gap;
  }
  public override get estimatedHeight(): number {
    return 6;
  }
  public override ignoreEvent(): boolean {
    return false;
  }
}
const compactLines = StateField.define<DecorationSet>({
  create: build,
  update(value, transaction) {
    if (transaction.isUserEvent("input.type.compose")) return value.map(transaction.changes);
    return build(transaction.state);
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});
function build(state: EditorState): DecorationSet {
  return Decoration.set(
    structuralBlanks(state).map(({ from, to }) =>
      Decoration.replace({ block: true, widget: new StructuralGap(), inclusive: false }).range(
        from,
        to,
      ),
    ),
  );
}
function removeSeparator(view: EditorView, backwards: boolean): boolean {
  if (
    view.composing ||
    view.compositionStarted ||
    view.state.readOnly ||
    view.state.selection.ranges.length !== 1 ||
    !view.state.selection.main.empty
  )
    return false;
  const caret = view.state.selection.main.head;
  const gap = structuralBlanks(view.state).find(
    (item) => (backwards ? item.to : item.from) === caret,
  );
  if (gap === undefined) return false;
  // Consume just the extra separator, retaining the newline between real lines.
  view.dispatch({
    changes: { from: gap.from + 1, to: gap.to },
    selection: { anchor: backwards ? gap.from + 1 : gap.from },
    userEvent: "delete.structural",
  });
  return true;
}
export const compactSpacing: Extension = [
  compactLines,
  EditorState.transactionFilter.of((tr) => {
    if (
      tr.isUserEvent("input.type.compose") ||
      tr.newSelection.ranges.length !== 1 ||
      !tr.newSelection.main.empty
    )
      return tr;
    const caret = tr.newSelection.main.head;
    const gap = structuralBlanks(tr.state).find((item) => item.from < caret && caret < item.to);
    if (gap === undefined) return tr;
    const backwards = tr.startState.selection.main.head > caret;
    return [tr, { selection: { anchor: backwards ? gap.from : gap.to }, sequential: true }];
  }),
  Prec.high(
    keymap.of([
      { key: "Backspace", run: (view) => removeSeparator(view, true) },
      { key: "Delete", run: (view) => removeSeparator(view, false) },
    ]),
  ),
  EditorView.baseTheme({
    ".cm-structural-gap": { height: "0.4em", minHeight: "4px", pointerEvents: "none" },
  }),
];
