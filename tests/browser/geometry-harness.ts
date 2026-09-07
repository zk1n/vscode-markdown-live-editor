import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { createLivePreviewEngine } from "../../src/webview/livePreview/LivePreviewEngine.js";

interface GeometryLineMetadata {
  readonly block: { readonly bottom: number; readonly height: number; readonly top: number };
  readonly coords: { readonly bottom: number; readonly top: number } | null;
  readonly dom: {
    readonly bottom: number;
    readonly height: number;
    readonly left: number;
    readonly top: number;
  };
  readonly hit: {
    readonly clientX: number;
    readonly clientY: number;
    readonly domLine: number | null;
    readonly line: number | null;
    readonly pos: number | null;
  };
  readonly line: number;
  readonly margins: { readonly bottom: string; readonly top: string };
  readonly text: { readonly bottom: number; readonly top: number } | null;
}

interface DragMetadata {
  readonly anchorLine: number;
  readonly anchorPos: number | null;
  readonly direction: "down" | "up";
  readonly headLine: number;
  readonly headPos: number | null;
  readonly matches: boolean;
  readonly name: string;
}

interface GeometryPhaseResult {
  readonly typography: {
    readonly fontFamily: string;
    readonly fontSize: string;
    readonly fontWeight: string;
    readonly lineHeight: string;
  };
  readonly coordsMatch: boolean;
  readonly dragTests: readonly DragMetadata[];
  readonly geometryMatches: boolean;
  readonly hitTestsMatch: boolean;
  readonly horizontalGutter: number;
  readonly horizontalGutterMatches: boolean;
  readonly lineMetadata: readonly GeometryLineMetadata[];
  readonly name: string;
}

interface GeometryHarnessResult {
  readonly documentTop: number;
  readonly geometryMatches: boolean;
  readonly hitTestsMatch: boolean;
  readonly phases: readonly GeometryPhaseResult[];
}

declare global {
  interface Window {
    __geometryHarnessResult?: GeometryHarnessResult | { readonly error: string };
  }
}

const source = [
  "# Heading one",
  "",
  "plain **strong** and *emphasis* with `inline code`",
  "> quoted text",
  "- list item",
  "  - nested item",
  "    - deeply nested item",
  "- [ ] task item",
  "1. ordered item",
  "",
  "```ts",
  "const value = 1;",
  "```",
  "",
  "---",
  "plain [link](https://example.invalid) ~~strike~~",
].join("\n");
const parent = document.getElementById("editor-root");
if (parent === null) {
  throw new Error("The geometry harness root is missing.");
}
const engine = createLivePreviewEngine();
// Installed Markdown Preview defaults, supplied by the host style snapshot.
document.documentElement.style.setProperty("--markdown-line-height", "1.6");
document.documentElement.style.setProperty(
  "--vscode-editor-font-family",
  "OracleEditor, monospace",
);
const view = new EditorView({
  parent,
  state: EditorState.create({
    doc: source,
    selection: { anchor: source.length },
    extensions: [engine.extension],
  }),
});

// Keep --dump-dom Chromium alive while CodeMirror services the second
// requestMeasure frame. The runner releases this loopback request as soon as
// it receives the result beacon.
void fetch("/__geometry-harness-hold").catch(() => undefined);
void runGeometryHarness(view).catch((error: unknown) => {
  void publishResult({ error: String(error) });
});

async function runGeometryHarness(editor: EditorView): Promise<void> {
  await animationFrame();
  editor.requestMeasure();
  await animationFrame();
  const base = measurePhase(editor, "base");
  assertVisualParity(editor, source);
  if (
    base.typography.fontFamily === "monospace" ||
    base.typography.fontSize !== "14px" ||
    base.typography.fontWeight !== "400"
  ) {
    throw new Error("Preview body typography did not override CodeMirror defaults.");
  }

  const customMetrics = document.createElement("style");
  customMetrics.textContent = [
    ".cm-editor { --markdown-font-size: 16px; --markdown-line-height: 29px; }",
    ".cm-line.cm-live-preview-heading-line { line-height: 1.35; }",
  ].join("\n");
  document.head.append(customMetrics);
  editor.requestMeasure();
  await animationFrame();
  const afterCustomMetrics = measurePhase(editor, "after-custom-metrics-requestMeasure");
  if (
    afterCustomMetrics.typography.fontSize !== "16px" ||
    afterCustomMetrics.typography.lineHeight !== "29px"
  ) {
    throw new Error("Custom typography did not reach the measured content.");
  }

  const phases = [base, afterCustomMetrics];
  const documentTop = editor.documentTop;
  await publishResult({
    documentTop: round(documentTop),
    geometryMatches: phases.every(
      (phase) => phase.geometryMatches && phase.coordsMatch && phase.horizontalGutterMatches,
    ),
    hitTestsMatch: phases.every(
      (phase) => phase.hitTestsMatch && phase.dragTests.every((drag) => drag.matches),
    ),
    phases,
  });
}

function measurePhase(editor: EditorView, name: string): GeometryPhaseResult {
  const lines = [...editor.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];
  const lineMetadata = lines.map((line, index) => metadataForLine(editor, line, index));
  const documentTop = editor.documentTop;
  const editorLeft = editor.dom.getBoundingClientRect().left;
  const horizontalGutter = round((lineMetadata[0]?.dom.left ?? editorLeft) - editorLeft);
  const dragTests = [
    dragMetadata("heading-to-paragraph", "down", lineMetadata, 1, 3),
    dragMetadata("paragraph-to-list", "down", lineMetadata, 3, 5),
    dragMetadata("list-to-task", "down", lineMetadata, 6, 8),
    dragMetadata("task-to-blank", "down", lineMetadata, 8, 10),
    dragMetadata("fence-to-paragraph", "down", lineMetadata, 11, 16),
    dragMetadata("paragraph-to-heading", "up", lineMetadata, 16, 1),
    dragMetadata("task-to-paragraph", "up", lineMetadata, 8, 3),
  ];
  const contentStyle = getComputedStyle(editor.contentDOM);
  return {
    typography: {
      fontFamily: contentStyle.fontFamily,
      fontSize: contentStyle.fontSize,
      fontWeight: contentStyle.fontWeight,
      lineHeight: contentStyle.lineHeight,
    },
    coordsMatch: lineMetadata.every(
      (line) =>
        line.coords !== null &&
        line.coords.top >= line.dom.top - 1 &&
        line.coords.bottom <= line.dom.bottom + 1,
    ),
    dragTests,
    geometryMatches: lineMetadata.every((line) => {
      const expectedTop = documentTop + line.block.top;
      const expectedBottom = documentTop + line.block.bottom;
      return (
        Math.abs(line.dom.top - expectedTop) <= 1 &&
        Math.abs(line.dom.bottom - expectedBottom) <= 1 &&
        line.margins.top === "0px" &&
        line.margins.bottom === "0px"
      );
    }),
    hitTestsMatch: lineMetadata.every(
      (line) => line.hit.line === line.line && line.hit.domLine === line.line,
    ),
    horizontalGutter,
    horizontalGutterMatches: Math.abs(horizontalGutter - 26) <= 1,
    lineMetadata,
    name,
  };
}

function assertVisualParity(editor: EditorView, expectedSource: string): void {
  const markers = [
    ...editor.contentDOM.querySelectorAll<HTMLElement>(".cm-live-preview-native-unordered-marker"),
  ];
  const expectedTypes = ["disc", "circle", "square"];
  if (markers.length !== expectedTypes.length) {
    throw new Error(`Expected ${String(expectedTypes.length)} native unordered markers.`);
  }
  const textLefts = markers.map((marker, index) => {
    const style = getComputedStyle(marker);
    if (
      style.display !== "inline flow-root list-item" ||
      style.listStyleType !== expectedTypes[index] ||
      style.color !== getComputedStyle(editor.contentDOM).color ||
      style.lineHeight !== getComputedStyle(editor.contentDOM).lineHeight
    ) {
      throw new Error(`Native marker ${String(index + 1)} did not inherit the Preview style.`);
    }
    const line = marker.closest<HTMLElement>(".cm-line");
    const textNode = line === null ? undefined : firstTextNode(line);
    const textRect = textNode === undefined ? null : textRectFor(textNode);
    if (textRect === null) {
      throw new Error(`Native marker ${String(index + 1)} has no text geometry.`);
    }
    return textRect.left;
  });
  if (
    textLefts.some(
      (left, index) => index > 0 && Math.abs(left - (textLefts[index - 1] ?? left) - 40) > 1,
    )
  ) {
    throw new Error("Native marker depths did not increase text geometry by 40px.");
  }

  const inlineCode = editor.contentDOM.querySelector<HTMLElement>(".cm-live-preview-inline-code");
  if (inlineCode === null) {
    throw new Error("Inline code presentation is missing.");
  }
  const codeStyle = getComputedStyle(inlineCode);
  const contentStyle = getComputedStyle(editor.contentDOM);
  if (
    codeStyle.color !== contentStyle.color ||
    codeStyle.backgroundColor !== "rgba(0, 0, 0, 0)" ||
    codeStyle.borderRadius !== "0px" ||
    codeStyle.paddingLeft !== "0px" ||
    codeStyle.paddingRight !== "0px" ||
    codeStyle.fontFamily !==
      getComputedStyle(document.documentElement)
        .getPropertyValue("--vscode-editor-font-family")
        .trim() ||
    codeStyle.fontSize !== contentStyle.fontSize ||
    codeStyle.fontWeight !== contentStyle.fontWeight ||
    codeStyle.lineHeight !== "18.998px"
  ) {
    throw new Error("Inline code did not match the VS Code 1.136.1 style oracle.");
  }
  if (editor.state.doc.toString() !== expectedSource) {
    throw new Error("Presentation changed the Markdown source.");
  }
}

async function publishResult(
  result: GeometryHarnessResult | { readonly error: string },
): Promise<void> {
  window.__geometryHarnessResult = result;
  const output = document.getElementById("geometry-harness-result");
  const payload = JSON.stringify(result);
  if (output !== null) {
    output.textContent = payload;
  }
  console.log(`GEOMETRY_HARNESS_RESULT:${payload}`);
  try {
    const sent =
      typeof navigator.sendBeacon === "function"
        ? navigator.sendBeacon("/__geometry-harness-result", payload)
        : false;
    if (!sent) {
      await fetch("/__geometry-harness-result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
    }
  } catch (error) {
    try {
      const search = new URLSearchParams({ payload }).toString();
      const request = await fetch(`/__geometry-harness-result?${search}`, {
        method: "GET",
      });
      if (!request.ok) {
        throw new Error(`Geometry result GET request failed with ${String(request.status)}.`);
      }
    } catch (fallbackError) {
      console.warn("Failed to post geometry result to harness endpoint.", error, fallbackError);
    }
  }
}

function metadataForLine(
  view: EditorView,
  lineElement: HTMLElement,
  index: number,
): GeometryLineMetadata {
  const documentLine = view.state.doc.line(index + 1);
  const lineRect = lineElement.getBoundingClientRect();
  const textNode = firstTextNode(lineElement);
  const textRect = textNode === undefined ? null : textRectFor(textNode);
  const clickY =
    textRect === null ? (lineRect.top + lineRect.bottom) / 2 : (textRect.top + textRect.bottom) / 2;
  const clickX =
    textRect === null ? lineRect.left + 1 : Math.min(textRect.right - 1, textRect.left + 1);
  const hit = view.posAtCoords({ x: clickX, y: clickY });
  const hitElement = document.elementFromPoint(clickX, clickY);
  const hitLineElement = hitElement?.closest<HTMLElement>(".cm-line");
  const domLine =
    hitLineElement === null || hitLineElement === undefined
      ? null
      : lineIndex(view, hitLineElement);
  const block = view.lineBlockAt(documentLine.from);
  const coords = view.coordsAtPos(documentLine.from);
  const style = getComputedStyle(lineElement);
  return {
    block: { bottom: round(block.bottom), height: round(block.height), top: round(block.top) },
    coords: coords === null ? null : { bottom: round(coords.bottom), top: round(coords.top) },
    dom: {
      bottom: round(lineRect.bottom),
      height: round(lineRect.height),
      left: round(lineRect.left),
      top: round(lineRect.top),
    },
    hit: {
      clientX: round(clickX),
      clientY: round(clickY),
      domLine,
      line: hit === null ? null : view.state.doc.lineAt(hit).number,
      pos: hit,
    },
    line: index + 1,
    margins: { bottom: style.marginBottom, top: style.marginTop },
    text: textRect === null ? null : { bottom: round(textRect.bottom), top: round(textRect.top) },
  };
}

function dragMetadata(
  name: string,
  direction: "down" | "up",
  lines: readonly GeometryLineMetadata[],
  anchorLine: number,
  headLine: number,
): DragMetadata {
  const anchorPos = lines[anchorLine - 1]?.hit.pos ?? null;
  const headPos = lines[headLine - 1]?.hit.pos ?? null;
  return {
    anchorLine,
    anchorPos,
    direction,
    headLine,
    headPos,
    matches:
      anchorPos !== null &&
      headPos !== null &&
      (direction === "down" ? anchorPos < headPos : anchorPos > headPos),
    name,
  };
}

function lineIndex(view: EditorView, line: HTMLElement): number | null {
  const lines = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];
  const index = lines.indexOf(line);
  return index < 0 ? null : index + 1;
}

function firstTextNode(element: HTMLElement): Text | undefined {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.textContent !== null && node.textContent.length > 0) {
      return node as Text;
    }
  }
  return undefined;
}

function textRectFor(textNode: Text): DOMRect | null {
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
