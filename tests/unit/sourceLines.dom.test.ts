// @vitest-environment happy-dom

import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
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
      extensions: [sourceLineSelection, sourceLineNumbers(() => []), history()],
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
  it("keeps gutter-selected cut and deletion behind read-only and composition gates", () => {
    const view = createView("left\n\nright");
    const line = view.state.doc.line(2);
    view.dispatch({ selection: { anchor: line.from }, userEvent: "select.line" });
    const composing = vi.spyOn(view, "composing", "get").mockReturnValue(true);
    view.contentDOM.dispatchEvent(clipboardEvent("cut", new DataTransfer()));
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(view.state.doc.toString()).toBe("left\n\nright");
    composing.mockRestore();
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    view.contentDOM.dispatchEvent(clipboardEvent("cut", new DataTransfer()));
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(view.state.doc.toString()).toBe("left\n\nright");
  });
  it.each(["\n", "\r\n"])(
    "keeps heading/blank/body ranges exact for %j, both directions and origins",
    (eol) => {
      for (const reverse of [false, true])
        for (const emptyEnd of [false, true]) {
          const view = createView(["neighbor", "### Heading", "", "body", "after"].join(eol));
          const original = view.state.doc.toString();
          const first = view.state.doc.line(2);
          const last = view.state.doc.line(emptyEnd ? 3 : 4);
          view.dispatch({
            selection: {
              anchor: reverse ? last.to : first.from,
              head: reverse ? first.from : last.to,
            },
            userEvent: "select.line",
          });
          expect(view.state.selection.main).toMatchObject({ from: first.from, to: last.to });
          expect(view.state.sliceDoc(first.from, last.to)).toBe(
            emptyEnd ? "### Heading\n" : "### Heading\n\nbody",
          );
          const data = new DataTransfer();
          view.contentDOM.dispatchEvent(clipboardEvent("copy", data));
          expect(data.getData("text/plain")).toBe(
            emptyEnd ? "### Heading\n\n" : "### Heading\n\nbody\n",
          );
          view.contentDOM.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: reverse ? "Backspace" : "Delete",
              bubbles: true,
              cancelable: true,
            }),
          );
          expect(view.state.doc.toString()).toBe(
            emptyEnd ? "neighbor\nbody\nafter" : "neighbor\nafter",
          );
          expect(undo(view)).toBe(true);
          expect(view.state.doc.toString()).toBe(original);
          expect(redo(view)).toBe(true);
          undo(view);
          // Body-origin text selection has literal boundaries, without the
          // gutter's whole-line separator contract.
          view.dispatch({
            selection: {
              anchor: reverse ? last.to : first.from,
              head: reverse ? first.from : last.to,
            },
            userEvent: "select.pointer",
          });
          expect(view.state.field(sourceLineSelection)).toBe(false);
          view.dispatch({ ...view.state.replaceSelection(""), userEvent: "delete.selection" });
          expect(view.state.doc.toString()).toBe(
            emptyEnd ? "neighbor\n\nbody\nafter" : "neighbor\n\nafter",
          );
          expect(undo(view)).toBe(true);
          expect(view.state.doc.toString()).toBe(original);
        }
    },
  );

  it.each(["Backspace", "Delete"])("%s deletes only a gutter-selected empty line", (key) => {
    const view = createView("left\n\nright");
    const line = view.state.doc.line(2);
    view.dispatch({ selection: { anchor: line.from }, userEvent: "select.line" });
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("left\nright");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("left\n\nright");
    view.dispatch({ selection: { anchor: 1 }, userEvent: "select" });
    expect(view.state.field(sourceLineSelection)).toBe(false);
  });
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

  it("resolves an exact gutter boundary without changing the logical range", () => {
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
    expect(heights.at(-1)).toBe(boundary - view.documentTop);
    expect(view.state.selection.main.to).toBe(view.state.doc.line(2).to);
    document.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 7, clientY: boundary }),
    );
  });

  it("uses the actual gutter element block identity during a drag", () => {
    const view = createView("first\nsecond\nthird");
    const gutter = view.dom.querySelector<HTMLElement>(".cm-lineNumbers .cm-gutterElement");
    if (gutter === null) throw new Error("Expected line-number gutter.");
    const expectedBlock = view.lineBlockAt(view.state.doc.line(2).from);
    const heights: number[] = [];
    const blockAtHeight = vi.spyOn(view, "lineBlockAtHeight").mockImplementation((height) => {
      heights.push(height);
      return expectedBlock;
    });
    Object.defineProperty(gutter, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 12, 100, 24),
    });
    gutter.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        pointerId: 8,
        clientY: 12,
      }),
    );
    gutter.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        buttons: 1,
        pointerId: 8,
        clientY: 999,
      }),
    );
    expect(blockAtHeight).toHaveBeenCalled();
    expect(heights.at(-1)).toBe((12 + 36) / 2 - view.documentTop);
    expect(view.state.selection.main.to).toBe(expectedBlock.to);
    document.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 8, clientY: 999 }),
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
