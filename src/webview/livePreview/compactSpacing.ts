import { EditorState, Facet, Prec, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { structuralBlanks } from "../structuralSpacing.js";
import { searchReveal } from "./searchReveal.js";

export const compactSpacingEnabled = Facet.define<boolean, boolean>({
  combine: (values) => !values.includes(false),
});
const compactLines = StateField.define<DecorationSet>({
  create: build,
  update(value, transaction) {
    if (transaction.isUserEvent("input.type.compose")) return value.map(transaction.changes);
    return build(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});
function build(state: EditorState): DecorationSet {
  if (!state.facet(compactSpacingEnabled)) return Decoration.none;
  const match = state.field(searchReveal, false);
  return Decoration.set(
    structuralBlanks(state)
      .filter(({ from, to }) => !match || match.to <= from || match.from >= to)
      .map(({ from }) =>
        // Preserve real line boundaries in CM's height/coordinate map. Only the blank
        // line is compressed; the preceding heading's end remains a visible caret.
        Decoration.line({ class: "cm-structural-gap" }).range(from + 1),
      ),
  );
}
function crossSeparator(view: EditorView, backwards: boolean): boolean {
  if (
    !view.state.facet(compactSpacingEnabled) ||
    view.state.field(searchReveal, false) !== undefined ||
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
  // A single-caret delete crosses presentation structure without deleting source.
  // Explicit range deletion, source mode and search replacement remain literal.
  view.dispatch({
    selection: { anchor: backwards ? gap.from : gap.to },
    userEvent: "select.structural",
  });
  return true;
}
export function createCompactSpacing(isComposing: () => boolean = () => false): Extension {
  return [
    compactLines,
    EditorState.transactionFilter.of((tr) => {
      if (
        tr.docChanged &&
        tr.startState.facet(compactSpacingEnabled) &&
        tr.startState.selection.ranges.length === 1 &&
        tr.startState.selection.main.empty &&
        tr.isUserEvent("delete") &&
        !isComposing() &&
        tr.startState.field(searchReveal, false) === undefined
      ) {
        const protectedRanges = structuralBlanks(tr.startState);
        const touched: boolean[] = [];
        tr.changes.iterChangedRanges((from, to) => {
          touched.push(protectedRanges.some((gap) => from < gap.to && to > gap.from));
        });
        if (touched.some(Boolean)) return [];
      }
      if (
        !tr.state.facet(compactSpacingEnabled) ||
        tr.state.field(searchReveal, false) !== undefined ||
        isComposing() ||
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
        { key: "Backspace", run: (view) => crossSeparator(view, true) },
        { key: "Delete", run: (view) => crossSeparator(view, false) },
      ]),
    ),
    EditorView.baseTheme({
      ".cm-line.cm-structural-gap": {
        height: "var(--cm-structural-gap, 6px)",
        minHeight: "2px",
        lineHeight: "var(--cm-structural-gap, 6px)",
        padding: "0",
      },
    }),
  ];
}
export const compactSpacing: Extension = createCompactSpacing();
