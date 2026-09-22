// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceLineNumbers, sourceLineSelection } from "../../src/webview/sourceLines.js";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function createView(doc: string): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [sourceLineSelection, sourceLineNumbers(() => [])],
    }),
  });
  views.push(view);
  return view;
}

function clipboardEvent(type: "copy" | "cut", data: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: data });
  return event;
}

describe("source line selection display and clipboard ranges", () => {
  it("ends the visible selection at line content while copying the exact LF separator", () => {
    const source = "first\nsecond\nthird";
    const view = createView(source);
    const second = view.state.doc.line(2);
    view.dispatch({
      selection: { anchor: view.state.doc.line(1).from, head: second.to },
      userEvent: "select.line",
    });

    expect(view.state.selection.main.to).toBe(second.to);
    expect(view.state.selection.main.to).not.toBe(view.state.doc.line(3).from);

    const clipboard = new DataTransfer();
    const event = clipboardEvent("copy", clipboard);
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboard.getData("text/plain")).toBe("first\nsecond\n");
    expect(view.state.doc.toString()).toBe(source);
  });

  it("biases an exact gutter boundary upward without changing the logical range", () => {
    const view = createView("first\nsecond\nthird");
    const gutter = view.dom.querySelector<HTMLElement>(".cm-lineNumbers .cm-gutterElement");
    if (gutter === null) throw new Error("Expected line-number gutter.");
    const boundary = 24;
    const expectedBlock = view.lineBlockAt(view.state.doc.line(2).from);
    const heights: number[] = [];
    const blockAtHeight = vi.spyOn(view, "lineBlockAtHeight").mockImplementation((height) => {
      heights.push(height);
      return expectedBlock;
    });
    gutter.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        pointerId: 7,
        clientY: 0,
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        buttons: 1,
        pointerId: 7,
        clientY: boundary,
      }),
    );
    expect(blockAtHeight).toHaveBeenCalled();
    expect(heights.at(-1)).toBe(Math.max(0, boundary - view.documentTop - 1));
    expect(view.state.selection.main.to).toBe(view.state.doc.line(2).to);
    document.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 7, clientY: boundary }),
    );
  });

  it("keeps normalized line-break and EOF semantics for cut without selecting the next line's first character", () => {
    const source = "first\r\nsecond\r\nthird";
    const view = createView(source);
    const first = view.state.doc.line(1);
    const second = view.state.doc.line(2);
    view.dispatch({
      selection: { anchor: first.from, head: second.to },
      userEvent: "select.line",
    });

    const clipboard = new DataTransfer();
    const event = clipboardEvent("cut", clipboard);
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    // CodeMirror's source model uses LF boundaries; the host preserves the
    // document EOL when it applies the transaction back to TextDocument.
    expect(clipboard.getData("text/plain")).toBe("first\nsecond\n");
    expect(view.state.doc.toString()).toBe("third");
    expect(view.state.selection.main.empty).toBe(true);

    const last = view.state.doc.line(1);
    view.dispatch({
      selection: { anchor: last.from, head: last.to },
      userEvent: "select.line",
    });
    const eofClipboard = new DataTransfer();
    view.contentDOM.dispatchEvent(clipboardEvent("copy", eofClipboard));
    expect(eofClipboard.getData("text/plain")).toBe("third");
  });

  it("copies and cuts an empty physical line without borrowing the next line", () => {
    const source = "first\n\nthird";
    const view = createView(source);
    const empty = view.state.doc.line(2);
    view.dispatch({
      selection: { anchor: empty.from, head: empty.to },
      userEvent: "select.line",
    });

    expect(view.state.selection.main.empty).toBe(true);
    const clipboard = new DataTransfer();
    view.contentDOM.dispatchEvent(clipboardEvent("copy", clipboard));
    expect(clipboard.getData("text/plain")).toBe("\n");

    const cutClipboard = new DataTransfer();
    view.contentDOM.dispatchEvent(clipboardEvent("cut", cutClipboard));
    expect(cutClipboard.getData("text/plain")).toBe("\n");
    expect(view.state.doc.toString()).toBe("first\nthird");
  });
});
