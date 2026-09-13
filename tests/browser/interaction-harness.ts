import { EditorView } from "@codemirror/view";
import { applyWireChanges } from "../../src/core/sync/documentText.js";
import { PROTOCOL_VERSION, decodeWebviewToHostMessage } from "../../src/protocol/messages.js";

const initial =
  "before\n\n| **名前** | 説明 |\n| :--- | ---: |\n| 日本語 | escaped \\| `code` [link](hidden-target.md) |\n||  |\n\nafter needle\n\n![図](tests/fixtures/v02-review/assets/example.png)\n\nend needle";
let authority = initial;
let version = 1;
const past: string[] = [];
let future: string[] = [];
let hold = false;
let pending: (() => void) | undefined;
let currentView: EditorView | undefined;
function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error("harness DOM missing");
  return found;
}
const output = element("source-output");
const result = element("result");
function receive(message: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data: message }));
}
const identity = {
  protocolVersion: PROTOCOL_VERSION,
  documentUri: "file:///interaction.md",
  sessionId: "interaction",
};
const bootstrap = document.createElement("script");
bootstrap.id = "markdown-live-editor-bootstrap";
bootstrap.type = "application/json";
bootstrap.textContent = JSON.stringify({
  ...identity,
  documentVersion: 1,
  text: initial,
  diagnosticMode: "off",
  nextSequence: 1,
});
document.body.append(bootstrap);
Object.defineProperty(window, "acquireVsCodeApi", {
  value: () => ({
    postMessage: (message: Record<string, unknown>) => {
      queueMicrotask(() => {
        const base = {
          ...identity,
          controllerId: message["controllerId"],
          documentVersion: version,
        };
        if (message["kind"] === "editor-ready")
          receive({ ...base, kind: "controller-ready", nextSequence: 1, text: authority });
        if (message["kind"] === "edit") {
          const decoded = decodeWebviewToHostMessage(message);
          if (!decoded.ok || decoded.value.kind !== "edit") throw new Error("invalid edit");
          const applied = applyWireChanges(authority, decoded.value.changes);
          if (!applied.ok) throw new Error(applied.note);
          past.push(authority);
          future = [];
          authority = applied.text;
          version++;
          receive({
            ...base,
            kind: "operation-ack",
            sequence: message["sequence"],
            operation: "edit",
            documentVersion: version,
            text: authority,
          });
        }
        if (["save", "undo", "redo"].includes(String(message["kind"]))) {
          const action = message["kind"];
          if (action === "undo" && past.length) {
            future.push(authority);
            authority = past.pop() ?? authority;
            version++;
          }
          if (action === "redo" && future.length) {
            past.push(authority);
            authority = future.pop() ?? authority;
            version++;
          }
          receive({
            ...base,
            kind: "operation-ack",
            sequence: message["sequence"],
            operation: action,
            documentVersion: version,
            text: authority,
          });
        }
        if (message["kind"] === "rich-request") {
          const reply = (): void => {
            receive({
              ...base,
              kind: "rich-response",
              requestId: message["requestId"],
              ok: true,
              ...(message["operation"] === "image-resolve"
                ? { url: "/tests/fixtures/v02-review/assets/example.png" }
                : { markdown: "![貼付](tests/fixtures/v02-review/assets/example.png)" }),
            });
          };
          if (hold && message["operation"] === "image-import") pending = reply;
          else reply();
        }
        const view = currentView;
        if (view) {
          output.textContent = view.state.doc.toString();
          result.textContent = `ready | focus=${String(view.hasFocus)} | selection=${String(view.state.selection.main.from)}..${String(view.state.selection.main.to)}`;
        }
      });
    },
  }),
});

async function start(): Promise<void> {
  await import("../../src/webview/editor.js");
  const content = document.querySelector<HTMLElement>(".cm-content");
  const editor = content && EditorView.findFromDOM(content);
  if (!editor) throw new Error("editor missing");
  const view = editor;
  currentView = view;
  document.getElementById("reset")?.addEventListener("click", () => {
    window.location.reload();
  });
  document.getElementById("narrow")?.addEventListener("click", () => {
    const root = document.getElementById("editor-root");
    if (root) root.style.width = root.style.width === "380px" ? "900px" : "380px";
    view.requestMeasure();
  });
  document.getElementById("outside")?.addEventListener("click", () => {
    result.textContent = "別UIへ移動";
  });
  document.getElementById("defer-image")?.addEventListener("click", () => {
    hold = !hold;
    result.textContent = `image response hold=${String(hold)}`;
  });
  document.getElementById("release-image")?.addEventListener("click", () => {
    pending?.();
    pending = undefined;
  });
  document.getElementById("paste-image")?.addEventListener("click", () => {
    view.focus();
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "image.png", {
        type: "image/png",
      }),
    );
    view.contentDOM.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  output.textContent = initial;
  result.textContent = "ready";
}
void start();
