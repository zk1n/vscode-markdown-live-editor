// @vitest-environment happy-dom
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { insertHeadingParagraph } from "../../src/webview/inputAssistance.js";
import { compactSpacing } from "../../src/webview/livePreview/compactSpacing.js";
import {
  structuralInputAssistance,
  structuralProvenance,
  restoreStructuralHistory,
} from "../../src/webview/structuralSpacing.js";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});
function editor(doc: string, anchor: number, head = anchor): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [structuralInputAssistance(), compactSpacing],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
describe("heading Enter and independent compact presentation", () => {
  it("does not collapse multiple selections into the one structural deletion shortcut", () => {
    const view = editor("# h\n\nbody", 3);
    view.dispatch({
      effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)),
    });
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(7)]),
    });
    expect(view.state.selection.ranges).toHaveLength(2);
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
    );
    expect(view.state.selection.ranges).toHaveLength(2);
    expect(view.state.doc.toString()).toBe("# h\n\nbody");
  });
  it.each([
    ["# 日本語", "# 日本語\n\n", 7],
    ["# h\nbody", "# h\n\n\nbody", 5],
    ["# h\n\nbody", "# h\n\n\nbody", 5],
    ["# h\n\n\nbody", "# h\n\n\nbody", 5],
    ["# h\n\n", "# h\n\n", 5],
    ["# h\n", "# h\n\n", 5],
    ["# h\n## next", "# h\n\n\n## next", 5],
    ["  # h", "  # h\n\n", 7],
  ])("creates one writable paragraph for %j", (before, after, caret) => {
    const view = editor(before, before.includes("\n") ? before.indexOf("\n") : before.length);
    expect(insertHeadingParagraph(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(after);
    expect(view.state.selection.main.head).toBe(caret);
  });
  it.each(["```md\n# h\n```", "---\n# h\n---", "    # h", "> # h", "`# h`", "paragraph # h"])(
    "ignores non-heading source: %j",
    (doc) => {
      const caret = doc.indexOf("# h") + 3;
      const view = editor(doc, caret);
      expect(insertHeadingParagraph(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    },
  );
  it("does not adjust mid-heading or selection replacement", () => {
    expect(insertHeadingParagraph(editor("# heading", 4))).toBe(false);
    expect(insertHeadingParagraph(editor("# heading", 2, 9))).toBe(false);
  });
  it("compacts structural separators without expanding them for selection or claiming ownership", () => {
    const doc = "# h\n\nbody\n\n\nnext\n  \nend\n```\n\ncode\n```";
    const view = editor(doc, 0);
    expect(view.dom.querySelectorAll(".cm-structural-gap")).toHaveLength(1);
    view.dispatch({ selection: { anchor: 4 } });
    expect(view.dom.querySelectorAll(".cm-structural-gap")).toHaveLength(1);
    expect(view.state.field(structuralProvenance).owned).toHaveLength(0);
    expect(view.state.doc.toString()).toBe(doc);
  });
  it("inserts and removes only the managed heading separator in the same input transaction", () => {
    const view = editor("見出し\n本文", 0);
    view.dispatch({ changes: { from: 0, insert: "## " }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toBe("## 見出し\n\n本文");
    expect(view.state.field(structuralProvenance).owned).toHaveLength(1);
    view.dispatch({ changes: { from: 0, to: 3 }, userEvent: "delete.backward" });
    expect(view.state.doc.toString()).toBe("見出し\n本文");
    expect(view.state.field(structuralProvenance).owned).toHaveLength(0);
  });
  it("restores known provenance on authority Undo/Redo and never reforms on Undo", () => {
    const view = editor("title\nbody", 0);
    view.dispatch({ changes: { from: 0, insert: "# " }, userEvent: "input.type" });
    const heading = view.state.doc.toString();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "title\nbody" },
      effects: restoreStructuralHistory.of(true),
    });
    expect(view.state.doc.toString()).toBe("title\nbody");
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: heading },
      effects: restoreStructuralHistory.of(true),
    });
    expect(view.state.field(structuralProvenance).owned).toHaveLength(1);
    view.dispatch({ changes: { from: 0, to: 2 }, userEvent: "delete.backward" });
    expect(view.state.doc.toString()).toBe("title\nbody");
  });
  it.each(["> title", "- title", "    title"])(
    "keeps the separator when the heading becomes another block: %s",
    (replacement) => {
      const view = editor("title\nbody", 0);
      view.dispatch({ changes: { from: 0, insert: "# " }, userEvent: "input.type" });
      view.dispatch({ changes: { from: 0, to: 7, insert: replacement }, userEvent: "input.type" });
      expect(view.state.doc.toString()).toBe(`${replacement}\n\nbody`);
      expect(view.state.field(structuralProvenance).owned).toHaveLength(0);
    },
  );
  it("does not create a Setext heading by removing its generated separator", () => {
    const view = editor("title\n---", 0);
    view.dispatch({ changes: { from: 0, insert: "# " }, userEvent: "input.type" });
    view.dispatch({ changes: { from: 0, to: 2 }, userEvent: "delete.backward" });
    expect(view.state.doc.toString()).toBe("title\n\n---");
  });
  it("preserves existing and manually expanded paragraph separators", () => {
    const existing = editor("# title\n\nbody", 0);
    existing.dispatch({ changes: { from: 0, to: 2 }, userEvent: "delete.backward" });
    expect(existing.state.doc.toString()).toBe("title\n\nbody");
    const view = editor("title\nbody", 0);
    view.dispatch({ changes: { from: 0, insert: "# " }, userEvent: "input.type" });
    view.dispatch({ changes: { from: 8, insert: "\n" }, userEvent: "input.type" });
    view.dispatch({ changes: { from: 0, to: 2 }, userEvent: "delete.backward" });
    expect(view.state.doc.toString()).toBe("title\n\n\nbody");
  });
  it("keeps ordinary paragraph space and the empty input line after heading Enter", () => {
    const ordinary = editor("first\n\nsecond", 0);
    expect(ordinary.dom.querySelectorAll(".cm-structural-gap")).toHaveLength(0);
    const view = editor("# title", 7);
    insertHeadingParagraph(view);
    expect(view.state.doc.toString()).toBe("# title\n\n");
    expect(view.state.selection.main.head).toBe(9);
    expect(view.dom.querySelectorAll(".cm-structural-gap")).toHaveLength(1);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
  });
});
