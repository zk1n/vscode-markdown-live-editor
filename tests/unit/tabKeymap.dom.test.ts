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
