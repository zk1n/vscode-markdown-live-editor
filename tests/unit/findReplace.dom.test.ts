// @vitest-environment happy-dom

import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { createFindReplace } from "../../src/webview/search/findReplace.js";

const views: EditorView[] = [];

afterEach((): void => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
});

function createView(
  text: string,
  options: { readonly editable?: () => boolean; readonly extensions?: readonly Extension[] } = {},
): { readonly view: EditorView; readonly findReplace: ReturnType<typeof createFindReplace> } {
  const parent = document.createElement("div");
  document.body.append(parent);
  const findReplace = createFindReplace({ isEditable: options.editable ?? (() => true) });
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [findReplace.extension, ...(options.extensions ?? [])],
    }),
    parent,
  });
  views.push(view);
  return { view, findReplace };
}

function panel(view: EditorView): HTMLElement {
  const result = view.dom.querySelector<HTMLElement>(".cm-find-replace");
  if (result === null) {
    throw new Error("Find / Replace panel was not opened.");
  }
  return result;
}

function field(view: EditorView, name: string): HTMLInputElement {
  const result = panel(view).querySelector<HTMLInputElement>(`[data-find-replace=${name}]`);
  if (result === null) {
    throw new Error(`Missing ${name} field.`);
  }
  return result;
}

function button(view: EditorView, name: string): HTMLButtonElement {
  const result = panel(view).querySelector<HTMLButtonElement>(`[data-find-replace=${name}]`);
  if (result === null) {
    throw new Error(`Missing ${name} button.`);
  }
  return result;
}

function setInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function toggle(input: HTMLInputElement): void {
  input.checked = !input.checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Find / Replace", () => {
  it("searches complete source, including a match outside the rendered viewport", () => {
    const source = `first needle\n${"spacer\n".repeat(400)}final needle`;
    const { view, findReplace } = createView(source);

    findReplace.open(view);
    setInput(field(view, "search"), "needle");

    expect(panel(view).querySelector("[data-find-replace=count]")?.textContent).toBe("0 / 2");
    button(view, "next").click();
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "needle",
    );
    button(view, "next").click();
    expect(view.state.selection.main.from).toBe(source.lastIndexOf("needle"));
  });

  it("reports case, word, and invalid-regexp query states", () => {
    const { view, findReplace } = createView("Needle needle needles");
    findReplace.open(view);
    setInput(field(view, "search"), "needle");

    expect(panel(view).querySelector("[data-find-replace=count]")?.textContent).toBe("0 / 3");
    toggle(field(view, "case"));
    expect(panel(view).querySelector("[data-find-replace=count]")?.textContent).toBe("0 / 2");
    toggle(field(view, "word"));
    expect(panel(view).querySelector("[data-find-replace=count]")?.textContent).toBe("0 / 1");
    toggle(field(view, "regexp"));
    setInput(field(view, "search"), "[");

    expect(panel(view).querySelector("[data-find-replace=status]")?.textContent).toBe(
      "無効な正規表現",
    );
    expect(button(view, "replace-all").disabled).toBe(true);
  });

  it("replaces every scoped source match with one document transaction", () => {
    const source = "outside needle\ninside needle\ninside needle\noutside needle";
    const { view, findReplace } = createView(source);
    const scopeFrom = source.indexOf("inside");
    const scopeTo = source.lastIndexOf("inside needle") + "inside needle".length;
    view.dispatch({ selection: { anchor: scopeFrom, head: scopeTo } });
    findReplace.open(view, true);
    toggle(field(view, "selection"));
    setInput(field(view, "search"), "needle");
    setInput(field(view, "replace"), "match");

    const documentTransactions: number[] = [];
    const listener = EditorView.updateListener.of((update): void => {
      if (update.docChanged) {
        documentTransactions.push(
          update.transactions.filter((transaction) => transaction.docChanged).length,
        );
      }
    });
    view.dispatch({ effects: StateEffect.appendConfig.of(listener) });
    button(view, "replace-all").click();

    expect(view.state.doc.toString()).toBe(
      "outside needle\ninside match\ninside match\noutside needle",
    );
    expect(documentTransactions).toEqual([1]);
  });

  it("maps a frozen selection scope through edits before finding", () => {
    const source = "needle outside\nneedle inside\nneedle outside";
    const { view, findReplace } = createView(source);
    const scopeFrom = source.indexOf("needle inside");
    const scopeTo = scopeFrom + "needle inside".length;
    view.dispatch({ selection: { anchor: scopeFrom, head: scopeTo } });
    findReplace.open(view);
    toggle(field(view, "selection"));
    setInput(field(view, "search"), "needle");
    view.dispatch({ changes: { from: 0, insert: "prefix\n" } });

    button(view, "next").click();
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "needle",
    );
    expect(view.state.selection.main.from).toBe(scopeFrom + "prefix\n".length);
  });

  it("opens replacement mode from Ctrl+H and returns focus on Escape without bubbling panel Undo", () => {
    const { view } = createView("needle");
    view.focus();
    const openEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyH",
      ctrlKey: true,
      key: "h",
    });
    Object.defineProperty(openEvent, "keyCode", { value: "H".charCodeAt(0) });
    view.contentDOM.dispatchEvent(openEvent);

    expect(
      panel(view).querySelector("[data-find-replace=replace-row]")?.hasAttribute("hidden"),
    ).toBe(false);
    let bubbled = 0;
    const observe = (): void => {
      bubbled += 1;
    };
    window.addEventListener("keydown", observe);
    try {
      const undo = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "z",
      });
      field(view, "replace").dispatchEvent(undo);
      expect(bubbled).toBe(0);
      expect(view.state.doc.toString()).toBe("needle");

      field(view, "replace").dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
      );
      expect(view.dom.querySelector(".cm-find-replace")).toBeNull();
      expect(document.activeElement).toBe(view.contentDOM);
    } finally {
      window.removeEventListener("keydown", observe);
    }
  });
});
