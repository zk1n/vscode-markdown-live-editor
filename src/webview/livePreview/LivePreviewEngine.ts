import { type Extension, StateEffect, StateField, type EditorState } from "@codemirror/state";
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
  readonly composing: boolean;
}

export const livePreviewComposition = StateEffect.define<boolean>();

export const livePreviewState = StateField.define<LivePreviewState>({
  create: (state): LivePreviewState => ({ composing: false, decorations: buildDecorations(state) }),
  update: (value, transaction): LivePreviewState => {
    const compositionEffect = transaction.effects.find((effect) =>
      effect.is(livePreviewComposition),
    );
    const composing = compositionEffect?.value ?? value.composing;
    return {
      composing,
      decorations: composing ? Decoration.none : buildDecorations(transaction.state),
    };
  },
  provide: (field): Extension =>
    EditorView.decorations.from(field, (value): DecorationSet => value.decorations),
});

const compositionEvents = EditorView.domEventHandlers({
  compositionstart: (_event, view): boolean => {
    view.dispatch({ effects: livePreviewComposition.of(true) });
    return false;
  },
  compositionend: (_event, view): boolean => {
    view.dispatch({ effects: livePreviewComposition.of(false) });
    return false;
  },
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
  public readonly extension: Extension = [livePreviewState, compositionEvents, livePreviewTheme];

  public dispose(): void {
    // CodeMirror owns the field and theme lifetime through EditorView.destroy().
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const selections = state.selection.ranges.map(({ from, to }) => ({ from, to }));
  const decorations = [];

  for (const syntax of findPresentationSyntax(state.doc.toString())) {
    if (isSyntaxActive(syntax, selections)) {
      continue;
    }
    for (const marker of syntax.markers) {
      decorations.push(
        Decoration.mark({ class: "cm-live-preview-marker" }).range(marker.from, marker.to),
      );
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
