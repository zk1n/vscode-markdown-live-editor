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

type Posted = WebviewToHostMessage | EditorReadyMessage | WebviewPresentationMessage | RichRequest;
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
async function create(text: string): Promise<EditorView> {
  vi.stubGlobal("acquireVsCodeApi", () => ({
    postMessage: (message: Posted) => messages.push(message),
  }));
  document.body.innerHTML = `<main id="editor-root"></main><div id="editor-status" hidden></div><script id="markdown-live-editor-bootstrap" type="application/json">${JSON.stringify({ diagnosticMode: "off", documentUri: "file:///v02.md", documentVersion: 1, sessionId: "v02", nextSequence: 1, text })}</script>`;
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
function field(view: EditorView, name: string): HTMLInputElement {
  const input = view.dom.querySelector<HTMLInputElement>(`[data-find-replace=${name}]`);
  if (input === null) throw new Error(`missing ${name}`);
  return input;
}
function input(view: EditorView, name: string, value: string): void {
  const item = field(view, name);
  item.value = value;
  item.dispatchEvent(new InputEvent("input", { bubbles: true }));
}
afterEach(() => {
  window.dispatchEvent(new Event("unload"));
  document.body.replaceChildren();
  messages.length = 0;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("v0.2 through the actual webview controller", () => {
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
  it("replaces hidden image/table/link source once and routes Undo through the host", async () => {
    const text =
      "# heading\n\n| needle | b |\n| --- | --- |\n| needle | c |\n\n![needle](needle.png)\n[needle](needle.md)";
    const view = await create(text);
    command("replace");
    input(view, "search", "needle");
    input(view, "replace", "changed");
    view.dom.querySelector<HTMLButtonElement>("[data-find-replace=replace-all]")?.click();
    expect(view.state.doc.toString()).toBe(text.replaceAll("needle", "changed"));
    expect(edits()).toHaveLength(1);
    acknowledge(view.state.doc.toString(), 1, 2);
    field(view, "search").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
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
  it("keeps source unchanged during image reveal, empty-line selection and ordinary source search", async () => {
    const text = "# heading\n\n![alt](image.png)\n\nbody";
    const view = await create(text);
    view.dispatch({ selection: { anchor: text.length } });
    const reveal = view.dom.querySelector<HTMLButtonElement>(".cm-image-preview button");
    expect(reveal).not.toBeNull();
    reveal?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "![alt](image.png)",
    );
    view.dispatch({ selection: { anchor: 10 } });
    command("find");
    input(view, "search", "image.png");
    view.dom.querySelector<HTMLButtonElement>("[data-find-replace=next]")?.click();
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "image.png",
    );
    expect(view.state.doc.toString()).toBe(text);
    expect(edits()).toHaveLength(0);
  });
});
