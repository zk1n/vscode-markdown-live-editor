// @vitest-environment happy-dom
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it } from "vitest";
import {
  compactSpacingEnabled,
  createCompactSpacing,
} from "../../src/webview/livePreview/compactSpacing.js";

const views: EditorView[] = [];
it("protects separator deletion through both keys and transactions, while allowing explicit ranges", () => {
  const source = "# h\n\nbody";
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: source,
      selection: { anchor: 5 },
      extensions: [createCompactSpacing()],
    }),
  });
  views.push(view);
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
  );
  expect(view.state.doc.toString()).toBe(source);
  expect(view.state.selection.main.head).toBe(3);
  view.dispatch({ changes: { from: 3, to: 4 }, userEvent: "delete.forward" });
  expect(view.state.doc.toString()).toBe(source);
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  view.dispatch({ ...view.state.replaceSelection(""), userEvent: "delete.cut" });
  expect(view.state.doc.toString()).toBe("body");
});
afterEach(() => {
  views.splice(0).forEach((view) => {
    view.destroy();
  });
  document.body.replaceChildren();
});
it("skips only structural blank carets, keeps ranges, composition and disabled/source editing", () => {
  const source = "# title\n\nbody\n\nordinary\n\n\nlast";
  const enabled = new Compartment();
  let composing = false;
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: source,
      extensions: [
        createCompactSpacing(() => composing),
        enabled.of(compactSpacingEnabled.of(true)),
      ],
    }),
  });
  views.push(view);
  view.dispatch({ selection: { anchor: 8 } });
  expect(view.state.selection.main.head).toBe(9);
  view.dispatch({ selection: { anchor: 8 } });
  expect(view.state.selection.main.head).toBe(7);
  view.dispatch({ selection: { anchor: 6, head: 10 } });
  expect(view.state.sliceDoc(6, 10)).toBe("e\n\nb");
  expect(view.state.selection.main.head).toBe(10);
  composing = true;
  view.dispatch({ selection: { anchor: 8 } });
  expect(view.state.selection.main.head).toBe(8);
  composing = false;
  view.dispatch({
    effects: enabled.reconfigure(compactSpacingEnabled.of(false)),
    selection: { anchor: 8 },
  });
  expect(view.state.selection.main.head).toBe(8);
  expect(view.dom.querySelector(".cm-structural-gap")).toBeNull();
  view.dispatch({
    effects: enabled.reconfigure(compactSpacingEnabled.of(true)),
    selection: { anchor: 14 },
  });
  expect(view.state.selection.main.head).toBe(14);
  expect(view.state.doc.toString()).toBe(source);
  view.dispatch({ changes: { from: 0, to: 2 }, selection: { anchor: 6 } });
  expect(view.dom.querySelector(".cm-structural-gap")).toBeNull();
  expect(view.state.selection.main.head).toBe(6);
});
