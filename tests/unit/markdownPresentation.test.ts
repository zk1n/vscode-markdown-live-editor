import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  createLivePreviewEngine,
  livePreviewComposition,
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
  it("changes decorations for selection presentation without mutating the CodeMirror document", () => {
    const engine = createLivePreviewEngine();
    const state = EditorState.create({ doc: "x **hello**", extensions: [engine.extension] });
    const initialDecorations = decorationCount(state);

    const selectionTransaction = state.update({ selection: { anchor: 5 } });
    expect(selectionTransaction.docChanged).toBe(false);
    expect(selectionTransaction.state.doc.toString()).toBe("x **hello**");
    expect(decorationCount(selectionTransaction.state)).toBeLessThan(initialDecorations);

    const compositionStart = selectionTransaction.state.update({
      effects: livePreviewComposition.of(true),
    });
    expect(compositionStart.docChanged).toBe(false);
    expect(compositionStart.state.doc.toString()).toBe("x **hello**");
    expect(decorationCount(compositionStart.state)).toBe(0);

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
