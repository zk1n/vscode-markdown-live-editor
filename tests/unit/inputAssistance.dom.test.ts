// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { insertHeadingParagraph } from "../../src/webview/inputAssistance.js";
import { compactSpacing } from "../../src/webview/livePreview/compactSpacing.js";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});
function editor(doc: string, anchor: number, head = anchor): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor, head }, extensions: compactSpacing }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
describe("heading Enter and independent compact presentation", () => {
  it.each([
    ["# 日本語", "# 日本語\n\n", 7],
    ["# h\nbody", "# h\n\n\nbody", 5],
    ["# h\n\nbody", "# h\n\n\nbody", 5],
    ["# h\n\n\nbody", "# h\n\n\nbody", 5],
    ["# h\n\n", "# h\n\n", 5],
    ["# h\n", "# h\n\n", 5],
    ["# h\n## next", "# h\n\n\n## next", 5],
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
  it("compacts only isolated empty lines and reveals selected blanks without a change", () => {
    const doc = "# h\n\nbody\n\n\nnext\n  \nend\n```\n\ncode\n```";
    const view = editor(doc, 0);
    expect(view.dom.querySelectorAll(".cm-live-preview-compact-blank")).toHaveLength(1);
    view.dispatch({ selection: { anchor: 4 } });
    expect(view.dom.querySelectorAll(".cm-live-preview-compact-blank")).toHaveLength(0);
    expect(view.state.doc.toString()).toBe(doc);
  });
});
