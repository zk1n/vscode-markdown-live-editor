// @vitest-environment happy-dom

import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, type Decoration } from "@codemirror/view";
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
    expect(lists[0]?.markers[0]).toMatchObject({ presentation: "list-unordered" });
    expect(lists[1]?.markers[0]).toMatchObject({ presentation: "list-ordered" });

    const link = syntax.find(({ kind }) => kind === "link");
    const linkStart = source.indexOf("[site]");
    expect(link).toMatchObject({
      markers: [
        { from: linkStart, to: linkStart + 1 },
        { from: linkStart + 5, to: linkStart + "[site](docs/readme.md)".length },
      ],
    });
  });

  it("uses the Markdown tree for nested list and task indentation without presenting code", () => {
    const source = [
      "    - top-level code",
      "- parent",
      "  - two-space child",
      "    - four-space child",
      "\t- tab child",
      "",
      "    1. ordered child",
      "    - [ ] open task",
      "> - quoted parent",
      ">   - [X] quoted task",
      "```md",
      "    - [ ] fenced source",
      "```",
      "    - indented code",
    ].join("\n");
    const syntax = findPresentationSyntax(source);
    const presentedLines = syntax
      .filter(({ kind }) => kind === "list" || kind === "task")
      .map(({ from }) => {
        const lineFrom = source.lastIndexOf("\n", from - 1) + 1;
        const lineTo = source.indexOf("\n", from);
        return source.slice(lineFrom, lineTo === -1 ? source.length : lineTo);
      });

    expect(presentedLines).toEqual([
      "- parent",
      "  - two-space child",
      "    - four-space child",
      "\t- tab child",
      "    1. ordered child",
      "    - [ ] open task",
      "> - quoted parent",
      ">   - [X] quoted task",
    ]);
    expect(syntax.some(({ from }) => source.slice(from).startsWith("    - top-level code"))).toBe(
      false,
    );
    expect(
      syntax.some(({ from }) => source.slice(from).startsWith("    - [ ] fenced source")),
    ).toBe(false);
    expect(syntax.some(({ from }) => source.slice(from).startsWith("    - indented code"))).toBe(
      false,
    );

    const tasks = syntax.filter(({ kind }) => kind === "task");
    expect(tasks.map(({ markers }) => markers[1]?.presentation)).toEqual([
      "task-unchecked",
      "task-checked",
    ]);

    const indentedInline = findPresentationSyntax("    **indented code**");
    expect(indentedInline.some(({ kind }) => kind === "strong")).toBe(false);
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

  it("presents every unordered marker as a bullet while preserving ordered and task markers", () => {
    const source = "- item\n+ item\n* item\n1. ordered\n- [ ] open\nplain";
    const syntax = findPresentationSyntax(source);
    const lists = syntax.filter(({ kind }) => kind === "list");
    const tasks = syntax.filter(({ kind }) => kind === "task");

    expect(lists.map(({ markers }) => markers[0]?.presentation)).toEqual([
      "list-unordered",
      "list-unordered",
      "list-unordered",
      "list-ordered",
    ]);
    expect(tasks[0]?.markers[1]?.presentation).toBe("task-unchecked");

    const engine = createLivePreviewEngine();
    const state = EditorState.create({
      doc: source,
      selection: { anchor: source.length },
      extensions: [engine.extension],
    });
    expect(markClasses(state)).toContain(
      "cm-live-preview-list-marker cm-live-preview-list-unordered-marker",
    );
    expect(markClasses(state)).toContain(
      "cm-live-preview-list-marker cm-live-preview-list-ordered-marker",
    );
    expect(markClasses(state)).toContain(
      "cm-live-preview-task-marker cm-live-preview-task-unchecked",
    );

    const activeUnordered = state.update({ selection: { anchor: 0 } });
    expect(activeUnordered.docChanged).toBe(false);
    expect(activeUnordered.state.doc.toString()).toBe(source);
    expect(
      hasMarkerClassAt(
        activeUnordered.state,
        lists[0]?.markers[0]?.from ?? -1,
        lists[0]?.markers[0]?.to ?? -1,
      ),
    ).toBe(false);

    const composition = activeUnordered.state.update({
      changes: { from: 2, insert: "日" },
      annotations: Transaction.userEvent.of("input.type.compose"),
    });
    expect(composition.annotation(Transaction.userEvent)).toBe("input.type.compose");
    expect(composition.state.doc.toString()).toBe(
      "- 日item\n+ item\n* item\n1. ordered\n- [ ] open\nplain",
    );

    engine.dispose();
  });

  it("uses parser-derived unordered marker depth while leaving indentation and code raw", () => {
    const source = [
      "    - code",
      "- parent",
      "  - two-space child",
      "    - four-space child",
      "      - five-space child",
      "        - six-space child",
      "\t- tab child",
      "    - [ ] nested task",
    ].join("\n");
    const syntax = findPresentationSyntax(source);
    const nestedList = syntax.filter(({ kind }) => kind === "list");
    const nestedTask = syntax.find(({ kind }) => kind === "task");
    if (nestedList.length !== 6 || nestedTask === undefined) {
      throw new Error("Expected parser-recognized nested list and task.");
    }

    const engine = createLivePreviewEngine();
    const state = EditorState.create({
      doc: source,
      selection: { anchor: 0 },
      extensions: [engine.extension],
    });
    expect(nestedList.map(({ markers }) => markerClassAt(state, markers[0]?.from ?? -1))).toEqual([
      "cm-live-preview-list-marker cm-live-preview-list-unordered-marker",
      "cm-live-preview-list-marker cm-live-preview-list-unordered-marker cm-live-preview-list-unordered-marker-depth-2",
      "cm-live-preview-list-marker cm-live-preview-list-unordered-marker cm-live-preview-list-unordered-marker-depth-3",
      "cm-live-preview-list-marker cm-live-preview-list-unordered-marker cm-live-preview-list-unordered-marker-depth-3",
      "cm-live-preview-list-marker cm-live-preview-list-unordered-marker cm-live-preview-list-unordered-marker-depth-3",
      "cm-live-preview-list-marker cm-live-preview-list-unordered-marker cm-live-preview-list-unordered-marker-depth-3",
    ]);
    expect(
      hasDecorationClassAt(
        state,
        nestedTask.markers[1]?.from ?? -1,
        nestedTask.markers[1]?.to ?? -1,
        "cm-live-preview-task-marker",
      ),
    ).toBe(true);
    expect(
      hasDecorationClassAt(
        state,
        source.indexOf("- code"),
        source.indexOf("- code") + 1,
        "cm-live-preview-list-marker",
      ),
    ).toBe(false);
    expect(state.doc.toString()).toBe(source);

    engine.dispose();
  });

  it("keeps the Preview-inspired heading rhythm and list gutter as presentation-only CSS", () => {
    const source =
      "# one\n## two\n#### four\n##### five\n###### six\n- item\n1. ordered\n---\n- [ ] task";
    const engine = createLivePreviewEngine();
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        selection: { anchor: source.length },
        extensions: [engine.extension],
      }),
    });

    const h1 = view.contentDOM.querySelector<HTMLElement>(".cm-live-preview-heading-1");
    const h4 = view.contentDOM.querySelector<HTMLElement>(".cm-live-preview-heading-4");
    const h5 = view.contentDOM.querySelector<HTMLElement>(".cm-live-preview-heading-5");
    const h6 = view.contentDOM.querySelector<HTMLElement>(".cm-live-preview-heading-6");
    const unordered = view.contentDOM.querySelector<HTMLElement>(
      ".cm-live-preview-list-unordered-marker",
    );
    const ordered = view.contentDOM.querySelector<HTMLElement>(
      ".cm-live-preview-list-ordered-marker",
    );
    const horizontalRule = view.contentDOM.querySelector<HTMLElement>(
      ".cm-line.cm-live-preview-horizontal-rule",
    );
    expect(h1?.closest(".cm-line")?.className).toContain("cm-live-preview-heading-line-1");
    expect(h4).not.toBeNull();
    expect(h5).not.toBeNull();
    expect(h6).not.toBeNull();
    expect(unordered).not.toBeNull();
    expect(ordered).not.toBeNull();
    expect(horizontalRule?.textContent).toBe("---");
    // Theme/style changes must not alter source or create a transaction.
    expect(view.state.doc.toString()).toBe(source);

    const ruleFrom = source.indexOf("---");
    view.dispatch({ selection: { anchor: ruleFrom + 1 } });
    expect(view.contentDOM.querySelector(".cm-line.cm-live-preview-horizontal-rule")).toBeNull();
    expect(view.state.doc.toString()).toBe(source);

    view.dispatch({ selection: { anchor: ruleFrom, head: ruleFrom + 2 } });
    expect(view.contentDOM.querySelector(".cm-line.cm-live-preview-horizontal-rule")).toBeNull();
    expect(view.state.doc.toString()).toBe(source);

    view.dispatch({ selection: { anchor: source.length } });
    expect(
      view.contentDOM.querySelector(".cm-line.cm-live-preview-horizontal-rule"),
    ).not.toBeNull();
    expect(view.state.doc.toString()).toBe(source);

    view.destroy();
    engine.dispose();
  });

  it("presents blockquote markers and line classes without changing source coordinates", () => {
    const source = "> first quote\n> second quote\nplain";
    const engine = createLivePreviewEngine();
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        selection: { anchor: source.length },
        extensions: [engine.extension],
      }),
    });

    const quoteLines = [
      ...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line.cm-live-preview-blockquote-line"),
    ];
    expect(quoteLines).toHaveLength(2);
    expect(quoteLines.map((line) => line.textContent)).toEqual(["first quote", "second quote"]);
    expect(view.contentDOM.querySelectorAll(".cm-live-preview-blockquote")).toHaveLength(2);
    expect(view.state.doc.toString()).toBe(source);

    view.dispatch({ selection: { anchor: 1 } });
    expect(view.state.doc.toString()).toBe(source);
    expect(quoteLines[0]?.textContent).toBe("> first quote");
    expect(quoteLines[0]?.classList.contains("cm-live-preview-blockquote-line")).toBe(true);
    expect(quoteLines[1]?.textContent).toBe("second quote");

    view.destroy();
    engine.dispose();
  });

  it("keeps adjacent inline syntax in preview and reveals every marker only inside syntax", () => {
    const cases = [
      ["link", "[label](target.md)"],
      ["strong", "**bold**"],
      ["emphasis", "_italic_"],
      ["strikethrough", "~~strike~~"],
      ["inline code", "`code`"],
    ] as const;

    for (const [name, source] of cases) {
      const engine = createLivePreviewEngine();
      const nextLineState = EditorState.create({
        doc: `${source}\nplain`,
        selection: { anchor: source.length + 1 },
        extensions: [engine.extension],
      });
      const [nextLineSyntax] = findPresentationSyntax(nextLineState.doc.toString());
      expect(nextLineSyntax, name).toBeDefined();
      if (nextLineSyntax === undefined) {
        throw new Error(`Expected ${name} syntax.`);
      }

      expect(
        isSyntaxActive(nextLineSyntax, [{ from: source.length + 1, to: source.length + 1 }]),
        name,
      ).toBe(false);
      expect(hiddenReplacementRanges(nextLineState), name).toEqual(
        nextLineSyntax.markers.map(({ from, to }) => ({ from, to })),
      );

      const activeSelection = nextLineState.update({
        selection: { anchor: nextLineSyntax.contentFrom },
      });
      expect(activeSelection.docChanged, name).toBe(false);
      expect(activeSelection.state.doc.toString(), name).toBe(`${source}\nplain`);
      expect(hiddenReplacementRanges(activeSelection.state), name).toEqual([]);

      engine.dispose();
    }
  });

  it("keeps a preceding-line caret from revealing the next line and keeps visible markers", () => {
    const engine = createLivePreviewEngine();
    const source = "plain\n[label](target.md)\n- item\n- [ ] task\n# heading\n> quote";
    const state = EditorState.create({
      doc: source,
      selection: { anchor: "plain".length },
      extensions: [engine.extension],
    });
    const syntax = findPresentationSyntax(source);
    const link = syntax.find(({ kind }) => kind === "link");
    if (link === undefined) {
      throw new Error("Expected link syntax.");
    }

    expect(isSyntaxActive(link, [{ from: "plain".length, to: "plain".length }])).toBe(false);
    expect(hiddenReplacementRanges(state)).toEqual(
      syntax
        .flatMap(({ markers }) => markers)
        .filter(({ presentation }) => presentation === undefined || presentation === "hidden")
        .map(({ from, to }) => ({ from, to })),
    );
    expect(markClasses(state)).toContain(
      "cm-live-preview-list-marker cm-live-preview-list-unordered-marker",
    );
    expect(markClasses(state)).toContain(
      "cm-live-preview-task-marker cm-live-preview-task-unchecked",
    );
    expect(markClasses(state)).toContain("cm-live-preview-heading cm-live-preview-heading-1");
    expect(markClasses(state)).toContain("cm-live-preview-blockquote");

    engine.dispose();
  });

  it("uses replacement DOM for inactive link markers and restores raw source only inside the link", () => {
    const engine = createLivePreviewEngine();
    const source = "[label](target.md)\nplain";
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        selection: { anchor: "[label](target.md)\n".length },
        extensions: [engine.extension],
      }),
    });

    expect(
      [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => line.textContent),
    ).toEqual(["label", "plain"]);
    view.dispatch({ selection: { anchor: 3 } });
    expect(
      [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => line.textContent),
    ).toEqual(["[label](target.md)", "plain"]);

    view.destroy();
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

function hiddenReplacementRanges(
  state: EditorState,
): readonly { readonly from: number; readonly to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  state
    .field(livePreviewState)
    .decorations.between(0, state.doc.length, (from, to, value): void => {
      if (hasHiddenPresentation(value)) {
        ranges.push({ from, to });
      }
    });
  return ranges;
}

function markClasses(state: EditorState): readonly string[] {
  const classes: string[] = [];
  state
    .field(livePreviewState)
    .decorations.between(0, state.doc.length, (_from, _to, value): void => {
      const className = decorationClass(value);
      if (className !== undefined) {
        classes.push(className);
      }
    });
  return classes;
}

function hasMarkerClassAt(state: EditorState, from: number, to: number): boolean {
  return hasDecorationClassAt(state, from, to, "cm-live-preview-list-unordered-marker");
}

function hasDecorationClassAt(
  state: EditorState,
  from: number,
  to: number,
  className: string,
): boolean {
  let found = false;
  state.field(livePreviewState).decorations.between(from, to, (rangeFrom, rangeTo, value): void => {
    if (
      rangeFrom === from &&
      rangeTo === to &&
      decorationClass(value)?.includes(className) === true
    ) {
      found = true;
    }
  });
  return found;
}

function markerClassAt(state: EditorState, position: number): string | undefined {
  let className: string | undefined;
  state
    .field(livePreviewState)
    .decorations.between(position, position + 1, (_from, _to, value): void => {
      const candidate = decorationClass(value);
      if (candidate?.includes("cm-live-preview-list-unordered-marker") === true) {
        className = candidate;
      }
    });
  return className;
}

function hasHiddenPresentation(value: Decoration): boolean {
  const spec = value.spec as unknown;
  return isRecord(spec) && spec["markerPresentation"] === "hidden";
}

function decorationClass(value: Decoration): string | undefined {
  const spec = value.spec as unknown;
  return isRecord(spec) && typeof spec["class"] === "string" ? spec["class"] : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
