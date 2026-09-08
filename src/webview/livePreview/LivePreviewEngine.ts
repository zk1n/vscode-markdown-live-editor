import { deleteCharBackward, deleteCharForward } from "@codemirror/commands";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

import {
  findFencedCodeBlockLines,
  findIndentedCodeBlockLines,
  findPresentationSyntax,
  isSyntaxActive,
} from "./markdownPresentation.js";

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
  "&": {
    backgroundColor: "var(--vscode-editor-background, transparent)",
    color: "var(--vscode-editor-foreground, var(--vscode-foreground, inherit))",
    fontFamily:
      'var(--markdown-font-family, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif)',
    fontSize: "var(--markdown-font-size, 14px)",
    fontWeight: "normal",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "var(--markdown-line-height, 22px)",
    overflow: "auto",
  },
  ".cm-content": {
    boxSizing: "border-box",
    minHeight: "100%",
    // VS Code 1.136.1 markdown.css uses a 26px reading gutter and 1em top
    // inset. Keeping the inset on CodeMirror's measured content preserves its
    // documentTop/coordinate model.
    padding: "1em 26px 2rem",
  },
  ".cm-line": {
    lineHeight: "var(--markdown-line-height, 22px)",
    minHeight: "1em",
    paddingLeft: "0",
    paddingRight: "0",
  },
  ".cm-line.cm-live-preview-heading-line": {
    lineHeight: "1.25",
  },
  ".cm-line.cm-live-preview-heading-line-1, .cm-line.cm-live-preview-heading-line-2": {
    borderBottom:
      "1px solid var(--vscode-textSeparator-foreground, var(--vscode-editorWidget-border, transparent))",
    paddingBottom: "0.3em",
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
    fontSize: "1em",
  },
  ".cm-live-preview-heading-5": {
    fontSize: "0.875em",
  },
  ".cm-live-preview-heading-6": {
    fontSize: "0.85em",
  },
  ".cm-live-preview-strong": {
    fontWeight: "bold",
  },
  ".cm-live-preview-emphasis": {
    fontStyle: "italic",
  },
  ".cm-live-preview-strikethrough": {
    textDecoration: "line-through",
  },
  ".cm-live-preview-inline-code": {
    backgroundColor:
      "var(--md-inline-code-background, color-mix(in srgb, var(--vscode-textPreformat-background, #818b981f) 60%, transparent))",
    borderRadius: "4px",
    color: "var(--vscode-textPreformat-foreground, inherit)",
    fontFamily:
      'var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace)',
    fontSize: "1em",
    fontWeight: "normal",
    lineHeight: "1.357em",
    margin: "0",
    padding: "1px 3px",
    whiteSpace: "break-spaces",
  },
  ".cm-live-preview-blockquote": {
    color: "var(--vscode-textBlockQuote-foreground, var(--vscode-editor-foreground, inherit))",
  },
  ".cm-line.cm-live-preview-blockquote-line": {
    backgroundColor:
      "var(--vscode-textBlockQuote-background, var(--vscode-editorWidget-background, transparent))",
    borderLeft:
      "5px solid var(--vscode-textBlockQuote-border, var(--vscode-textSeparator-foreground, var(--vscode-editorWidget-border, currentColor)))",
    borderRadius: "2px",
    boxSizing: "border-box",
    padding: "0 16px 0 12px",
  },
  ".cm-live-preview-link": {
    color: "var(--vscode-textLink-foreground, var(--vscode-editor-foreground, inherit))",
    textDecoration: "none",
  },
  ".cm-live-preview-link:hover": {
    color:
      "var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground, var(--vscode-editor-foreground, inherit)))",
    textDecoration: "underline",
  },
  ".cm-live-preview-list-marker": {
    color: "var(--vscode-descriptionForeground, var(--vscode-editor-foreground))",
  },
  ".cm-live-preview-list-ordered-marker": {
    boxSizing: "border-box",
    display: "inline-block",
    paddingRight: "0.5em",
    textAlign: "right",
    width: "2.85em",
  },
  ".cm-live-preview-native-unordered-marker": {
    color: "inherit",
    display: "inline flow-root list-item",
    font: "inherit",
    lineHeight: "inherit",
    listStylePosition: "outside",
    verticalAlign: "baseline",
    width: "0",
  },
  ".cm-live-preview-native-unordered-marker::marker": {
    color: "inherit",
    font: "inherit",
    lineHeight: "inherit",
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
  ".cm-line.cm-live-preview-fenced-code-line, .cm-line.cm-live-preview-indented-code-line": {
    backgroundColor:
      "var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background, transparent))",
    borderLeft:
      "1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, transparent))",
    borderRight:
      "1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, transparent))",
    boxSizing: "border-box",
    fontFamily:
      'var(--vscode-editor-font-family, "SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace)',
    lineHeight: "1.357em",
    paddingLeft: "16px",
    paddingRight: "16px",
    whiteSpace: "pre-wrap",
  },
  ".cm-line.cm-live-preview-fenced-code-start": {
    borderTop:
      "1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, transparent))",
    borderTopLeftRadius: "3px",
    borderTopRightRadius: "3px",
    paddingTop: "16px",
  },
  ".cm-line.cm-live-preview-fenced-code-end": {
    borderBottom:
      "1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, transparent))",
    borderBottomLeftRadius: "3px",
    borderBottomRightRadius: "3px",
    paddingBottom: "16px",
  },
  ".cm-line.cm-live-preview-indented-code-start": {
    borderTop:
      "1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, transparent))",
    borderTopLeftRadius: "3px",
    borderTopRightRadius: "3px",
    paddingTop: "16px",
  },
  ".cm-line.cm-live-preview-indented-code-end": {
    borderBottom:
      "1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, transparent))",
    borderBottomLeftRadius: "3px",
    borderBottomRightRadius: "3px",
    paddingBottom: "16px",
  },
  ".cm-line.cm-live-preview-horizontal-rule": {
    color: "transparent",
    position: "relative",
  },
  ".cm-line.cm-live-preview-horizontal-rule::after": {
    borderBottom:
      "1px solid var(--vscode-textSeparator-foreground, var(--vscode-editorWidget-border, currentColor))",
    content: '""',
    left: "0",
    pointerEvents: "none",
    position: "absolute",
    right: "0",
    top: "50%",
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
  const unorderedMarkerDepths = findUnorderedMarkerDepths(documentText);
  const decorations = buildStructuralLineDecorations(state, selections);

  for (const syntax of findPresentationSyntax(documentText)) {
    if (!isSyntaxActive(syntax, selections)) {
      for (const marker of syntax.markers) {
        if (marker.presentation === "list-unordered") {
          const depth =
            unorderedMarkerDepths.get(
              unorderedMarkerPosition(documentText, marker.from, marker.to),
            ) ?? 1;
          decorations.push(
            Decoration.replace({
              inclusive: false,
              markerPresentation: "list-unordered",
              widget: new UnorderedListMarkerWidget(depth),
            }).range(marker.from, marker.to),
          );
        } else if (marker.presentation === undefined || marker.presentation === "hidden") {
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
            Decoration.mark({
              class: markerClass(marker.presentation),
            }).range(marker.from, marker.to),
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

class UnorderedListMarkerWidget extends WidgetType {
  public constructor(private readonly depth: number) {
    super();
  }

  public override eq(other: UnorderedListMarkerWidget): boolean {
    return this.depth === other.depth;
  }

  public override toDOM(): HTMLElement {
    const marker = document.createElement("span");
    const shape = unorderedMarkerShape(this.depth);
    marker.className = [
      "cm-live-preview-native-unordered-marker",
      `cm-live-preview-native-unordered-marker-depth-${String(this.depth)}`,
      `cm-live-preview-native-unordered-marker-${shape}`,
    ].join(" ");
    marker.style.listStyleType = shape;
    marker.style.marginLeft = `${String(this.depth * 40)}px`;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }

  public override ignoreEvent(): boolean {
    return false;
  }
}

function unorderedMarkerPosition(documentText: string, from: number, to: number): number {
  for (let position = to - 1; position >= from; position -= 1) {
    if (/^[+*-]$/.test(documentText[position] ?? "")) {
      return position;
    }
  }
  return from;
}

/**
 * Markdown's parse tree, rather than source indentation, determines the
 * presentation depth. That keeps tab-expanded and space-indented nested lists
 * visually equivalent without changing their document or editing semantics.
 */
function findUnorderedMarkerDepths(documentText: string): ReadonlyMap<number, number> {
  const depths = new Map<number, number>();
  const tree = markdownLanguage.parser.parse(documentText);

  tree.iterate({
    enter: ({ from, name, to }): void => {
      if (name !== "ListMark" || !/^[+*-]$/.test(documentText.slice(from, to))) {
        return;
      }

      let depth = 0;
      let node: ReturnType<typeof tree.resolve> | null = tree.resolve(from, 1);
      while (node !== null) {
        if (node.name === "ListItem") {
          depth += 1;
        }
        node = node.parent;
      }
      depths.set(from, Math.max(depth, 1));
    },
  });

  return depths;
}

function unorderedMarkerShape(depth: number): "disc" | "circle" | "square" {
  if (depth === 1) {
    return "disc";
  }
  if (depth === 2) {
    return "circle";
  }
  return "square";
}

function buildStructuralLineDecorations(
  state: EditorState,
  selections: readonly { readonly from: number; readonly to: number }[],
): Range<Decoration>[] {
  const decorations: Range<Decoration>[] = [];
  const fencedCodeLines = new Map(
    findFencedCodeBlockLines(state.doc.toString()).map((line) => [line.from, line]),
  );
  const indentedCodeLines = new Map(
    findIndentedCodeBlockLines(state.doc.toString()).map((line) => [line.from, line]),
  );

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const fencedCode = fencedCodeLines.get(line.from);
    if (fencedCode !== undefined) {
      const lineClasses = ["cm-live-preview-fenced-code-line"];
      if (fencedCode.isFirst) {
        lineClasses.push("cm-live-preview-fenced-code-start");
      }
      if (fencedCode.isLast) {
        lineClasses.push("cm-live-preview-fenced-code-end");
      }
      decorations.push(Decoration.line({ class: lineClasses.join(" ") }).range(line.from));
      if (
        fencedCode.markerFrom !== undefined &&
        fencedCode.markerFrom < line.to &&
        !isLineSelectionActive(line.from, line.to, selections)
      ) {
        decorations.push(
          Decoration.replace({
            inclusive: false,
            markerPresentation: "fenced-code-marker",
          }).range(fencedCode.markerFrom, line.to),
        );
      }
    } else {
      const indentedCode = indentedCodeLines.get(line.from);
      if (indentedCode !== undefined) {
        const lineClasses = ["cm-live-preview-indented-code-line"];
        if (indentedCode.isFirst) {
          lineClasses.push("cm-live-preview-indented-code-start");
        }
        if (indentedCode.isLast) {
          lineClasses.push("cm-live-preview-indented-code-end");
        }
        decorations.push(Decoration.line({ class: lineClasses.join(" ") }).range(line.from));
        if (
          indentedCode.indentationTo > line.from &&
          !isLineSelectionActive(line.from, line.to, selections)
        ) {
          decorations.push(
            Decoration.replace({
              inclusive: false,
              markerPresentation: "indented-code-indent",
            }).range(line.from, indentedCode.indentationTo),
          );
        }
      } else if (
        isHorizontalRule(line.text) &&
        !isLineSelectionActive(line.from, line.to, selections)
      ) {
        decorations.push(
          Decoration.line({ class: "cm-live-preview-horizontal-rule" }).range(line.from),
        );
      }
    }
  }

  return decorations;
}

function isLineSelectionActive(
  lineFrom: number,
  lineTo: number,
  selections: readonly { readonly from: number; readonly to: number }[],
): boolean {
  return selections.some(({ from, to }) => from <= lineTo && to >= lineFrom);
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
