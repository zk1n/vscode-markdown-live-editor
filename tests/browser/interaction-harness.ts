import { defaultEditorPreferences } from "../../src/protocol/editorPreferences.js";
import { EditorView } from "@codemirror/view";
import { findTables, tableCellAt } from "../../src/core/markdown/tableSource.js";
import { applyWireChanges } from "../../src/core/sync/documentText.js";
import { PROTOCOL_VERSION, decodeWebviewToHostMessage } from "../../src/protocol/messages.js";

const initial =
  "before\n\n| **名前** | 説明 |\n| :--- | ---: |\n| 日本語 | escaped \\| `code` [link](hidden-target.md) |\n||  |\n\nafter needle\n\n![図](tests/fixtures/v02-review/assets/example.png)\n\nend needle";
let authority = initial;
let version = 1;
const past: string[] = [];
let future: string[] = [];
let hold = false;
let slowLink = false;
const linkTiming: { event: string; ms: number }[] = [];
let linkStart = 0;
let pending: (() => void) | undefined;
let currentView: EditorView | undefined;
let controller: unknown;
let configurationRevision = 0;
let minimapEnabled = true;
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
  diagnosticMode: "preview",
  nextSequence: 1,
});
document.body.append(bootstrap);
Object.defineProperty(window, "acquireVsCodeApi", {
  value: () => ({
    postMessage: (message: Record<string, unknown>) => {
      controller = message["controllerId"];
      queueMicrotask(() => {
        const base = {
          ...identity,
          controllerId: message["controllerId"],
          documentVersion: version,
        };
        if (
          message["kind"] === "diagnostic" &&
          typeof message["event"] === "string" &&
          message["event"].startsWith("link-preview.")
        ) {
          const event = message["event"].slice("link-preview.".length);
          const details = message["details"] as { time: number };
          if (event === "hover") {
            linkTiming.length = 0;
            linkStart = details.time;
          }
          linkTiming.push({ event, ms: Math.round(details.time - linkStart) });
          element("link-timing").textContent = JSON.stringify(linkTiming.slice(-12));
        }
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
              ...(message["operation"] === "link-preview"
                ? {
                    title: "検証リンク",
                    text: "# プレビュー\n\n" + "読み取り専用のリンク内容。\n\n".repeat(24),
                  }
                : message["operation"] === "image-resolve"
                  ? { url: "/tests/fixtures/v02-review/assets/example.png" }
                  : { markdown: "![貼付](tests/fixtures/v02-review/assets/example.png)" }),
            });
          };
          if (hold && message["operation"] === "image-import") pending = reply;
          else if (slowLink && message["operation"] === "link-preview")
            window.setTimeout(reply, 1200);
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
  const inputFrames: number[] = [];
  const scrollFrames: number[] = [];
  const pointerEvents: {
    type: string;
    trusted: boolean;
    target: string;
    id: number;
    buttons: number;
    x: number;
    y: number;
  }[] = [];
  for (const type of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "gotpointercapture",
    "lostpointercapture",
  ] as const)
    view.dom.addEventListener(
      type,
      (event) => {
        pointerEvents.push({
          type,
          trusted: event.isTrusted,
          target: event.target instanceof HTMLElement ? event.target.className : "",
          id: event.pointerId,
          buttons: event.buttons,
          x: event.clientX,
          y: event.clientY,
        });
        if (pointerEvents.length > 80) pointerEvents.shift();
      },
      true,
    );
  view.contentDOM.addEventListener("beforeinput", () => {
    const start = performance.now();
    requestAnimationFrame(() => {
      inputFrames.push(performance.now() - start);
      if (inputFrames.length > 60) inputFrames.shift();
    });
  });
  view.scrollDOM.addEventListener("scroll", () => {
    const start = performance.now();
    requestAnimationFrame(() => {
      scrollFrames.push(performance.now() - start);
      if (scrollFrames.length > 60) scrollFrames.shift();
    });
  });
  currentView = view;
  document.getElementById("geometry-fixture")?.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const table =
      "| 名前 | 説明 |\n| --- | --- |\n| 日本語 | 折り返し確認 abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz |\n| 最後 | 内容 |\n";
    const after = "\nafter alpha\nafter bravo\nafter charlie\nafter delta\n";
    const fixtures: Record<string, string> = {
      initial,
      plain: `before alpha\nbefore bravo\n${after}${after.replaceAll("after", "second")}`,
      one: `before alpha\nbefore bravo\n\n${table}${after}`,
      two: `before alpha\nbefore bravo\n\n${table}${after}\n${table}${after.replaceAll("after", "second")}`,
      short: Array.from({ length: 20 }, (_, i) => `line ${String(i + 1)} alpha bravo`).join("\n"),
      medium: Array.from({ length: 100 }, (_, i) => `line ${String(i + 1)} alpha bravo`).join("\n"),
      long: Array.from(
        { length: 200 },
        (_, i) => `# Section ${String(i)}\n\n${table}${after}`,
      ).join("\n"),
    };
    const set = (text: string): void => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        userEvent: "input.fixture",
      });
      view.scrollDOM.scrollTop = 0;
      inputFrames.length = scrollFrames.length = 0;
    };
    const text = fixtures[event.target.value];
    if (text !== undefined) set(text);
    else if (["fifth", "sixth", "sixth-long"].includes(event.target.value))
      void fetch(
        `/tests/fixtures/v02-ux-${event.target.value === "fifth" ? "fifth" : "sixth"}-review/${event.target.value === "sixth-long" ? "search-10000.md" : "review-lf.md"}`,
      )
        .then((response) => response.text())
        .then(set);
  });
  document.getElementById("reset")?.addEventListener("click", () => {
    window.location.reload();
  });
  document.getElementById("theme")?.addEventListener("change", (event) => {
    if (event.target instanceof HTMLSelectElement)
      document.body.dataset["theme"] = event.target.value;
    view.requestMeasure();
  });
  document.getElementById("font")?.addEventListener("click", () => {
    const current = document.body.style.getPropertyValue("--markdown-font-size");
    document.body.style.setProperty("--markdown-font-size", current === "20px" ? "14px" : "20px");
    view.requestMeasure();
  });
  document.getElementById("fourth-fixture")?.addEventListener("click", () => {
    void fetch("/tests/fixtures/v02-ux-fourth-review/review-lf.md")
      .then((response) => {
        if (!response.ok) throw new Error("fixture unavailable");
        return response.text();
      })
      .then((text) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: 0 },
          userEvent: "input.fixture",
        });
        view.scrollDOM.scrollTop = 0;
      });
  });
  for (const [id, command] of [
    ["u6-table-source", "table-source"],
    ["u6-return-live", "return-to-live"],
  ]) {
    const button = document.getElementById(id ?? "");
    button?.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    button?.addEventListener("click", () => {
      receive({ ...identity, kind: "rich-command", controllerId: controller, command });
    });
  }
  document.getElementById("u6-preferences")?.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const mode = event.target.value;
    receive({
      ...identity,
      kind: "editor-configuration",
      controllerId: controller,
      revision: ++configurationRevision,
      tabSize: 4,
      insertSpaces: true,
      preferences: {
        ...defaultEditorPreferences,
        wordWrap: mode !== "nowrap",
        lineNumbers: mode !== "nogutter",
        compactSpacing: mode !== "source",
        minimapSlider: mode === "always" ? "always" : "mouseover",
        ...(mode === "small" ? { structuralGap: 0, tableBandSize: 0, tableMinWidth: 0 } : {}),
      },
    });
  });
  document.getElementById("link-delay")?.addEventListener("click", () => {
    slowLink = !slowLink;
    element("link-delay").textContent = slowLink ? "リンク応答:1200ms" : "リンク応答:即時";
  });
  document.getElementById("minimap-toggle")?.addEventListener("click", () => {
    minimapEnabled = !minimapEnabled;
    receive({
      ...identity,
      kind: "editor-configuration",
      controllerId: controller,
      revision: ++configurationRevision,
      tabSize: 4,
      insertSpaces: true,
      minimapEnabled,
    });
  });
  document.getElementById("large-fixture")?.addEventListener("click", () => {
    const text = view.state.doc.toString().repeat(20);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
      userEvent: "input.fixture",
    });
    inputFrames.length = scrollFrames.length = 0;
  });
  document.getElementById("metrics")?.addEventListener("click", () => {
    const activeTable = findTables(view.state.doc.toString()).find((table) =>
      tableCellAt(table, view.state.selection.main.head),
    );
    const cell = activeTable && tableCellAt(activeTable, view.state.selection.main.head)?.cell;
    view.requestMeasure({
      read: () => ({
        length: view.state.doc.length,
        lines: view.state.doc.lines,
        selection: {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        },
        scrollTop: view.scrollDOM.scrollTop,
        contentHeight: view.contentHeight,
        documentTop: view.documentTop,
        scrollHeight: view.scrollDOM.scrollHeight,
        clientHeight: view.scrollDOM.clientHeight,
        devicePixelRatio: window.devicePixelRatio,
        pointerEvents,
        domLines: Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")).map(
          (line) => {
            const from = view.posAtDOM(line);
            const bounds = line.getBoundingClientRect();
            const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
            const characters = [];
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              const text = node.textContent ?? "";
              for (let index = 0; index < text.length; index++) {
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + 1);
                const rect = range.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                const position = view.posAtDOM(node, index);
                characters.push({
                  text: text[index],
                  position,
                  x: rect.left + Math.min(1, rect.width / 4),
                  y: (rect.top + rect.bottom) / 2,
                  hit: view.posAtCoords({
                    x: rect.left + Math.min(1, rect.width / 4),
                    y: (rect.top + rect.bottom) / 2,
                  }),
                  caret: view.coordsAtPos(position),
                });
              }
            }
            return {
              from,
              text: line.textContent,
              top: bounds.top,
              bottom: bounds.bottom,
              height: bounds.height,
              margin: getComputedStyle(line).marginBottom,
              block: view.lineBlockAt(from),
              characters,
            };
          },
        ),
        viewport: view.viewport,
        blocks: view.viewportLineBlocks.map(({ from, to, top, bottom }) => ({
          from,
          to,
          top,
          bottom,
        })),
        minimap: document.querySelector<HTMLElement>(".cm-minimap")?.dataset,
        inputFrames,
        scrollFrames,
        caret: view.coordsAtPos(view.state.selection.main.head),
        cell: cell && {
          from: cell.contentFrom,
          to: cell.contentTo,
          start: view.coordsAtPos(cell.contentFrom),
          end: view.coordsAtPos(cell.contentTo),
          down: view.moveVertically(view.state.selection.main, true).head,
        },
      }),
      write: (measurement) => {
        element("metrics-output").textContent = JSON.stringify(measurement);
        element("metrics-output").hidden = true;
      },
    });
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
