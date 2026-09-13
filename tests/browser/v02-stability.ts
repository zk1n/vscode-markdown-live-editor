import { defaultKeymap, history, isolateHistory, redo, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { findTables } from "../../src/core/markdown/tableSource.js";
import { createLivePreviewEngine } from "../../src/webview/livePreview/LivePreviewEngine.js";
import { editTable, tableEditing } from "../../src/webview/livePreview/tableEditing.js";
import {
  imageEditing,
  insertImage,
  refreshImages,
} from "../../src/webview/livePreview/imageEditing.js";
import { RichClient } from "../../src/webview/richClient.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`v02 stability: ${message}`);
}
const frame = (): Promise<void> =>
  new Promise((resolve) =>
    requestAnimationFrame(() => {
      resolve();
    }),
  );
async function measure(view: EditorView): Promise<void> {
  view.requestMeasure();
  await frame();
  await frame();
}
async function loaded(view: EditorView): Promise<HTMLImageElement> {
  for (let count = 0; count < 180; count += 1) {
    const image = view.dom.querySelector<HTMLImageElement>(".cm-image-preview img");
    if (image?.complete === true && image.naturalWidth > 0) return image;
    await frame();
  }
  throw new Error("cold image did not load");
}

/** Real layout and sequential interaction evidence, not OS/IME acceptance. */
export async function runV02Stability(
  parent: HTMLElement,
): Promise<readonly Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  const engine = createLivePreviewEngine();
  for (const width of [900, 380]) {
    parent.style.width = `${String(width)}px`;
    const source =
      "before\n\n| **名前** | 説明 |\n| --- | --- |\n| 日本語 | escaped \\| `code` [link](a.md) |\n|  | 長い説明の折り返しを確認する文章です。 |\n\nafter";
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: source,
        selection: { anchor: source.indexOf("日本語") },
        extensions: [
          engine.extension,
          tableEditing(() => true),
          history(),
          keymap.of(defaultKeymap),
        ],
      }),
    });
    try {
      for (const action of ["row-add", "column-add"] as const) {
        const before = view.state.doc.toString();
        check(editTable(view, action), `${action} failed`);
        await measure(view);
        const position = view.state.selection.main.head;
        const point = view.coordsAtPos(position);
        check(point !== null && point.bottom > point.top, `${action} caret has no visible height`);
        const dom = view.domAtPos(position);
        const element = dom.node instanceof Element ? dom.node : dom.node.parentElement;
        const cell = element?.closest<HTMLElement>(".cm-table-cell");
        check(cell !== null && cell !== undefined, `${action} caret is outside a cell`);
        const bounds = cell.getBoundingClientRect();
        check(
          point.left >= bounds.left - 1 &&
            point.left <= bounds.right + 1 &&
            point.top >= bounds.top - 1 &&
            point.bottom <= bounds.bottom + 1,
          `${action} caret coordinates escape the target cell`,
        );
        check(view.hasFocus, `${action} lost focus`);
        view.dispatch({
          ...view.state.replaceSelection("即入力"),
          annotations: isolateHistory.of("full"),
          userEvent: "input.type",
        });
        const typed = view.state.doc.toString();
        check(typed.includes("| 即入力 |"), `${action} typed through a pipe`);
        check(undo(view), "typing Undo failed");
        check(undo(view), "table Undo failed");
        check(view.state.doc.toString() === before, "table Undo lost literal source");
        check(redo(view) && redo(view), "table/typing Redo failed");
        check(view.state.doc.toString() === typed, "Redo changed source");
        results.push({
          width,
          action,
          caret: point,
          cell: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
          immediateInput: true,
          undoRedo: true,
        });
      }
      const table = findTables(view.state.doc.toString())[0];
      const row = table?.rows[1];
      check(row !== undefined, "data row missing");
      const unchanged = view.state.doc.toString();
      check(editTable(view, "source", row.from), "explicit source mode failed");
      for (let position = row.from; position <= row.to; position += 1) {
        view.dispatch({ selection: { anchor: position } });
        await measure(view);
        const caret = view.coordsAtPos(position);
        check(
          caret !== null && caret.bottom > caret.top,
          `raw row caret invisible at ${String(position - row.from)}`,
        );
        check(
          view.contentDOM.textContent.includes(view.state.doc.sliceString(row.from, row.to)),
          "raw row hid source while moving",
        );
      }
      check(view.state.doc.toString() === unchanged, "caret movement changed Markdown");
      results.push({ width, pipeAndPaddingCaret: true, sourceUnchanged: true });
    } finally {
      view.destroy();
    }
  }
  const events: Record<string, number> = {};
  const requests: Record<string, number> = {};
  const client = new RichClient((request) => {
    requests[request.operation] = (requests[request.operation] ?? 0) + 1;
    client.receive({
      kind: "rich-response",
      protocolVersion: 2,
      documentUri: "file:///fixture.md",
      sessionId: "browser",
      controllerId: "browser",
      requestId: request.requestId,
      documentVersion: 1,
      ok: true,
      ...(request.operation === "image-resolve"
        ? { url: "/tests/fixtures/v02-review/assets/example.png?stability" }
        : { markdown: "![図](assets/example.png)" }),
    });
  });
  const actions = {
    client,
    isEditable: () => true,
    synchronize: () => Promise.resolve(true),
    notify: (): void => undefined,
    onImageEvent: (event: string) => {
      events[event] = (events[event] ?? 0) + 1;
    },
  };
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "before\n\nafter",
      selection: { anchor: 7 },
      extensions: [engine.extension, imageEditing(actions), keymap.of(defaultKeymap)],
    }),
  });
  try {
    await insertImage(view, actions);
    view.dispatch({ selection: { anchor: 0 } });
    const image = await loaded(view);
    await measure(view);
    check(
      view.dom.querySelector(".cm-image-preview button") === null,
      "permanent source button remains",
    );
    const baseline = { ...events };
    for (const side of ["before", "after"]) {
      for (let count = 0; count < 12; count += 1) {
        const position = side === "before" ? 0 : view.state.doc.length;
        view.dispatch({
          changes: { from: position, insert: "字" },
          selection: { anchor: position + 1 },
          userEvent: "input.type",
        });
        await measure(view);
        check(
          view.dom.querySelector(".cm-image-preview img") === image,
          `${side} input recreated image DOM`,
        );
        check(
          view.dom.querySelector<HTMLElement>(".cm-image-preview")?.dataset["imageState"] ===
            "loaded",
          `${side} input restored loading`,
        );
      }
    }
    check(
      events["dom-created"] === baseline["dom-created"] &&
        events["loading"] === baseline["loading"],
      "unrelated edits restarted image lifecycle",
    );
    results.push({
      coldImage: true,
      naturalWidth: image.naturalWidth,
      continuousTyping: { before: 12, after: 12 },
      events: { ...events },
      requests: { ...requests },
      metric: "DOM/client counters; HTTP requests are recorded separately by the server",
    });
    const text = view.state.doc.toString();
    const from = text.indexOf("![図]");
    view.dispatch({ selection: { anchor: from - 1 } });
    view.focus();
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    check(
      view.state.selection.main.head === from &&
        view.dom.querySelector(".cm-image-preview") === null,
      "keyboard did not enter image source",
    );
    view.dispatch({ selection: { anchor: text.length } });
    await loaded(view);
    check(
      view.hasFocus && view.state.doc.toString() === text,
      "image source roundtrip changed source/focus",
    );
    view.dispatch({ effects: refreshImages.of(null) });
    const refreshed = await loaded(view);
    check(refreshed !== image, "actual resource invalidation was ignored");
    results.push({ imageKeyboardSource: true, resourceInvalidation: true, sourceUnchanged: true });
  } finally {
    view.destroy();
    client.dispose();
    engine.dispose();
  }
  return results;
}
