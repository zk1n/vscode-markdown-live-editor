// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import {
  createContextActions,
  type ContextActionIdentity,
} from "../../src/webview/contextActions.js";
import { tableEditing } from "../../src/webview/livePreview/tableEditing.js";

const views: EditorView[] = [];

afterEach((): void => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function createView(
  text: string,
  selection: number,
): {
  readonly view: EditorView;
  readonly contexts: ReturnType<typeof createContextActions>;
  readonly identity: ContextActionIdentity;
} {
  const identity: ContextActionIdentity = {
    protocolVersion: 2,
    documentUri: "file:///source.md",
    sessionId: "session",
    controllerId: "controller",
    documentVersion: 4,
  };
  const contexts = createContextActions({
    identity: (): ContextActionIdentity => identity,
    isEditable: (): boolean => true,
  });
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: { anchor: selection },
      extensions: [tableEditing((): boolean => true), contexts.extension],
    }),
    parent,
  });
  views.push(view);
  return { view, contexts, identity };
}

function contextMenu(target: EventTarget, clientX = 20, clientY = 20): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  target.dispatchEvent(event);
  return event;
}

function context(element: HTMLElement): Readonly<Record<string, unknown>> {
  const value = element.dataset["vscodeContext"];
  if (value === undefined) throw new Error("Expected a native webview context.");
  return JSON.parse(value) as Readonly<Record<string, unknown>>;
}

describe("native webview context actions", () => {
  it("fixes a right-clicked table cell without moving another caret, and acts on that row", () => {
    const source = "| h1 | h2 |\n| --- | --- |\n| first | one |\n| second | two |";
    const { view, contexts, identity } = createView(source, source.indexOf("first"));
    const second = view.contentDOM.querySelector<HTMLElement>(
      `[data-table-cell="${String(source.indexOf("second"))}"]`,
    );
    if (second === null) throw new Error("Expected rendered second table cell.");

    const before = view.state.selection.main.head;
    const event = contextMenu(second);
    const captured = context(second);
    const token = captured["markdownContextToken"];

    expect(event.defaultPrevented).toBe(false);
    expect(view.state.selection.main.head).toBe(before);
    expect(captured).toMatchObject({
      webviewSection: "markdown-table",
      markdownDocumentUri: identity.documentUri,
      markdownSessionId: identity.sessionId,
      markdownControllerId: identity.controllerId,
      markdownDocumentVersion: identity.documentVersion,
      markdownContextEditable: true,
      markdownCanDeleteRow: true,
      markdownCanDeleteColumn: true,
    });
    if (typeof token !== "string") throw new Error("Expected a context token.");
    expect(contexts.run("table-row-delete", token, identity.documentVersion)).toBe(true);
    expect(view.state.doc.toString()).toContain("| first | one |");
    expect(view.state.doc.toString()).not.toContain("| second | two |");
  });

  it("sets disabled-operation metadata, supports keyboard context at the caret, and leaves prose menus native", () => {
    const source = "before\n| h1 | h2 |\n| --- | --- |\n| value | other |\n\nafter";
    const { view, contexts, identity } = createView(source, source.indexOf("h1"));
    const header = view.contentDOM.querySelector<HTMLElement>(
      `[data-table-cell="${String(source.indexOf("h1"))}"]`,
    );
    if (header === null) throw new Error("Expected rendered table header.");

    contextMenu(header);
    expect(context(header)).toMatchObject({
      markdownCanDeleteRow: false,
      markdownCanDeleteColumn: true,
    });

    const keyboard = contextMenu(view.contentDOM, 0, 0);
    const keyboardContext = context(view.contentDOM);
    const token = keyboardContext["markdownContextToken"];
    expect(keyboard.defaultPrevented).toBe(false);
    if (typeof token !== "string") throw new Error("Expected keyboard context token.");
    expect(contexts.run("table-align-center", token, identity.documentVersion)).toBe(true);
    expect(view.state.doc.toString()).toContain("| :---: | --- |");

    const prose = view.contentDOM.querySelector<HTMLElement>(".cm-line");
    if (prose === null) throw new Error("Expected editor prose.");
    const regular = contextMenu(prose);
    expect(regular.defaultPrevented).toBe(false);
    expect(prose.dataset["vscodeContext"]).toBeUndefined();
  });

  it("protects the only data row in both metadata and the runtime command guard", () => {
    const source = "| h1 | h2 |\n| --- | --- |\n| value | other |";
    const { view, contexts, identity } = createView(source, source.indexOf("value"));
    const cell = view.contentDOM.querySelector<HTMLElement>(
      `[data-table-cell="${String(source.indexOf("value"))}"]`,
    );
    if (cell === null) throw new Error("Expected rendered data cell.");
    contextMenu(cell);
    const captured = context(cell);
    expect(captured["markdownCanDeleteRow"]).toBe(false);
    const token = captured["markdownContextToken"];
    if (typeof token !== "string") throw new Error("Expected a context token.");
    expect(contexts.run("table-row-delete", token, identity.documentVersion)).toBe(false);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("leaves malformed raw table source unchanged while returning to live presentation", () => {
    const source = "| h | x |\n| --- | --- |\n| value | other |";
    const { view, contexts } = createView(source, source.indexOf("value"));
    expect(contexts.run("table-source")).toBe(true);
    const malformed = "| h | x |\nnot a delimiter\n| value | other |";
    const delimiterLine = view.state.doc.line(2);
    view.dispatch({
      changes: { from: delimiterLine.from, to: delimiterLine.to, insert: "not a delimiter" },
    });
    expect(contexts.run("table-source")).toBe(true);
    expect(view.state.doc.toString()).toBe(malformed);
    expect(view.contentDOM.querySelector(".cm-table-cell")).toBeNull();
  });

  it("keeps a raw-table Source exit in the context menu after the delimiter is broken", () => {
    const source = "| h | x |\n| --- | --- |\n| value | other |";
    const { view, contexts, identity } = createView(source, source.indexOf("value"));
    expect(contexts.run("table-source")).toBe(true);
    const delimiterLine = view.state.doc.line(2);
    view.dispatch({
      changes: { from: delimiterLine.from, to: delimiterLine.to, insert: "not a delimiter" },
    });
    const line = view.contentDOM.querySelector<HTMLElement>(".cm-line");
    if (line === null) throw new Error("Expected raw source line.");
    contextMenu(line);
    const captured = context(view.contentDOM);
    expect(captured).toMatchObject({
      webviewSection: "markdown-table",
      markdownContextEditable: true,
    });
    const token = captured["markdownContextToken"];
    if (typeof token !== "string") throw new Error("Expected a context token.");
    expect(contexts.run("table-source", token, identity.documentVersion)).toBe(true);
    expect(view.state.doc.toString()).toBe("| h | x |\nnot a delimiter\n| value | other |");
  });

  it("revalidates tokens against document changes and reveals an image source without modifying it", () => {
    const source = "| h |\n| --- |\n| value |\n\n![alt](assets/image.png)";
    const { view, contexts, identity } = createView(source, source.indexOf("value"));
    const cell = view.contentDOM.querySelector<HTMLElement>(
      `[data-table-cell="${String(source.indexOf("value"))}"]`,
    );
    if (cell === null) throw new Error("Expected rendered table cell.");
    contextMenu(cell);
    const token = context(cell)["markdownContextToken"];
    if (typeof token !== "string") throw new Error("Expected a context token.");
    view.dispatch({ changes: { from: 0, insert: "changed\n" } });
    expect(contexts.run("table-column-delete", token, identity.documentVersion)).toBe(false);

    const image = document.createElement("span");
    image.className = "cm-image-preview";
    image.dataset["imageFrom"] = String(view.state.doc.toString().indexOf("![alt]"));
    image.dataset["imageTo"] = String(view.state.doc.length);
    image.dataset["imageTarget"] = "assets/image.png";
    view.dom.append(image);
    contextMenu(image);
    const imageToken = context(image)["markdownContextToken"];
    if (typeof imageToken !== "string") throw new Error("Expected an image context token.");
    const before = view.state.doc.toString();
    expect(contexts.run("image-source", imageToken, identity.documentVersion)).toBe(true);
    expect(view.state.doc.toString()).toBe(before);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "![alt](assets/image.png)",
    );
  });
});
