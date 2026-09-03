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
  it("recognizes heading, strong, and emphasis without parsing fenced code", () => {
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

  it("recognizes the remaining Slice 2 presentation syntax while preserving code as source", () => {
    const source =
      "~~removed~~ and `*literal*`\n- item\n1. ordered\n- [ ] open\n- [X] done\n> quote\n[site](docs/readme.md)\n```md\n~~source~~\n```";
    const syntax = findPresentationSyntax(source);

    expect(syntax.map(({ kind }) => kind)).toEqual([
      "inline-code",
      "strikethrough",
      "list",
      "list",
      "task",
      "task",
      "blockquote",
      "link",
    ]);
    expect(syntax).not.toContainEqual(expect.objectContaining({ kind: "emphasis" }));

    const tasks = syntax.filter(({ kind }) => kind === "task");
    expect(tasks[0]?.markers[1]).toMatchObject({ presentation: "task-unchecked" });
    expect(tasks[1]?.markers[1]).toMatchObject({ presentation: "task-checked" });

    const lists = syntax.filter(({ kind }) => kind === "list");
    expect(lists[0]?.markers[0]).toMatchObject({ presentation: "list" });

    const link = syntax.find(({ kind }) => kind === "link");
    const linkStart = source.indexOf("[site]");
    expect(link).toMatchObject({
      markers: [
        { from: linkStart, to: linkStart + 1 },
        { from: linkStart + 5, to: linkStart + "[site](docs/readme.md)".length },
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

  it("uses presentation-only task markers and reveals their source at the active caret", () => {
    const engine = createLivePreviewEngine();
    const state = EditorState.create({
      doc: "- [ ] task\nplain",
      selection: { anchor: 15 },
      extensions: [engine.extension],
    });
    const inactiveDecorations = decorationCount(state);

    const selectionTransaction = state.update({ selection: { anchor: 3 } });
    expect(selectionTransaction.docChanged).toBe(false);
    expect(selectionTransaction.state.doc.toString()).toBe("- [ ] task\nplain");
    expect(decorationCount(selectionTransaction.state)).toBe(inactiveDecorations - 2);

    engine.dispose();
  });

  it("reveals a hidden closing marker before a next-line Backspace and preserves source", () => {
    const cases = [
      ["link", "[label](target.md)"],
      ["strong", "**bold**"],
      ["emphasis", "_italic_"],
      ["strikethrough", "~~strike~~"],
      ["inline code", "`code`"],
    ] as const;

    for (const [name, source] of cases) {
      const engine = createLivePreviewEngine();
      const state = EditorState.create({
        doc: `${source}\n`,
        selection: { anchor: source.length + 1 },
        extensions: [engine.extension],
      });

      expect(decorationCount(state), name).toBe(1);
      const newlineOnlyDeletion = state.update({
        changes: { from: source.length, to: source.length + 1 },
      });
      expect(newlineOnlyDeletion.state.doc.toString(), name).toBe(source);

      engine.dispose();
    }
  });

  it("reveals a hidden opening marker before a previous-line Delete and preserves source", () => {
    const engine = createLivePreviewEngine();
    const state = EditorState.create({
      doc: "plain\n[label](target.md)",
      selection: { anchor: 5 },
      extensions: [engine.extension],
    });

    expect(decorationCount(state)).toBe(1);
    const newlineOnlyDeletion = state.update({ changes: { from: 5, to: 6 } });
    expect(newlineOnlyDeletion.state.doc.toString()).toBe("plain[label](target.md)");

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
