// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type EditorReadyMessage,
  type WebviewToHostMessage,
} from "../../src/protocol/messages.js";
import type { WebviewPresentationMessage } from "../../src/protocol/presentationMessages.js";
import type { RichCommand, RichRequest } from "../../src/protocol/richMessages.js";
import type { NativeSearchRequest } from "../../src/protocol/nativeSearchMessages.js";

type Posted =
  | WebviewToHostMessage
  | EditorReadyMessage
  | WebviewPresentationMessage
  | RichRequest
  | NativeSearchRequest;
const messages: Posted[] = [];
let identity: {
  protocolVersion: typeof PROTOCOL_VERSION;
  documentUri: string;
  sessionId: string;
  controllerId: string;
};
function receive(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}
async function create(text: string, canEdit = true): Promise<EditorView> {
  vi.stubGlobal("acquireVsCodeApi", () => ({
    postMessage: (message: Posted) => messages.push(message),
  }));
  document.body.innerHTML = `<main id="editor-root"></main><div id="editor-status" hidden></div><script id="markdown-live-editor-bootstrap" type="application/json">${JSON.stringify({ diagnosticMode: "off", documentUri: "file:///v02.md", documentVersion: 1, sessionId: "v02", nextSequence: 1, text, canEdit })}</script>`;
  await import("../../src/webview/editor.js");
  const ready = messages.find((message) => message.kind === "editor-ready");
  if (ready?.kind !== "editor-ready") throw new Error("controller missing");
  identity = {
    protocolVersion: PROTOCOL_VERSION,
    documentUri: ready.documentUri,
    sessionId: ready.sessionId,
    controllerId: ready.controllerId,
  };
  receive({ ...identity, kind: "controller-ready", documentVersion: 1, nextSequence: 1, text });
  const content = document.querySelector<HTMLElement>(".cm-content");
  const view = content === null ? null : EditorView.findFromDOM(content);
  if (view === null) throw new Error("view missing");
  return view;
}
function command(command: RichCommand): void {
  receive({ ...identity, kind: "rich-command", command });
}
function press(view: EditorView, key: string, extras: KeyboardEventInit = {}): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      ...extras,
    }),
  );
}
function acknowledge(
  text: string,
  sequence: number,
  documentVersion: number,
  operation = "edit",
): void {
  receive({
    kind: "operation-ack",
    documentUri: identity.documentUri,
    text,
    sequence,
    documentVersion,
    operation,
  });
}
function edits(): readonly Extract<Posted, { kind: "edit" }>[] {
  return messages.filter((message) => message.kind === "edit");
}
function request(operation: RichRequest["operation"]): RichRequest | undefined {
  return messages.find(
    (message): message is RichRequest =>
      message.kind === "rich-request" && message.operation === operation,
  );
}
afterEach(() => {
  window.dispatchEvent(new Event("unload"));
  document.body.replaceChildren();
  messages.length = 0;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("v0.2 through the actual webview controller", () => {
  it("refreshes image and table source positions after composition without recreating the image", async () => {
    const text = "before\n\n| h | b |\n| --- | --- |\n| c | d |\n\n![alt](image.png)\n\nafter";
    const view = await create(text);
    const image = view.dom.querySelector(".cm-image-preview img");
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch({ changes: { from: 0, insert: "日本語" }, userEvent: "input.type.compose" });
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();
    expect(view.dom.querySelector(".cm-image-preview img")).toBe(image);
    expect(view.dom.querySelector<HTMLElement>(".cm-image-preview")?.dataset["imageFrom"]).toBe(
      String(text.indexOf("![alt]") + 3),
    );
    expect(view.dom.querySelector<HTMLElement>(".cm-table-cell")?.dataset["tableCell"]).toBe(
      String(text.indexOf("h |") + 3),
    );
  });
  it("waits for controller activation before resolving a cold image", async () => {
    await create("before\n![cold](assets/cold.png)\n\nafter");
    const readyIndex = messages.findIndex((message) => message.kind === "editor-ready");
    const resolveIndex = messages.findIndex(
      (message) => message.kind === "rich-request" && message.operation === "image-resolve",
    );
    expect(resolveIndex).toBeGreaterThan(readyIndex);
  });
  it("allows native Find for a readonly source while refusing text and attachment edits", async () => {
    const view = await create("readonly", false);
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.contentEditable).toBe("false");
    command("insert-table");
    command("insert-image");
    view.dispatch({ changes: { from: 0, insert: "bad" } });
    expect(view.state.doc.toString()).toBe("readonly");
    expect(edits()).toHaveLength(0);
    expect(request("image-pick")).toBeUndefined();
    command("find");
    await Promise.resolve();
    expect(messages.find((message) => message.kind === "native-search")).toMatchObject({
      mode: "find",
    });
  });
  it("uses heading Enter before the default Markdown keymap and saves exactly that source", async () => {
    const view = await create("# 見出し");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    press(view, "Enter");
    expect(view.state.doc.toString()).toBe("# 見出し\n\n");
    expect(edits()).toHaveLength(1);
    press(view, "s", { ctrlKey: true });
    expect(messages.some((message) => message.kind === "save")).toBe(false);
    acknowledge(view.state.doc.toString(), 1, 2);
    expect(messages.filter((message) => message.kind === "save")).toHaveLength(1);
    acknowledge(view.state.doc.toString(), 2, 2, "save");
    expect(view.state.doc.toString()).toBe("# 見出し\n\n");
  });
  it("does not insert a paragraph for an IME confirmation Enter", async () => {
    const view = await create("# 見出し");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    press(view, "Enter", { isComposing: true });
    expect(view.state.doc.toString()).toBe("# 見出し");
    expect(edits()).toHaveLength(0);
    command("insert-table");
    command("insert-image");
    expect(edits()).toHaveLength(0);
    expect(request("image-pick")).toBeUndefined();
  });
  it("adds the heading separator to the final composition target before queued Save", async () => {
    const view = await create("見出し\n本文");
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch({ changes: { from: 0, insert: "## " }, userEvent: "input.type.compose" });
    expect(view.state.doc.toString()).toBe("## 見出し\n本文");
    expect(edits()).toHaveLength(0);
    press(view, "s", { ctrlKey: true });
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("## 見出し\n\n本文");
    expect(edits()).toHaveLength(1);
    expect(view.dom.querySelectorAll(".cm-structural-gap")).toHaveLength(1);
    acknowledge(view.state.doc.toString(), 1, 2);
    expect(messages.filter((message) => message.kind === "save")).toHaveLength(1);
  });
  it("hands the acknowledged whole document to native Replace and restores its selection", async () => {
    const text =
      "# heading\n\n| needle | b |\n| --- | --- |\n| needle | c |\n\n![needle](needle.png)\n[needle](needle.md)";
    const view = await create(text);
    view.dispatch({
      changes: { from: text.length, insert: "!" },
      selection: { anchor: text.length + 1 },
    });
    command("replace");
    await Promise.resolve();
    expect(messages.some((message) => message.kind === "native-search")).toBe(false);
    acknowledge(`${text}!`, 1, 2);
    await Promise.resolve();
    await Promise.resolve();
    expect(messages.find((message) => message.kind === "native-search")).toMatchObject({
      ...identity,
      kind: "native-search",
      mode: "replace",
      documentVersion: 2,
      anchor: text.length + 1,
    });
    expect(view.dom.querySelector("[data-find-replace]")).toBeNull();
    view.dispatch({ changes: { from: 0, insert: "blocked" } });
    expect(view.state.doc.toString()).toBe(`${text}!`);
    receive({ ...identity, kind: "native-search-return", documentVersion: 2, anchor: 2, head: 7 });
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(7);
    press(view, "z", { ctrlKey: true });
    expect(messages.filter((message) => message.kind === "undo")).toHaveLength(1);
    acknowledge(text, 2, 3, "undo");
    expect(view.state.doc.toString()).toBe(text);
  });
  it("waits for prior edits before picking an image, then inserts one acknowledged result", async () => {
    const view = await create("text");
    view.dispatch({ changes: { from: 4, insert: "!" }, selection: { anchor: 5 } });
    command("insert-image");
    await Promise.resolve();
    expect(request("image-pick")).toBeUndefined();
    acknowledge("text!", 1, 2);
    await Promise.resolve();
    await Promise.resolve();
    const pick = request("image-pick");
    expect(pick?.documentVersion).toBe(2);
    receive({
      ...pick,
      kind: "rich-response",
      ok: true,
      markdown: "![image](attachments/image.png)",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("text!![image](attachments/image.png)");
    expect(edits()).toHaveLength(2);
  });
  it("cancels a late image insertion after selection-only movement", async () => {
    const view = await create("before after");
    view.dispatch({ selection: { anchor: 0, head: 6 } });
    command("insert-image");
    await Promise.resolve();
    await Promise.resolve();
    const pick = request("image-pick");
    expect(pick).toBeDefined();
    view.dispatch({ selection: { anchor: 12 } });
    receive({
      ...pick,
      kind: "rich-response",
      ok: true,
      markdown: "![image](attachments/image.png)",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("before after");
    expect(edits()).toHaveLength(0);
  });
  it("cancels a late image insertion after edits and rejects a response for a foreign controller", async () => {
    const view = await create("text");
    command("insert-image");
    await Promise.resolve();
    await Promise.resolve();
    const pick = request("image-pick");
    expect(pick).toBeDefined();
    receive({ ...pick, controllerId: "foreign", kind: "rich-response", ok: true, markdown: "bad" });
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("text");
    view.dispatch({ changes: { from: 4, insert: "!" } });
    receive({
      ...pick,
      kind: "rich-response",
      ok: true,
      markdown: "![image](attachments/image.png)",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("text!");
    expect(document.querySelector(".markdown-rich-notice")?.textContent).toContain(
      "挿入を取り消しました",
    );
  });
  it("keeps source unchanged during image reveal, structural selection and native Find", async () => {
    const text = "# heading\n\n![alt](image.png)\n\nbody";
    const view = await create(text);
    view.dispatch({ selection: { anchor: text.length } });
    expect(view.dom.querySelector(".cm-image-preview button")).toBeNull();
    const reveal = view.dom.querySelector<HTMLImageElement>(".cm-image-preview img");
    expect(reveal).not.toBeNull();
    reveal?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "![alt](image.png)",
    );
    await Promise.resolve();
    view.dispatch({ selection: { anchor: 10 } });
    command("find");
    await Promise.resolve();
    await Promise.resolve();
    expect(messages.find((message) => message.kind === "native-search")).toMatchObject({
      mode: "find",
      anchor: 9,
      head: 9,
    });
    expect(view.state.doc.toString()).toBe(text);
    expect(edits()).toHaveLength(0);
  });
});
