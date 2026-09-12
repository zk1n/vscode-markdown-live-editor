import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, activateHover, hasHoverTooltips, keymap } from "@codemirror/view";
import { createContextActions } from "../../src/webview/contextActions.js";
import { createLivePreviewEngine } from "../../src/webview/livePreview/LivePreviewEngine.js";
import { compactSpacing } from "../../src/webview/livePreview/compactSpacing.js";
import { tableEditing } from "../../src/webview/livePreview/tableEditing.js";
import { imageEditing } from "../../src/webview/livePreview/imageEditing.js";
import { linkPreview } from "../../src/webview/livePreview/linkPreview.js";
import { RichClient } from "../../src/webview/richClient.js";
import { headingInputAssistance } from "../../src/webview/inputAssistance.js";
import { structuralInputAssistance } from "../../src/webview/structuralSpacing.js";
import { createTabKeymap } from "../../src/webview/tabKeymap.js";
import { PROTOCOL_VERSION } from "../../src/protocol/messages.js";
import { findTables } from "../../src/core/markdown/tableSource.js";

const source = [
  "# v0.2 レビュー",
  "",
  "見出し後の本文は構造用の小さな余白で区切ります。",
  "",
  "通常の段落間には、意図した空行をそのまま残します。",
  "",
  "次の段落も通常の行間で読みます。",
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
function nativeContext(element: HTMLElement): Readonly<Record<string, unknown>> {
  const value = element.dataset["vscodeContext"];
  requireCondition(value !== undefined, "native context metadata missing");
  const parsed: unknown = JSON.parse(value);
  requireCondition(
    typeof parsed === "object" && parsed !== null,
    "invalid native context metadata",
  );
  return parsed as Readonly<Record<string, unknown>>;
}
function contextMenu(element: HTMLElement): void {
  element.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
  );
}
function verifyStructuralEditing(parent: HTMLElement): void {
  const extension = [
    structuralInputAssistance(),
    compactSpacing,
    headingInputAssistance(() => true),
  ];
  const enter = new EditorView({
    parent,
    state: EditorState.create({
      doc: "# 作業見出し",
      selection: { anchor: "# 作業見出し".length },
      extensions: extension,
    }),
  });
  try {
    press(enter, "Enter");
    requireCondition(
      enter.state.doc.toString() === "# 作業見出し\n\n",
      "heading Enter lost its input line",
    );
    requireCondition(
      enter.state.doc.lineAt(enter.state.selection.main.head).number === 3,
      "heading Enter caret did not reach the writable input line",
    );
    requireCondition(
      enter.coordsAtPos(enter.state.selection.main.head) !== null,
      "heading input caret has no geometry",
    );
  } finally {
    enter.destroy();
  }
  for (const key of ["Backspace", "Delete"] as const) {
    const position = key === "Backspace" ? 5 : 3;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "# h\n\nbody",
        selection: { anchor: position },
        extensions: extension,
      }),
    });
    try {
      press(view, key);
      requireCondition(
        view.state.doc.toString() === "# h\nbody",
        `${key} removed content instead of only the managed separator`,
      );
    } finally {
      view.destroy();
    }
  }
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
  const contexts = createContextActions({
    identity: () => ({
      protocolVersion: PROTOCOL_VERSION,
      documentUri: "file:///fixture.md",
      sessionId: "geometry",
      controllerId: "geometry",
      documentVersion: 1,
    }),
    isEditable: () => true,
  });
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: source,
      selection: { anchor: source.length },
      extensions: [
        markdown(),
        engine.extension,
        compactSpacing,
        structuralInputAssistance(),
        tableEditing(() => true),
        imageEditing(actions),
        linkPreview(actions),
        headingInputAssistance(() => true),
        contexts.extension,
        keymap.of(
          createTabKeymap({
            isTabEditable: () => true,
            getInsertSpaces: () => true,
            getTabSize: () => 4,
            getIndentSize: () => 4,
          }),
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
    const gap = view.contentDOM.querySelector<HTMLElement>(".cm-structural-gap");
    requireCondition(gap !== null, "structural heading gap missing");
    const gapRect = gap.getBoundingClientRect();
    const headingEnd = source.indexOf("\n");
    const bodyStart = source.indexOf("見出し後の本文");
    requireCondition(headingEnd >= 0 && bodyStart > headingEnd, "heading gap source missing");
    const gapHit = view.posAtCoords({
      x: gapRect.left + 1,
      y: (gapRect.top + gapRect.bottom) / 2,
    });
    requireCondition(
      gapHit === headingEnd || gapHit === bodyStart,
      `structural gap hit ${String(gapHit)} was not a boundary`,
    );
    // A structural gap is atomic: moving into its hidden newlines lands at an
    // adjacent source boundary rather than creating a separate blank-line stop.
    view.dispatch({ selection: { anchor: headingEnd + 1 } });
    requireCondition(
      view.state.selection.main.head === headingEnd || view.state.selection.main.head === bodyStart,
      "structural gap accepted an independent caret stop",
    );
    const manualBlank = source.indexOf("\n\n通常の段落間") + 1;
    const manualBlock = view.lineBlockAt(manualBlank);
    requireCondition(
      manualBlock.height > gapRect.height,
      "ordinary paragraph blank was compacted with the structural gap",
    );
    view.dispatch({ selection: { anchor: source.length } });
    await measure(view);
    requireCondition(view.state.doc.toString() === source, "geometry/source changed");
    results.push({
      width,
      fontSize,
      columns: bounds,
      structuralGapHeight: gapRect.height,
      ordinaryBlankHeight: manualBlock.height,
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
  const firstCell = view.contentDOM.querySelector<HTMLElement>(
    `[data-table-cell="${String(first.contentFrom)}"]`,
  );
  const secondCell = view.contentDOM.querySelector<HTMLElement>(
    `[data-table-cell="${String(second.contentFrom)}"]`,
  );
  requireCondition(firstCell !== null && secondCell !== null, "context table cells missing");
  view.dispatch({ selection: { anchor: first.contentFrom } });
  contextMenu(secondCell);
  const tableContext = nativeContext(secondCell);
  requireCondition(
    tableContext["webviewSection"] === "markdown-table" &&
      tableContext["markdownContextEditable"] === true &&
      typeof tableContext["markdownContextToken"] === "string",
    "right-click did not fix the second table target",
  );
  requireCondition(
    view.state.selection.main.head === first.contentFrom,
    "right-click moved the caret away from its original table cell",
  );
  requireCondition(contexts.run("table-source"), "caret table source command failed");
  requireCondition(
    view.contentDOM.querySelector(".cm-table-cell") === null,
    "table source command did not reveal source",
  );
  requireCondition(contexts.run("table-source"), "table source command did not toggle back");
  view.dispatch({ selection: { anchor: source.length } });
  await measure(view);
  const imagePreview = view.dom.querySelector<HTMLElement>(".cm-image-preview");
  requireCondition(imagePreview !== null, "image preview was not restored");
  contextMenu(imagePreview);
  const imageContext = nativeContext(imagePreview);
  const imageToken = imageContext["markdownContextToken"];
  requireCondition(typeof imageToken === "string", "image context token missing");
  requireCondition(
    contexts.run("image-source", imageToken, 1),
    "image source command did not reveal its Markdown",
  );
  requireCondition(
    view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) ===
      "![図](assets/fixture.png)",
    "image source selection did not match Markdown",
  );
  requireCondition(
    view.dom.querySelector(".cm-image-preview") === null,
    "image source remained hidden",
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
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const) press(view, key);
  view.dispatch({ selection: { anchor: 0, head: source.length } });
  view.contentDOM.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
  requireCondition(view.state.doc.toString() === source, "hover/navigation/copy changed source");
  results.push({
    tableKeymap: true,
    tableAndImageContext: true,
    imageSourceReveal: true,
    hoverOpenClose: true,
    sourceUnchanged: true,
  });
  verifyStructuralEditing(parent);
  results.push({ structuralInputAndDeletion: true, sourceUnchanged: true });
  // Leave the final tested view visible in the browser dump for inspection.
  return results;
}
