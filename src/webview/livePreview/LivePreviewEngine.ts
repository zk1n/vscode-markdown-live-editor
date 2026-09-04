import { deleteCharBackward, deleteCharForward } from "@codemirror/commands";
import { EditorState, type Extension, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

import { findPresentationSyntax, isSyntaxActive } from "./markdownPresentation.js";

export interface LivePreviewEngine {
  readonly extension: Extension;
  dispose(): void;
}

/**
 * The v0.1 renderer owns CodeMirror presentation state and a source-aware
 * line-join guard. It contains no history or host integration.
 */
export function createLivePreviewEngine(): LivePreviewEngine {
  return new CodeMirrorDecorationLivePreviewEngine();
}

interface LivePreviewState {
  readonly decorations: DecorationSet;
}

export const livePreviewState = StateField.define<LivePreviewState>({
  create: (state): LivePreviewState => ({ decorations: buildDecorations(state) }),
  update: (value, transaction): LivePreviewState => {
    if (transaction.docChanged && transaction.isUserEvent("input.type.compose")) {
      // Preserve the existing decoration topology while CodeMirror applies an
      // IME preedit. Mapping follows the text change without a project DOM
      // event handler dispatching another transaction into the composition.
      return { decorations: value.decorations.map(transaction.changes) };
    }
    return {
      decorations: buildDecorations(transaction.state),
    };
  },
  provide: (field): Extension =>
    EditorView.decorations.from(field, (value): DecorationSet => value.decorations),
});

const livePreviewTheme = EditorView.baseTheme({
  ".cm-live-preview-heading": {
    fontWeight: "700",
  },
  ".cm-live-preview-heading-1": {
    fontSize: "1.6em",
  },
  ".cm-live-preview-heading-2": {
    fontSize: "1.4em",
  },
  ".cm-live-preview-heading-3": {
    fontSize: "1.2em",
  },
  ".cm-live-preview-strong": {
    fontWeight: "700",
  },
  ".cm-live-preview-emphasis": {
    fontStyle: "italic",
  },
  ".cm-live-preview-strikethrough": {
    textDecoration: "line-through",
  },
  ".cm-live-preview-inline-code": {
    backgroundColor: "var(--vscode-textCodeBlock-background)",
    borderRadius: "3px",
    fontFamily: "var(--vscode-editor-font-family)",
    padding: "0 0.2em",
  },
  ".cm-live-preview-blockquote": {
    borderLeft: "2px solid var(--vscode-textBlockQuote-border)",
    color: "var(--vscode-textBlockQuote-foreground)",
    paddingLeft: "0.5em",
  },
  ".cm-live-preview-link": {
    color: "var(--vscode-textLink-foreground)",
    textDecoration: "underline",
  },
  ".cm-live-preview-list-marker": {
    color: "var(--vscode-descriptionForeground, var(--vscode-editor-foreground))",
    fontWeight: "600",
  },
  ".cm-live-preview-list-unordered-marker": {
    color: "transparent",
    display: "inline-block",
    position: "relative",
    width: "1em",
    verticalAlign: "baseline",
    whiteSpace: "nowrap",
  },
  ".cm-live-preview-list-unordered-marker::before": {
    color: "var(--vscode-descriptionForeground, var(--vscode-editor-foreground))",
    content: '"•"',
    fontSize: "inherit",
    left: "0",
    lineHeight: "inherit",
    position: "absolute",
    top: "0",
  },
  ".cm-live-preview-task-marker": {
    color: "transparent",
    display: "inline-block",
    position: "relative",
    width: "1em",
    // Keep the source span in the same font metrics as its surrounding line.
    // Its text is transparent, but its normal line box gives the overlaid
    // pseudo marker a stable baseline and inline width.
    verticalAlign: "baseline",
    whiteSpace: "nowrap",
  },
  ".cm-live-preview-task-marker::before": {
    color: "var(--vscode-checkbox-foreground, var(--vscode-editor-foreground))",
    fontSize: "inherit",
    left: "0",
    lineHeight: "inherit",
    position: "absolute",
    top: "0",
  },
  ".cm-live-preview-task-unchecked::before": {
    content: '"☐"',
  },
  ".cm-live-preview-task-checked::before": {
    content: '"☑"',
  },
});

const sourceAwareLineBoundaryJoin = EditorView.domEventHandlers({
  beforeinput: (event, view): boolean => {
    if (
      event.isComposing ||
      view.composing ||
      !view.state.facet(EditorView.editable) ||
      view.state.facet(EditorState.readOnly) ||
      view.state.selection.ranges.length !== 1 ||
      !view.state.selection.main.empty
    ) {
      return false;
    }

    const caret = view.state.selection.main.head;
    const line = view.state.doc.lineAt(caret);
    if (
      event.inputType === "deleteContentForward" &&
      caret === line.to &&
      line.number < view.state.doc.lines
    ) {
      return deleteCharForward(view);
    }
    if (event.inputType === "deleteContentBackward" && caret === line.from && line.number > 1) {
      return deleteCharBackward(view);
    }
    return false;
  },
});

class CodeMirrorDecorationLivePreviewEngine implements LivePreviewEngine {
  public readonly extension: Extension = [
    livePreviewState,
    livePreviewTheme,
    sourceAwareLineBoundaryJoin,
  ];

  public dispose(): void {
    // CodeMirror owns the field and theme lifetime through EditorView.destroy().
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const documentText = state.doc.toString();
  const selections = state.selection.ranges.map(({ from, to }) => ({ from, to }));
  const decorations = [];

  for (const syntax of findPresentationSyntax(documentText)) {
    if (!isSyntaxActive(syntax, selections)) {
      for (const marker of syntax.markers) {
        if (marker.presentation === undefined || marker.presentation === "hidden") {
          // A replacement removes the marker from the editable DOM rather than
          // merely hiding its text. This keeps adjacent lines in preview while
          // leaving the CodeMirror document untouched.
          decorations.push(
            Decoration.replace({
              inclusive: false,
              markerPresentation: "hidden",
            }).range(marker.from, marker.to),
          );
        } else {
          decorations.push(
            Decoration.mark({ class: markerClass(marker.presentation) }).range(
              marker.from,
              marker.to,
            ),
          );
        }
      }
    }
    const className =
      syntax.kind === "heading"
        ? `cm-live-preview-heading cm-live-preview-heading-${String(syntax.headingLevel)}`
        : `cm-live-preview-${syntax.kind}`;
    decorations.push(
      Decoration.mark({ class: className }).range(syntax.contentFrom, syntax.contentTo),
    );
  }

  return Decoration.set(decorations, true);
}

function markerClass(
  presentation: "list-ordered" | "list-unordered" | "task-checked" | "task-unchecked",
): string {
  switch (presentation) {
    case "list-ordered":
      return "cm-live-preview-list-marker cm-live-preview-list-ordered-marker";
    case "list-unordered":
      return "cm-live-preview-list-marker cm-live-preview-list-unordered-marker";
    case "task-checked":
      return "cm-live-preview-task-marker cm-live-preview-task-checked";
    case "task-unchecked":
      return "cm-live-preview-task-marker cm-live-preview-task-unchecked";
  }
}
