import { EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  createLivePreviewEngine,
  livePreviewState,
} from "../../src/webview/livePreview/LivePreviewEngine.js";
import {
  findPresentationSyntax,
  isSyntaxActive,
} from "../../src/webview/livePreview/markdownPresentation.js";

describe("Markdown presentation syntax", () => {
  it("recognizes the minimal heading, strong, and emphasis subset without parsing fenced code", () => {
    const syntax = findPresentationSyntax(
      "## Heading\n**bold** and _italic_\n```md\n# source\n```",
    );

    expect(syntax.map(({ kind }) => kind)).toEqual(["heading", "strong", "emphasis"]);
    expect(syntax[0]).toMatchObject({
      kind: "heading",
      headingLevel: 2,
      markers: [{ from: 0, to: 3 }],
    });
    expect(syntax[1]).toMatchObject({
      kind: "strong",
      markers: [
        { from: 11, to: 13 },
        { from: 17, to: 19 },
      ],
    });
  });

  it("reveals an enclosing syntax range for a caret or a boundary-crossing selection", () => {
    const [strong] = findPresentationSyntax("**日本語**");
    expect(strong).toBeDefined();
    if (strong === undefined) {
      throw new Error("Expected strong Markdown syntax.");
    }

    expect(isSyntaxActive(strong, [{ from: 3, to: 3 }])).toBe(true);
    expect(isSyntaxActive(strong, [{ from: 0, to: 3 }])).toBe(true);
    expect(isSyntaxActive(strong, [{ from: 20, to: 20 }])).toBe(false);
  });
});

describe("LivePreviewEngine", () => {
  it("reveals source markers without removing semantic presentation or mutating the document", () => {
    const engine = createLivePreviewEngine();
    const state = EditorState.create({
      doc: "## heading\nplain",
      selection: { anchor: 11 },
      extensions: [engine.extension],
    });
    const initialDecorations = decorationCount(state);

    const selectionTransaction = state.update({ selection: { anchor: 4 } });
    expect(selectionTransaction.docChanged).toBe(false);
    expect(selectionTransaction.state.doc.toString()).toBe("## heading\nplain");
    // The heading marker is revealed, while its semantic heading mark remains.
    expect(decorationCount(selectionTransaction.state)).toBe(initialDecorations - 1);

    const compositionUpdate = selectionTransaction.state.update({
      changes: { from: 4, insert: "日本" },
      annotations: Transaction.userEvent.of("input.type.compose"),
    });
    expect(compositionUpdate.docChanged).toBe(true);
    expect(compositionUpdate.state.doc.toString()).toBe("## h日本eading\nplain");
    expect(decorationCount(compositionUpdate.state)).toBe(
      decorationCount(selectionTransaction.state),
    );

    engine.dispose();
  });
});

function decorationCount(state: EditorState): number {
  let count = 0;
  state.field(livePreviewState).decorations.between(0, state.doc.length, (): void => {
    count += 1;
  });
  return count;
}
