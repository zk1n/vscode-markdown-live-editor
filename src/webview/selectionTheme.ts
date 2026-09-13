import { EditorView } from "@codemirror/view";

/** CM draws table selection/carets; its native-selection suppression must remain intact. */
export const selectionTheme = EditorView.theme({
  ".cm-content": { caretColor: "var(--vscode-editorCursor-foreground, currentColor)" },
  "&.cm-focused .cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--vscode-editorCursor-foreground, currentColor)",
  },
  "& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--vscode-editor-inactiveSelectionBackground, #80808055)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--vscode-editor-selectionBackground, #2677b877)",
  },
});
