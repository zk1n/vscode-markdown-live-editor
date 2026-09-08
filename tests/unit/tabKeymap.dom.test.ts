// @vitest-environment happy-dom

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { createTabKeymap } from "../../src/webview/tabKeymap.js";

const views: EditorView[] = [];

afterEach((): void => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
});

function createView(
  text: string,
  selection: { anchor: number; head: number },
  callbacks: {
    isTabEditable?: () => boolean;
    insertSpaces?: () => boolean;
    tabSize?: () => number;
  } = {},
  extensions: readonly Extension[] = [],
): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection,
      extensions: [
        ...extensions,
        keymap.of(
          createTabKeymap({
            isTabEditable: callbacks.isTabEditable ?? (() => true),
            getInsertSpaces: callbacks.insertSpaces ?? (() => true),
            getTabSize: callbacks.tabSize ?? (() => 2),
          }),
        ),
      ],
    }),
    parent,
  });
  views.push(view);
  return view;
}

function pressTab(view: EditorView, shift = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: "Tab",
    key: "Tab",
    shiftKey: shift,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("Tab keymap", () => {
  it("inserts spaces to the next tab stop for collapsed caret", () => {
    const view = createView("abcdef", { anchor: 1, head: 1 }, { tabSize: () => 4 });
    const event = pressTab(view);
    expect(view.state.doc.toString()).toBe("a   bcdef");
    expect(event.defaultPrevented).toBe(true);
  });

  it("inserts a literal tab when insertSpaces is disabled", () => {
    const view = createView(
      "abcdef",
      { anchor: 1, head: 1 },
      {
        insertSpaces: () => false,
        tabSize: () => 4,
      },
    );
    const event = pressTab(view);
    expect(view.state.doc.toString()).toBe("a\tbcdef");
    expect(event.defaultPrevented).toBe(true);
  });

  it("uses the visual column after an existing tab for the next space tab stop", () => {
    const view = createView("a\tb", { anchor: 2, head: 2 }, { tabSize: () => 4 });
    pressTab(view);
    expect(view.state.doc.toString()).toBe("a\t    b");
  });

  it("indents selected lines", () => {
    const view = createView("alpha\nbeta", { anchor: 0, head: 10 }, { tabSize: () => 4 });
    const event = pressTab(view);
    expect(view.state.doc.toString()).toBe("    alpha\n    beta");
    expect(event.defaultPrevented).toBe(true);
  });

  it("outdents selected lines with Shift+Tab", () => {
    const view = createView("    alpha\n    beta", { anchor: 0, head: 17 }, { tabSize: () => 4 });
    const event = pressTab(view, true);
    expect(view.state.doc.toString()).toBe("alpha\nbeta");
    expect(event.defaultPrevented).toBe(true);
  });

  it("indents multi-line selections with literal tabs and excludes an ending line-start", () => {
    const view = createView(
      "alpha\nbeta\ngamma",
      { anchor: 0, head: 11 },
      {
        insertSpaces: () => false,
        tabSize: () => 8,
      },
    );
    pressTab(view);
    expect(view.state.doc.toString()).toBe("\talpha\n\tbeta\ngamma");
  });

  it("outdents one literal tab or at most one configured space unit per line", () => {
    const view = createView("\talpha\n  beta", { anchor: 0, head: 13 }, { tabSize: () => 4 });
    pressTab(view, true);
    expect(view.state.doc.toString()).toBe("alpha\nbeta");
  });

  it.each([
    { insertSpaces: true, tabSize: 2, source: "    - [ ] child", expected: "  - [ ] child" },
    { insertSpaces: true, tabSize: 4, source: "    - [ ] child", expected: "- [ ] child" },
    { insertSpaces: false, tabSize: 4, source: "\t- [ ] child", expected: "- [ ] child" },
  ])(
    "outdents an indented nested task with a caret",
    ({ insertSpaces, tabSize, source, expected }) => {
      const view = createView(
        source,
        { anchor: source.indexOf("child"), head: source.indexOf("child") },
        {
          insertSpaces: () => insertSpaces,
          tabSize: () => tabSize,
        },
      );
      pressTab(view, true);
      expect(view.state.doc.toString()).toBe(expected);
    },
  );

  it.each([
    { insertSpaces: true, tabSize: 2, source: "    - item", expected: "  - item" },
    { insertSpaces: true, tabSize: 4, source: "    - item", expected: "- item" },
    { insertSpaces: false, tabSize: 4, source: "\t- item", expected: "- item" },
  ])(
    "outdents an indented single-line selection",
    ({ insertSpaces, tabSize, source, expected }) => {
      const view = createView(
        source,
        { anchor: 4, head: source.length },
        {
          insertSpaces: () => insertSpaces,
          tabSize: () => tabSize,
        },
      );
      pressTab(view, true);
      expect(view.state.doc.toString()).toBe(expected);
    },
  );

  it("blocks edits while the gate is closed and keeps the key inside editor", () => {
    const view = createView(
      "abcdef",
      { anchor: 1, head: 1 },
      {
        isTabEditable: () => false,
      },
    );
    view.focus();
    const event = pressTab(view);
    expect(view.state.doc.toString()).toBe("abcdef");
    expect(event.defaultPrevented).toBe(true);
    expect(view.hasFocus).toBe(true);
  });

  it.each(["composition", "recovery"])(
    "keeps %s-gated Tab inside the editor without changing source",
    () => {
      const view = createView(
        "abcdef",
        { anchor: 2, head: 2 },
        {
          isTabEditable: () => false,
        },
      );
      view.focus();
      const event = pressTab(view);
      expect(event.defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe("abcdef");
      expect(view.state.selection.main).toMatchObject({ anchor: 2, head: 2 });
      expect(view.hasFocus).toBe(true);
    },
  );
});

// Captured from installed VS Code 1.136.1: spaces, display size, source, selection, command, result, selection.
const standardEditorCases = [
  [true, 2, "", 0, 0, "tab", "  ", 2, 2],
  [true, 2, "abc", 1, 1, "tab", "a bc", 2, 2],
  [true, 2, "- item", 2, 2, "tab", "-   item", 4, 4],
  [true, 2, "1. item", 3, 3, "tab", "1.  item", 4, 4],
  [true, 2, "- [ ] item", 6, 6, "tab", "- [ ]   item", 8, 8],
  [true, 2, "abc", 1, 2, "tab", "a c", 2, 2],
  [true, 2, " a\n   b", 0, 7, "tab", "  a\n    b", 0, 9],
  [true, 2, " a\n   b", 0, 7, "outdent", "a\n  b", 0, 5],
  [true, 4, "", 0, 0, "tab", "    ", 4, 4],
  [true, 4, "abc", 1, 1, "tab", "a   bc", 4, 4],
  [true, 4, "- item", 2, 2, "tab", "-   item", 4, 4],
  [true, 4, "1. item", 3, 3, "tab", "1.  item", 4, 4],
  [true, 4, "- [ ] item", 6, 6, "tab", "- [ ]   item", 8, 8],
  [true, 4, "abc", 1, 2, "tab", "a   c", 4, 4],
  [true, 4, " a\n   b", 0, 7, "tab", "    a\n    b", 0, 11],
  [true, 4, " a\n   b", 0, 7, "outdent", "a\nb", 0, 3],
  [true, 8, "", 0, 0, "tab", "        ", 8, 8],
  [true, 8, "abc", 1, 1, "tab", "a       bc", 8, 8],
  [true, 8, "- item", 2, 2, "tab", "-       item", 8, 8],
  [true, 8, "1. item", 3, 3, "tab", "1.      item", 8, 8],
  [true, 8, "- [ ] item", 6, 6, "tab", "- [ ]   item", 8, 8],
  [true, 8, "abc", 1, 2, "tab", "a       c", 8, 8],
  [true, 8, " a\n   b", 0, 7, "tab", "        a\n        b", 0, 19],
  [true, 8, " a\n   b", 0, 7, "outdent", "a\nb", 0, 3],
  [false, 2, "", 0, 0, "tab", "\t", 1, 1],
  [false, 2, "abc", 1, 1, "tab", "a\tbc", 2, 2],
  [false, 2, "- item", 2, 2, "tab", "- \titem", 3, 3],
  [false, 2, "1. item", 3, 3, "tab", "1. \titem", 4, 4],
  [false, 2, "- [ ] item", 6, 6, "tab", "- [ ] \titem", 7, 7],
  [false, 2, "abc", 1, 2, "tab", "a\tc", 2, 2],
  [false, 2, " a\n   b", 0, 7, "tab", "\ta\n\t\tb", 0, 6],
  [false, 2, " a\n   b", 0, 7, "outdent", "a\n\tb", 0, 4],
  [false, 4, "", 0, 0, "tab", "\t", 1, 1],
  [false, 4, "abc", 1, 1, "tab", "a\tbc", 2, 2],
  [false, 4, "- item", 2, 2, "tab", "- \titem", 3, 3],
  [false, 4, "1. item", 3, 3, "tab", "1. \titem", 4, 4],
  [false, 4, "- [ ] item", 6, 6, "tab", "- [ ] \titem", 7, 7],
  [false, 4, "abc", 1, 2, "tab", "a\tc", 2, 2],
  [false, 4, " a\n   b", 0, 7, "tab", "\ta\n\tb", 0, 5],
  [false, 4, " a\n   b", 0, 7, "outdent", "a\nb", 0, 3],
  [false, 8, "", 0, 0, "tab", "\t", 1, 1],
  [false, 8, "abc", 1, 1, "tab", "a\tbc", 2, 2],
  [false, 8, "- item", 2, 2, "tab", "- \titem", 3, 3],
  [false, 8, "1. item", 3, 3, "tab", "1. \titem", 4, 4],
  [false, 8, "- [ ] item", 6, 6, "tab", "- [ ] \titem", 7, 7],
  [false, 8, "abc", 1, 2, "tab", "a\tc", 2, 2],
  [false, 8, " a\n   b", 0, 7, "tab", "\ta\n\tb", 0, 5],
  [false, 8, " a\n   b", 0, 7, "outdent", "a\nb", 0, 3],
] as const;

describe("installed VS Code 1.136.1 indentation oracle", () => {
  it.each(standardEditorCases)(
    "spaces %s / size %s / %s / selection %s:%s / %s",
    (insertSpaces, tabSize, text, start, end, command, result, anchor, head) => {
      const view = createView(
        text,
        { anchor: start, head: end },
        {
          insertSpaces: () => insertSpaces,
          tabSize: () => tabSize,
        },
      );
      const event = pressTab(view, command === "outdent");
      expect(view.state.doc.toString()).toBe(result);
      expect(view.state.selection.main.anchor).toBe(anchor);
      expect(view.state.selection.main.head).toBe(head);
      expect(event.defaultPrevented).toBe(true);
    },
  );
});
