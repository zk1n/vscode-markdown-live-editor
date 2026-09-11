import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, activateHover, hasHoverTooltips, keymap } from "@codemirror/view";
import { createLivePreviewEngine } from "../../src/webview/livePreview/LivePreviewEngine.js";
import { compactSpacing } from "../../src/webview/livePreview/compactSpacing.js";
import { tableEditing } from "../../src/webview/livePreview/tableEditing.js";
import { imageEditing } from "../../src/webview/livePreview/imageEditing.js";
import { linkPreview } from "../../src/webview/livePreview/linkPreview.js";
import { RichClient } from "../../src/webview/richClient.js";
import { createFindReplace } from "../../src/webview/search/findReplace.js";
import { headingInputAssistance } from "../../src/webview/inputAssistance.js";
import { createTabKeymap } from "../../src/webview/tabKeymap.js";
import { v02Toolbar } from "../../src/webview/v02Toolbar.js";
import { PROTOCOL_VERSION } from "../../src/protocol/messages.js";
import { findTables } from "../../src/core/markdown/tableSource.js";

const source = [
  "# v0.2 レビュー",
  "",
  "表・画像・検索を併用します。",
  "",
  "| **名前** | 説明 |",
  "| :--- | ---: |",
  "| 日本語 | needle と長いセルの折り返しを確認する文章です。 |",
  "|  | escaped \\| pipe |",
  "",
  "![図](assets/fixture.png)",
  "",
  "[リンク先](target.md#section)",
  "",
  "末尾 needle",
].join("\n");
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
function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`v02: ${message}`);
}
function press(view: EditorView, key: string, options: KeyboardEventInit = {}): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true, ...options }),
  );
}

export async function runV02Geometry(
  parent: HTMLElement,
): Promise<readonly Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  const engine = createLivePreviewEngine();
  const client = new RichClient((request) => {
    queueMicrotask(() => {
      client.receive({
        kind: "rich-response",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///fixture.md",
        sessionId: "geometry",
        controllerId: "geometry",
        requestId: request.requestId,
        documentVersion: 1,
        ok: true,
        ...(request.operation === "image-resolve"
          ? {
              url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="220" height="80"%3E%3Crect width="220" height="80" fill="%23007acc"/%3E%3Ctext x="20" y="47" fill="white" font-size="20"%3Ev0.2 image%3C/text%3E%3C/svg%3E',
            }
          : { title: "target.md", text: "# Section\n\n未保存のリンク先 needle" }),
      });
    });
  });
  const actions = {
    client,
    isEditable: () => true,
    synchronize: () => Promise.resolve(true),
    notify: (note: string) => {
      throw new Error(note);
    },
  };
  const find = createFindReplace({ isEditable: () => true });
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: source,
      selection: { anchor: source.length },
      extensions: [
        markdown(),
        engine.extension,
        compactSpacing,
        tableEditing(() => true),
        imageEditing(actions),
        linkPreview(actions),
        headingInputAssistance(() => true),
        find.extension,
        keymap.of(
          createTabKeymap({
            isTabEditable: () => true,
            getInsertSpaces: () => true,
            getTabSize: () => 4,
            getIndentSize: () => 4,
          }),
        ),
        v02Toolbar(
          (command) => {
            if (command === "find" || command === "replace") find.open(view, command === "replace");
          },
          () => true,
          () => undefined,
        ),
      ],
    }),
  });
  await measure(view);
  // Resource loading has real image geometry, with its own lifecycle measurement.
  const image = view.dom.querySelector<HTMLImageElement>(".cm-image-preview img");
  requireCondition(image !== null, "image widget missing");
  if (!image.complete)
    await new Promise<void>((resolve, reject) => {
      image.addEventListener(
        "load",
        () => {
          resolve();
        },
        { once: true },
      );
      image.addEventListener(
        "error",
        () => {
          reject(new Error("fixture image failed"));
        },
        { once: true },
      );
    });
  await measure(view);
  requireCondition(image.naturalWidth === 220, "image failed to load");
  for (const [width, fontSize] of [
    [900, 14],
    [380, 14],
    [380, 18],
  ] as const) {
    parent.style.width = `${String(width)}px`;
    view.dom.style.setProperty("--markdown-font-size", `${String(fontSize)}px`);
    await measure(view);
    const table = findTables(source)[0];
    requireCondition(table !== undefined, "table missing");
    const bounds: { column: number; left: number; width: number; height: number; hit: number }[] =
      [];
    for (const row of table.rows) {
      for (const [column, cell] of row.cells.entries()) {
        const elements = [
          ...view.contentDOM.querySelectorAll<HTMLElement>(
            `[data-table-cell="${String(cell.contentFrom)}"]`,
          ),
        ];
        requireCondition(
          elements.length === 1,
          `cell split into ${String(elements.length)} wrappers at ${String(cell.contentFrom)}`,
        );
        const element = elements[0];
        requireCondition(element !== undefined, "missing cell element");
        const rect = element.getBoundingClientRect();
        const hit = view.posAtCoords({
          x: rect.left + Math.min(16, rect.width / 2),
          y: rect.top + Math.min(14, rect.height / 2),
        });
        requireCondition(
          hit !== null && hit >= cell.from && hit <= cell.to,
          `cell hit ${String(hit)} outside ${String(cell.from)}..${String(cell.to)}`,
        );
        bounds.push({ column, left: rect.left, width: rect.width, height: rect.height, hit });
      }
      const dom = view.dom.querySelector<HTMLElement>(`[data-table-from="${String(table.from)}"]`);
      requireCondition(dom !== null, "table line missing");
      const element = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-table-row")].find(
        (line) => view.posAtDOM(line) === row.from,
      );
      requireCondition(element !== undefined, "source row missing");
      const rect = element.getBoundingClientRect();
      const block = view.lineBlockAt(row.from);
      requireCondition(
        Math.abs(rect.top - (view.documentTop + block.top)) <= 1 &&
          Math.abs(rect.height - block.height) <= 1,
        `row geometry mismatch at ${String(row.from)}`,
      );
    }
    for (const column of [0, 1]) {
      const columnBounds = bounds.filter((item) => item.column === column);
      const first = columnBounds[0];
      requireCondition(first !== undefined, "empty column");
      requireCondition(
        columnBounds.every(
          (item) =>
            Math.abs(item.left - first.left) <= 1 && Math.abs(item.width - first.width) <= 1,
        ),
        `column ${String(column)} alignment drift`,
      );
    }
    const blank = view.contentDOM.querySelector<HTMLElement>(".cm-live-preview-compact-blank");
    requireCondition(blank !== null, "compact line missing");
    const blankRect = blank.getBoundingClientRect();
    const blankPosition = view.posAtDOM(blank);
    const hit = view.posAtCoords({
      x: blankRect.left + 1,
      y: (blankRect.top + blankRect.bottom) / 2,
    });
    requireCondition(
      hit === blankPosition,
      `compact blank hit ${String(hit)} != ${String(blankPosition)}`,
    );
    view.dispatch({ selection: { anchor: blankPosition } });
    await measure(view);
    const expanded = view.coordsAtPos(blankPosition);
    requireCondition(
      expanded !== null && expanded.bottom - expanded.top > blankRect.height,
      "selected blank did not expand",
    );
    view.dispatch({ selection: { anchor: source.length } });
    await measure(view);
    requireCondition(view.state.doc.toString() === source, "geometry/source changed");
    results.push({
      width,
      fontSize,
      columns: bounds,
      compactHeight: blankRect.height,
      selectedBlankHeight: expanded.bottom - expanded.top,
      sourceUnchanged: true,
    });
  }
  // Header to next cell must use the table keymap before the standard Tab path.
  const table = findTables(source)[0];
  const first = table?.rows[0]?.cells[0];
  const second = table?.rows[0]?.cells[1];
  requireCondition(first !== undefined && second !== undefined, "table cells missing");
  view.dispatch({ selection: { anchor: first.contentFrom } });
  press(view, "Tab");
  requireCondition(
    view.state.selection.main.from === second.contentFrom,
    "Tab priority did not reach next table cell",
  );
  view.dispatch({ selection: { anchor: 0 } });
  find.open(view, true);
  const search = view.dom.querySelector<HTMLInputElement>("[data-find-replace=search]");
  const next = view.dom.querySelector<HTMLButtonElement>("[data-find-replace=next]");
  requireCondition(search !== null && next !== null, "find controls missing");
  search.value = "assets/fixture.png";
  search.dispatchEvent(new InputEvent("input", { bubbles: true }));
  next.click();
  await measure(view);
  requireCondition(
    view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) ===
      "assets/fixture.png",
    "search did not reach hidden image source",
  );
  requireCondition(
    view.dom.querySelector(".cm-image-preview") === null,
    "image source not revealed for search",
  );
  search.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  view.dispatch({ selection: { anchor: source.length } });
  await measure(view);
  activateHover(view, source.indexOf("[リンク先]") + 2, 1);
  await frame();
  await frame();
  await frame();
  requireCondition(hasHoverTooltips(view.state), "link hover did not open");
  requireCondition(
    view.dom.querySelector(".cm-link-preview")?.textContent.includes("未保存") === true,
    "link hover content missing",
  );
  press(view, "Escape");
  requireCondition(!hasHoverTooltips(view.state), "Escape left hover open");
  requireCondition(view.state.doc.toString() === source, "hover/search/navigation changed source");
  results.push({
    tableKeymap: true,
    hiddenSourceSearch: true,
    hoverOpenClose: true,
    sourceUnchanged: true,
  });
  // Leave the final tested view visible in the browser dump for inspection.
  return results;
}
