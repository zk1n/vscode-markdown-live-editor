import { EditorView } from "@codemirror/view";
import { findTables } from "../../src/core/markdown/tableSource.js";

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
function pointer(
  type: string,
  button: HTMLButtonElement,
  options: {
    readonly button: number;
    readonly buttons: number;
    readonly x: number;
    readonly y: number;
  },
): void {
  button.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 41,
      pointerType: "mouse",
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      button: options.button,
      buttons: options.buttons,
      clientX: options.x,
      clientY: options.y,
    }),
  );
}
function textPosition(
  view: EditorView,
  value: string,
  expectedFrom: number,
): { readonly node: Text; readonly offset: number } | undefined {
  const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let offset = node.textContent?.indexOf(value) ?? -1;
    while (offset >= 0) {
      if (view.posAtDOM(node, offset) === expectedFrom) return { node: node as Text, offset };
      offset = node.textContent?.indexOf(value, offset + 1) ?? -1;
    }
  }
  return undefined;
}
function visibleParagraphAfterTable(
  view: EditorView,
  table: { readonly to: number },
): { readonly from: number; readonly text: string; readonly node: Text; readonly offset: number } {
  const document = view.state.doc;
  for (let number = document.lineAt(table.to).number + 1; number <= document.lines; number++) {
    const line = document.line(number);
    if (!line.text.trim()) continue;
    const position = textPosition(view, line.text, line.from);
    if (position) return { from: line.from, text: line.text, ...position };
  }
  throw new Error("no visible source paragraph after first table");
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
  for (const action of ["column-append", "row-append"] as const) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          resolve();
        }),
      ),
    );
    const button = view.dom.querySelector<HTMLButtonElement>(`[data-table-add="${action}"]`);
    check(button, "plus missing");
    const bounds = button.getBoundingClientRect();
    const point = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    const before = view.state.doc.toString();
    const beforeTable = findTables(before)[0];
    check(beforeTable, "table source missing before append");
    const beforeColumns = beforeTable.rows[0]?.cells.length;
    check(beforeColumns !== undefined, "table has no columns before append");

    // Synthetic DOM evidence only: the control must reject a context click and a dragged release.
    pointer("pointerdown", button, { button: 2, buttons: 2, ...point });
    pointer("pointerup", button, { button: 2, buttons: 0, ...point });
    check(view.state.doc.toString() === before, "right-click changed source");
    pointer("pointerdown", button, { button: 0, buttons: 1, ...point });
    pointer("pointermove", button, { button: 0, buttons: 1, x: point.x + 8, y: point.y + 8 });
    pointer("pointerup", button, { button: 0, buttons: 0, ...point });
    button.dispatchEvent(
      new MouseEvent("click", { button: 0, detail: 1, bubbles: true, cancelable: true, ...point }),
    );
    check(view.state.doc.toString() === before, "dragged table control changed source");

    pointer("pointerdown", button, { button: 0, buttons: 1, ...point });
    check(view.state.doc.toString() === before, "pointerdown changed source");
    pointer("pointerup", button, { button: 0, buttons: 0, ...point });
    button.dispatchEvent(
      new MouseEvent("click", { button: 0, detail: 1, bubbles: true, cancelable: true, ...point }),
    );
    await wait(() => {
      const after = findTables(view.state.doc.toString())[0];
      return action === "column-append"
        ? after?.rows.every((row) => row.cells.length === beforeColumns + 1) === true
        : after?.rows.length === beforeTable.rows.length + 1;
    }, `${action} did not append expected source shape`);
    check(view.hasFocus, "plus lost focus");
  }
  const tableSource = view.state.doc.toString();
  const firstTable = findTables(tableSource)[0];
  check(firstTable, "first table missing after table actions");
  const visibleAfter = visibleParagraphAfterTable(view, firstTable);
  const range = document.createRange();
  range.setStart(visibleAfter.node, visibleAfter.offset);
  range.setEnd(visibleAfter.node, visibleAfter.offset + visibleAfter.text.length);
  const rangeBounds = range.getBoundingClientRect();
  const sourcePosition = view.posAtDOM(visibleAfter.node, visibleAfter.offset);
  const lineBlock = view.lineBlockAt(visibleAfter.from);
  const sourceCaret = view.coordsAtPos(visibleAfter.from);
  check(
    sourcePosition === visibleAfter.from,
    "visible paragraph maps to the wrong source position",
  );
  check(
    lineBlock.from <= visibleAfter.from && lineBlock.to >= visibleAfter.from,
    "line block misses paragraph",
  );
  check(
    rangeBounds.height > 0 && sourceCaret && sourceCaret.bottom > sourceCaret.top,
    "post-table paragraph has no measurable range/caret",
  );
  stage("table complete");

  press(view.contentDOM, "f", true);
  const searchQuery = view.dom.querySelector<HTMLInputElement>("[data-search-input=query]");
  check(searchQuery, "Ctrl+F did not open floating UI");
  const latestCell = view.contentDOM.querySelector<HTMLElement>("[data-table-cell]");
  check(latestCell, "table cell missing for search Escape");
  const latestBounds = latestCell.getBoundingClientRect();
  latestCell.dispatchEvent(
    new MouseEvent("mousedown", {
      button: 0,
      clientX: latestBounds.left + 4,
      clientY: latestBounds.top + 4,
      bubbles: true,
      cancelable: true,
    }),
  );
  latestCell.dispatchEvent(new MouseEvent("click", { button: 0, bubbles: true, cancelable: true }));
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => {
      resolve();
    }),
  );
  const latestSelection = view.state.selection.main;
  // The selection update can replace cell spans. Keys arrive at the live
  // contenteditable, never at a detached span captured before the click.
  press(view.contentDOM, "Escape");
  check(view.dom.querySelector(".cm-floating-search") === null, "content Escape left search open");
  check(
    view.state.selection.main.eq(latestSelection) && view.state.doc.toString() === tableSource,
    "content Escape did not preserve the latest table selection/source",
  );

  press(view.contentDOM, "h", true);
  const query = view.dom.querySelector<HTMLInputElement>("[data-search-input=query]");
  const replacement = view.dom.querySelector<HTMLInputElement>("[data-search-input=replacement]");
  check(query && replacement, "Ctrl+H did not open floating UI");
  const queryBounds = query.parentElement?.getBoundingClientRect();
  const replacementBounds = replacement.parentElement?.getBoundingClientRect();
  check(queryBounds && replacementBounds, "search input frames missing");
  check(
    Math.abs(queryBounds.left - replacementBounds.left) < 0.5 &&
      Math.abs(queryBounds.right - replacementBounds.right) < 0.5 &&
      Math.abs(queryBounds.width - replacementBounds.width) < 0.5,
    `search input frames differ: ${JSON.stringify({ queryBounds, replacementBounds })}`,
  );
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
    synthetic: true,
    tableSourceGeometry: {
      text: visibleAfter.text,
      from: visibleAfter.from,
      sourcePosition,
      lineBlock: {
        from: lineBlock.from,
        to: lineBlock.to,
        top: lineBlock.top,
        bottom: lineBlock.bottom,
      },
      rangeBounds,
      sourceCaret,
    },
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
