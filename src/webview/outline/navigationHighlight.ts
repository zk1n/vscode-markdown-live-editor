import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

export const setOutlineNavigationHighlight = StateEffect.define<number | null>();

export const outlineNavigationHighlightState = StateField.define<DecorationSet>({
  create: (): DecorationSet => Decoration.none,
  update: (decorations, transaction): DecorationSet => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setOutlineNavigationHighlight)) {
        continue;
      }
      if (effect.value === null) {
        next = Decoration.none;
        continue;
      }
      const line = transaction.state.doc.lineAt(effect.value);
      next = Decoration.set([
        Decoration.line({ class: "cm-outline-navigation-highlight" }).range(line.from),
      ]);
    }
    return next;
  },
  provide: (field): Extension => EditorView.decorations.from(field),
});

export const outlineNavigationHighlightTheme = EditorView.baseTheme({
  ".cm-outline-navigation-highlight": {
    backgroundColor:
      "var(--vscode-editor-findMatchHighlightBackground, var(--vscode-editor-selectionHighlightBackground))",
  },
});
