// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { createBarrierKeymap } from "../../src/webview/barrierKeymap.js";

const views: EditorView[] = [];

afterEach((): void => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
});

function createView(actions: string[]): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: "ABCDEF",
      extensions: [
        keymap.of(
          createBarrierKeymap((action): void => {
            actions.push(action);
          }),
        ),
      ],
    }),
    parent,
  });
  views.push(view);
  return view;
}

function keydown(
  view: EditorView,
  key: string,
  options: Readonly<KeyboardEventInit> = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: true,
    key,
    ...options,
  });
  Object.defineProperty(event, "keyCode", { value: key.toUpperCase().charCodeAt(0) });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("barrier shortcut propagation", () => {
  it.each([
    ["Mod-s", "s", {}, "save"],
    ["Mod-z", "z", {}, "undo"],
    ["Mod-y", "y", {}, "redo"],
    ["Mod-Shift-z", "Z", { shiftKey: true }, "redo"],
  ] as const)("handles %s as one %s barrier without bubbling", (_name, key, options, action) => {
    const actions: string[] = [];
    const view = createView(actions);
    let outerEvents = 0;
    const observeOuter = (): void => {
      outerEvents += 1;
    };
    window.addEventListener("keydown", observeOuter);

    try {
      const event = keydown(view, key, options);
      expect(actions).toEqual([action]);
      expect(event.defaultPrevented).toBe(true);
      expect(outerEvents).toBe(0);
    } finally {
      window.removeEventListener("keydown", observeOuter);
    }
  });

  it("preserves unrelated and mismatched shortcuts for the outer listener", () => {
    const actions: string[] = [];
    const view = createView(actions);
    let outerEvents = 0;
    const observeOuter = (): void => {
      outerEvents += 1;
    };
    window.addEventListener("keydown", observeOuter);

    try {
      const unrelated = keydown(view, "p");
      const mismatched = keydown(view, "s", { altKey: true });

      expect(actions).toEqual([]);
      expect(unrelated.defaultPrevented).toBe(false);
      expect(mismatched.defaultPrevented).toBe(false);
      expect(outerEvents).toBe(2);
    } finally {
      window.removeEventListener("keydown", observeOuter);
    }
  });
});
