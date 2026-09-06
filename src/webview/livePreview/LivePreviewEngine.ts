import { deleteCharBackward, deleteCharForward } from "@codemirror/commands";
import { EditorState, type Extension, type Range, StateField } from "@codemirror/state";
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
  ".cm-editor": {
    backgroundColor: "var(--vscode-editor-background, transparent)",
    color: "var(--vscode-editor-foreground, var(--vscode-foreground, inherit))",
    fontFamily: "var(--vscode-editor-font-family, var(--vscode-font-family, sans-serif))",
    fontSize: "var(--vscode-editor-font-size, 14px)",
  },
  ".cm-scroller": {
    lineHeight: "1.6",
    overflow: "auto",
    padding: "1rem 1.5rem",
  },
  ".cm-content": {
    boxSizing: "border-box",
    minHeight: "100%",
    padding: "0.25rem 0 2rem",
  },
  ".cm-line": {
    lineHeight: "1.6",
    minHeight: "1.6em",
  },
  ".cm-line.cm-live-preview-heading-line": {
    lineHeight: "1.25",
    paddingBottom: "0.25em",
    paddingTop: "0.6em",
  },
  ".cm-line.cm-live-preview-heading-line-1, .cm-line.cm-live-preview-heading-line-2": {
    borderBottom:
      "1px solid var(--vscode-textSeparator-foreground, var(--vscode-editorWidget-border, transparent))",
  },
  ".cm-live-preview-heading": {
    fontWeight: "600",
    lineHeight: "1.25",
  },
  ".cm-live-preview-heading-1": {
    fontSize: "2em",
  },
  ".cm-live-preview-heading-2": {
    fontSize: "1.5em",
  },
  ".cm-live-preview-heading-3": {
    fontSize: "1.25em",
  },
  ".cm-live-preview-heading-4": {
    fontSize: "1.1em",
  },
  ".cm-live-preview-heading-5": {
    fontSize: "1em",
  },
  ".cm-live-preview-heading-6": {
    fontSize: "0.9em",
  },
  ".cm-live-preview-strong": {
    fontWeight: "600",
  },
  ".cm-live-preview-emphasis": {
    fontStyle: "italic",
  },
  ".cm-live-preview-strikethrough": {
    textDecoration: "line-through",
  },
  ".cm-live-preview-inline-code": {
    backgroundColor:
      "var(--vscode-textCodeBlock-background, var(--vscode-textPreformat-background, transparent))",
    color: "var(--vscode-textPreformat-foreground, var(--vscode-editor-foreground, inherit))",
    borderRadius: "3px",
    fontFamily: "var(--vscode-editor-font-family, var(--vscode-font-family, monospace))",
    padding: "0 0.2em",
  },
  ".cm-live-preview-blockquote": {
    borderLeft:
      "2px solid var(--vscode-textBlockQuote-border, var(--vscode-textSeparator-foreground, var(--vscode-editorWidget-border, currentColor)))",
    color: "var(--vscode-textBlockQuote-foreground, var(--vscode-editor-foreground, inherit))",
    paddingLeft: "1em",
  },
  ".cm-line.cm-live-preview-blockquote-line": {
    backgroundColor: "var(--vscode-textBlockQuote-background, transparent)",
  },
  ".cm-live-preview-link": {
    color: "var(--vscode-textLink-foreground, var(--vscode-editor-foreground, inherit))",
    textDecoration: "underline",
  },
  ".cm-live-preview-link:hover": {
    color:
      "var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground, var(--vscode-editor-foreground, inherit)))",
  },
  ".cm-live-preview-list-marker": {
    color: "var(--vscode-descriptionForeground, var(--vscode-editor-foreground))",
    fontWeight: "500",
  },
  ".cm-live-preview-list-ordered-marker": {
    minWidth: "1em",
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
  ".cm-line.cm-live-preview-fenced-code-line": {
    backgroundColor:
      "var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background, transparent))",
    fontFamily: "var(--vscode-editor-font-family, var(--vscode-font-family, monospace))",
    whiteSpace: "pre-wrap",
  },
  ".cm-line.cm-live-preview-fenced-code-start": {
    borderTopLeftRadius: "3px",
    borderTopRightRadius: "3px",
    paddingTop: "0.35em",
  },
  ".cm-line.cm-live-preview-fenced-code-end": {
    borderBottomLeftRadius: "3px",
    borderBottomRightRadius: "3px",
    paddingBottom: "0.35em",
  },
  ".cm-line.cm-live-preview-horizontal-rule": {
    borderTop:
      "1px solid var(--vscode-textSeparator-foreground, var(--vscode-editorWidget-border, currentColor))",
    color: "var(--vscode-descriptionForeground, var(--vscode-editor-foreground, inherit))",
    marginTop: "0.8em",
    paddingTop: "0.8em",
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
  const decorations = buildStructuralLineDecorations(state);

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
    const lineClass = syntaxLineClass(syntax.kind, syntax.headingLevel);
    if (lineClass !== undefined) {
      decorations.push(
        Decoration.line({ class: lineClass }).range(state.doc.lineAt(syntax.from).from),
      );
    }
    decorations.push(
      Decoration.mark({ class: className }).range(syntax.contentFrom, syntax.contentTo),
    );
  }

  return Decoration.set(decorations, true);
}

function buildStructuralLineDecorations(state: EditorState): Range<Decoration>[] {
  const decorations: Range<Decoration>[] = [];
  let fence: { readonly character: "`" | "~"; readonly length: number } | undefined;

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1];
      const character = marker[0];
      if (character !== "`" && character !== "~") {
        continue;
      }
      if (fence === undefined) {
        fence = { character, length: marker.length };
        decorations.push(
          Decoration.line({
            class: "cm-live-preview-fenced-code-line cm-live-preview-fenced-code-start",
          }).range(line.from),
        );
      } else if (fence.character === character && marker.length >= fence.length) {
        decorations.push(
          Decoration.line({
            class: "cm-live-preview-fenced-code-line cm-live-preview-fenced-code-end",
          }).range(line.from),
        );
        fence = undefined;
      } else {
        decorations.push(
          Decoration.line({ class: "cm-live-preview-fenced-code-line" }).range(line.from),
        );
      }
      continue;
    }

    if (fence !== undefined) {
      decorations.push(
        Decoration.line({ class: "cm-live-preview-fenced-code-line" }).range(line.from),
      );
    } else if (isHorizontalRule(line.text)) {
      decorations.push(
        Decoration.line({ class: "cm-live-preview-horizontal-rule" }).range(line.from),
      );
    }
  }

  return decorations;
}

function syntaxLineClass(kind: string, headingLevel: number | undefined): string | undefined {
  switch (kind) {
    case "heading":
      return `cm-live-preview-heading-line cm-live-preview-heading-line-${String(headingLevel ?? 1)}`;
    case "list":
      return "cm-live-preview-list-line";
    case "task":
      return "cm-live-preview-list-line cm-live-preview-task-line";
    case "blockquote":
      return "cm-live-preview-blockquote-line";
    default:
      return undefined;
  }
}

function isHorizontalRule(line: string): boolean {
  return /^(?: {0,3})(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);
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
