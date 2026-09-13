import { EditorView } from "@codemirror/view";

declare function acquireVsCodeApi(): {
  postMessage(value: unknown): void;
  getState(): unknown;
  setState(value: unknown): void;
};
const api = acquireVsCodeApi();
let identity: object = {};
Object.defineProperty(window, "acquireVsCodeApi", {
  value: () => ({
    getState: () => api.getState(),
    setState: (value: unknown) => {
      api.setState(value);
    },
    postMessage: (value: unknown) => {
      if (value && typeof value === "object" && "kind" in value && value.kind === "editor-ready")
        identity = value;
      api.postMessage(value);
    },
  }),
});
function report(event: string, result: unknown): void {
  const json = JSON.stringify(result);
  const details = Object.fromEntries(
    Array.from({ length: Math.ceil(json.length / 150) }, (_, index) => [
      String(index).padStart(2, "0"),
      json.slice(index * 150, (index + 1) * 150),
    ]),
  );
  api.postMessage({ ...identity, kind: "diagnostic", event, details });
}
let acknowledgements = 0;
const received: string[] = [];
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (message && typeof message === "object" && "kind" in message)
    received.push(String(message.kind));
  if (
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "operation-ack"
  )
    acknowledgements++;
});
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function stage(name: string): void {
  report("interaction-stage", { name, acknowledgements });
}
async function wait(check: () => boolean, message: string): Promise<void> {
  const end = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > end)
      throw new Error(
        message +
          ": " +
          String(document.querySelector(".cm-floating-search [role=status]")?.textContent),
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
function press(element: HTMLElement, key: string, ctrlKey = false, shiftKey = false): void {
  element.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      ctrlKey,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}
function paste(view: EditorView, text: string): void {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  view.contentDOM.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
  );
}
async function run(): Promise<void> {
  await import("../../src/webview/editor.js");
  const content = document.querySelector<HTMLElement>(".cm-content");
  const view = content && EditorView.findFromDOM(content);
  check(view, "editor missing");
  await wait(() => view.contentDOM.contentEditable === "true", "controller not ready");
  view.focus();
  const rows = view.contentDOM.querySelectorAll(".cm-table-row");
  const cell = rows[2]?.querySelector<HTMLElement>("[data-table-cell]");
  check(cell, "empty cell missing");
  const rect = cell.getBoundingClientRect();
  cell.dispatchEvent(
    new MouseEvent("mousedown", {
      button: 0,
      clientX: rect.left + 10,
      clientY: rect.top + 10,
      bubbles: true,
      cancelable: true,
    }),
  );
  cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await Promise.resolve();
  paste(view, "CELL");
  check(
    view.hasFocus && view.state.doc.toString().includes("|CELL|"),
    "empty click/paste route failed",
  );
  press(view.contentDOM, "Tab");
  paste(view, "SECOND");
  press(view.contentDOM, "Tab");
  paste(view, "NEWROW");
  check(view.state.doc.toString().includes("| NEWROW |  |"), "last Tab/new-row input failed");
  for (const action of ["column-append", "row-append"]) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          resolve();
        }),
      ),
    );
    const button = view.dom.querySelector<HTMLButtonElement>(`[data-table-add="${action}"]`);
    check(button, "plus missing");
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    button.click();
    paste(view, action === "column-append" ? "COLUMN" : "ROW");
    check(view.hasFocus, "plus lost focus");
  }
  const tableSource = view.state.doc.toString();
  stage("table complete");
  press(view.contentDOM, "h", true);
  const query = view.dom.querySelector<HTMLInputElement>("[data-search-input=query]");
  const replacement = view.dom.querySelector<HTMLInputElement>("[data-search-input=replacement]");
  check(query && replacement, "Ctrl+H did not open floating UI");
  query.value = "needle";
  query.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await wait(
    () => /^[1-3] \/ 3$/.test(view.dom.querySelector('[role="status"]')?.textContent ?? ""),
    "worker did not find full-source matches",
  );
  replacement.focus();
  replacement.value = "FOUND";
  replacement.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await wait(
    () => /^[1-3] \/ 3$/.test(view.dom.querySelector('[role="status"]')?.textContent ?? ""),
    "replacement query not ready",
  );
  const all = view.dom.querySelector<HTMLButtonElement>(
    'button[aria-label="すべて置換"],button[aria-label="Replace all"]',
  );
  check(all, "replace all missing");
  all.focus();
  all.click();
  await wait(
    () => view.state.doc.toString() === tableSource.replaceAll("needle", "FOUND"),
    "replace all did not apply",
  );
  press(all, "Escape");
  check(view.hasFocus, "search Escape lost focus");
  let ack = acknowledgements;
  press(view.contentDOM, "s", true);
  await wait(
    () => acknowledgements > ack && view.contentDOM.contentEditable === "true",
    "Save did not finish",
  );
  stage("saved before undo");
  const replaced = view.state.doc.toString();
  ack = acknowledgements;
  press(view.contentDOM, "z", true);
  await wait(
    () => view.state.doc.toString() === tableSource && acknowledgements > ack,
    "replace all was not one Undo",
  );
  stage("undo complete");
  ack = acknowledgements;
  press(view.contentDOM, "y", true);
  await wait(
    () => view.state.doc.toString() === replaced && acknowledgements > ack,
    "replace all Redo failed",
  );
  stage("redo complete");
  paste(view, "AFTERSEARCH");
  check(
    view.state.doc.toString().includes("AFTERSEARCH"),
    "Escape/Undo/Redo immediate input missing",
  );
  // Synthetic keyboard events cannot perform the browser default Ctrl+End.
  // Establish the image-test insertion site, then use the real Paste handler.
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  paste(view, "\n");
  const image = new DataTransfer();
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    ),
    (char) => char.charCodeAt(0),
  );
  image.items.add(new File([bytes], "interaction.png", { type: "image/png" }));
  view.contentDOM.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: image, bubbles: true, cancelable: true }),
  );
  await wait(() => view.state.doc.toString().includes("attachments/"), "Host image import failed");
  check(view.hasFocus, "image import lost focus");
  paste(view, "AFTERIMAGE");
  check(
    view.state.doc.toString().includes(")\nAFTERIMAGE"),
    "image immediate input not on text line: " + view.state.doc.toString().slice(-220),
  );
  ack = acknowledgements;
  press(view.contentDOM, "s", true);
  await wait(() => acknowledgements > ack, "final Save did not finish");
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => {
      resolve();
    }),
  );
  const caret = view.coordsAtPos(view.state.selection.main.head);
  check(caret && caret.bottom > caret.top, "caret has no visible height");
  report("interaction-result", {
    ok: true,
    text: view.state.doc.toString(),
    focused: view.hasFocus,
    caret,
    rows: view.dom.querySelectorAll(".cm-table-row").length,
  });
}
void run().catch((error: unknown) => {
  report("interaction-result", {
    ok: false,
    error: String(error),
    received,
    editable: document.querySelector(".cm-content")?.getAttribute("contenteditable"),
    status: document.getElementById("editor-status")?.textContent,
  });
});
