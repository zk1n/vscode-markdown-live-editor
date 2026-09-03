import { type Extension, StateField, type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

import { findPresentationSyntax, isSyntaxActive } from "./markdownPresentation.js";

export interface LivePreviewEngine {
  readonly extension: Extension;
  dispose(): void;
}

/**
 * The v0.1 renderer owns only CodeMirror presentation state. Its extension
 * contains no commands, history, document transactions, or host integration.
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
  ".cm-live-preview-marker": {
    display: "none",
  },
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
});

class CodeMirrorDecorationLivePreviewEngine implements LivePreviewEngine {
  public readonly extension: Extension = [livePreviewState, livePreviewTheme];

  public dispose(): void {
    // CodeMirror owns the field and theme lifetime through EditorView.destroy().
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const selections = state.selection.ranges.map(({ from, to }) => ({ from, to }));
  const decorations = [];

  for (const syntax of findPresentationSyntax(state.doc.toString())) {
    if (!isSyntaxActive(syntax, selections)) {
      for (const marker of syntax.markers) {
        decorations.push(
          Decoration.mark({ class: "cm-live-preview-marker" }).range(marker.from, marker.to),
        );
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
