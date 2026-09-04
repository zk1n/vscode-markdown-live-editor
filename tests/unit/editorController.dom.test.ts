// @vitest-environment happy-dom

import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeWebviewToHostMessage,
  PROTOCOL_VERSION,
  type EditorReadyMessage,
  type NavigateToHeadingMessage,
  type WebviewToHostMessage,
} from "../../src/protocol/messages.js";

type PostedMessage = WebviewToHostMessage | EditorReadyMessage;

const messages: PostedMessage[] = [];

function activateLatestController(text: string, documentVersion = 1, nextSequence = 1): void {
  let ready: EditorReadyMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.kind === "editor-ready") {
      ready = candidate;
      break;
    }
  }
  if (ready === undefined) {
    throw new Error("The Webview controller did not announce editor-ready.");
  }
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        kind: "controller-ready",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///composition.md",
        documentVersion,
        sessionId: "session-a",
        controllerId: ready.controllerId,
        nextSequence,
        text,
      },
    }),
  );
}

async function createController(
  text = "- ",
  diagnosticMode = "off",
): Promise<{
  readonly content: HTMLElement;
  readonly view: EditorView;
}> {
  vi.stubGlobal("acquireVsCodeApi", (): { postMessage(message: PostedMessage): void } => ({
    postMessage(message: PostedMessage): void {
      messages.push(message);
    },
  }));
  document.body.innerHTML = `
    <main id="editor-root"></main>
    <div id="editor-status" hidden></div>
    <pre id="editor-diagnostics"></pre>
    <script id="markdown-live-editor-bootstrap" type="application/json">
      ${JSON.stringify({
        diagnosticMode,
        documentUri: "file:///composition.md",
        documentVersion: 1,
        sessionId: "session-a",
        nextSequence: 1,
        text,
      })}
    </script>
  `;
  await import("../../src/webview/editor.js");
  activateLatestController(text);
  const content = document.querySelector<HTMLElement>(".cm-content");
  if (content === null) {
    throw new Error("CodeMirror content DOM was not created.");
  }
  const view = EditorView.findFromDOM(content);
  if (view === null) {
    throw new Error("CodeMirror view was not found from its content DOM.");
  }
  return { content, view };
}

async function emulateNativeLineJoin(
  content: HTMLElement,
  inputType: "deleteContentBackward" | "deleteContentForward",
): Promise<InputEvent> {
  const beforeInput = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType,
  });
  content.dispatchEvent(beforeInput);
  if (!beforeInput.defaultPrevented) {
    const lines = [...content.querySelectorAll<HTMLElement>(".cm-line")];
    const firstLine = lines[0];
    const secondLine = lines[1];
    if (firstLine === undefined || secondLine === undefined) {
      throw new Error("Expected two CodeMirror lines for a native line join.");
    }
    firstLine.textContent = `${firstLine.textContent}${secondLine.textContent}`;
    secondLine.remove();
    content.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return beforeInput;
}

function dispatchBarrierShortcut(content: HTMLElement, key: "s" | "y" | "z"): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: true,
    key,
  });
  Object.defineProperty(event, "keyCode", { value: key.toUpperCase().charCodeAt(0) });
  content.dispatchEvent(event);
  return event;
}

function acknowledge(
  operation: "edit" | "redo" | "undo",
  sequence: number,
  documentVersion: number,
  text: string,
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        kind: "operation-ack",
        operation,
        documentUri: "file:///composition.md",
        documentVersion,
        sequence,
        text,
      },
    }),
  );
}

function editMessages(): Extract<WebviewToHostMessage, { readonly kind: "edit" }>[] {
  return messages.filter(
    (message): message is Extract<WebviewToHostMessage, { readonly kind: "edit" }> =>
      message.kind === "edit",
  );
}

function diagnosticMessages(): Extract<WebviewToHostMessage, { readonly kind: "diagnostic" }>[] {
  return messages.filter(
    (message): message is Extract<WebviewToHostMessage, { readonly kind: "diagnostic" }> =>
      message.kind === "diagnostic",
  );
}

function navigateToHeading(
  overrides: Partial<NavigateToHeadingMessage> = {},
): NavigateToHeadingMessage {
  const message: NavigateToHeadingMessage = {
    kind: "navigate-to-heading",
    protocolVersion: PROTOCOL_VERSION,
    documentUri: "file:///composition.md",
    documentVersion: 1,
    sessionId: "session-a",
    targetOffset: 2,
    highlightFrom: 0,
    highlightTo: 9,
    ...overrides,
  };
  window.dispatchEvent(new MessageEvent("message", { data: message }));
  return message;
}

afterEach((): void => {
  vi.useRealTimers();
  window.dispatchEvent(new Event("unload"));
  document.body.replaceChildren();
  messages.length = 0;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("MarkdownWebviewController Live Preview source integrity", () => {
  it("keeps Copy source-neutral and sends marker-boundary Cut and Paste as one atomic edit each", async () => {
    const source = "# Heading\nplain [link](target.md)\n- item\nnext";
    const { content, view } = await createController(source, "preview");
    const from = source.indexOf("[link");
    const to = source.indexOf("next");
    const afterCut = `${source.slice(0, from)}${source.slice(to)}`;

    view.dispatch({
      selection: { anchor: from, head: to },
      annotations: Transaction.userEvent.of("select.pointer"),
    });
    content.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true }));
    expect(editMessages()).toHaveLength(0);
    expect(diagnosticMessages().some((message) => message.event === "dom.copy")).toBe(true);

    content.dispatchEvent(new ClipboardEvent("cut", { bubbles: true, cancelable: true }));
    expect(diagnosticMessages().some((message) => message.event === "dom.cut")).toBe(true);

    expect(view.state.doc.toString()).toBe(afterCut);
    expect(editMessages()).toEqual([
      expect.objectContaining({
        sequence: 1,
        changes: [expect.objectContaining({ expectedText: source, text: afterCut })],
      }),
    ]);
    const cutTransactions = diagnosticMessages().filter(
      (message) =>
        message.event === "codemirror.transaction" && message.details["userEvent"] === "delete.cut",
    );
    expect(cutTransactions).toHaveLength(1);
    expect(cutTransactions[0]?.details).toMatchObject({ docChanged: true, transactionCount: 1 });

    acknowledge("edit", 1, 2, afterCut);
    const pastedText = "[link](target.md)\n- item\n";
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedText);
    content.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
    expect(diagnosticMessages().some((message) => message.event === "dom.paste")).toBe(true);

    expect(view.state.doc.toString()).toBe(source);
    expect(editMessages()).toHaveLength(2);
    expect(editMessages().at(-1)).toMatchObject({
      sequence: 2,
      changes: [expect.objectContaining({ expectedText: afterCut, text: source })],
    });
    const pasteTransactions = diagnosticMessages().filter(
      (message) =>
        message.event === "codemirror.transaction" &&
        message.details["userEvent"] === "input.paste",
    );
    expect(pasteTransactions).toHaveLength(1);
    expect(pasteTransactions[0]?.details).toMatchObject({ docChanged: true, transactionCount: 1 });
  });

  it("preserves a next-line Markdown link when forward Delete joins the lines", async () => {
    const source = "plain\n[label](target.md)";
    const { content, view } = await createController(source, "preview");
    view.dispatch({ selection: { anchor: "plain".length } });

    expect(
      [...content.querySelectorAll<HTMLElement>(".cm-line")].map((line) => line.textContent),
    ).toEqual(["plain", "label"]);
    const beforeInput = await emulateNativeLineJoin(content, "deleteContentForward");

    expect(view.state.doc.toString()).toBe("plain[label](target.md)");
    expect(beforeInput.defaultPrevented).toBe(true);
    expect(view.state.selection.main).toMatchObject({ anchor: 5, head: 5 });
    expect(editMessages().at(-1)).toMatchObject({
      changes: [
        expect.objectContaining({
          expectedText: source,
          text: "plain[label](target.md)",
        }),
      ],
    });
    expect(editMessages()).toHaveLength(1);

    acknowledge("edit", 1, 2, "plain[label](target.md)");
    expect(dispatchBarrierShortcut(content, "z").defaultPrevented).toBe(true);
    expect(messages.at(-1)).toMatchObject({ kind: "undo", sequence: 2 });
    acknowledge("undo", 2, 3, source);
    expect(view.state.doc.toString()).toBe(source);

    expect(dispatchBarrierShortcut(content, "y").defaultPrevented).toBe(true);
    expect(messages.at(-1)).toMatchObject({ kind: "redo", sequence: 3 });
    acknowledge("redo", 3, 4, "plain[label](target.md)");
    expect(view.state.doc.toString()).toBe("plain[label](target.md)");
  });

  it("preserves the Backspace mirror at the start of a Markdown link", async () => {
    const source = "plain\n[label](target.md)";
    const { content, view } = await createController(source, "preview");
    view.dispatch({ selection: { anchor: "plain\n".length } });

    expect(
      [...content.querySelectorAll<HTMLElement>(".cm-line")].map((line) => line.textContent),
    ).toEqual(["plain", "[label](target.md)"]);
    const beforeInput = await emulateNativeLineJoin(content, "deleteContentBackward");

    expect(beforeInput.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe("plain[label](target.md)");
    expect(view.state.selection.main).toMatchObject({ anchor: 5, head: 5 });
    expect(editMessages()).toHaveLength(1);
  });

  it("leaves a plain-to-plain forward line join on the native path", async () => {
    const source = "first\nsecond";
    const { content, view } = await createController(source, "preview");
    view.dispatch({ selection: { anchor: "first".length } });

    const beforeInput = await emulateNativeLineJoin(content, "deleteContentForward");

    expect(beforeInput.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe("firstsecond");
    expect(view.state.selection.main).toMatchObject({ anchor: 5, head: 5 });
    expect(editMessages()).toHaveLength(1);
  });

  it("does not intercept forward deletion for a non-collapsed selection", async () => {
    const source = "plain\n[label](target.md)";
    const { content, view } = await createController(source, "preview");
    view.dispatch({ selection: { anchor: 4, head: 6 } });

    const beforeInput = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentForward",
    });
    content.dispatchEvent(beforeInput);

    expect(beforeInput.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe(source);
    expect(editMessages()).toHaveLength(0);
  });

  it("does not intercept forward deletion during composition", async () => {
    const source = "plain\n[label](target.md)";
    const { content, view } = await createController(source, "preview");
    view.dispatch({ selection: { anchor: "plain".length } });
    content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    const beforeInput = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentForward",
      isComposing: true,
    });
    content.dispatchEvent(beforeInput);

    expect(beforeInput.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe(source);
    expect(editMessages()).toHaveLength(0);
    content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();
  });
});

describe("MarkdownWebviewController Outline navigation", () => {
  it("moves the caret, scrolls, focuses, and clears a transient source-safe highlight", async () => {
    const source = "# Heading\nbody";
    const { view } = await createController(source);
    vi.useFakeTimers();

    navigateToHeading();

    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.selection.main).toMatchObject({ anchor: 2, head: 2 });
    expect(view.hasFocus).toBe(true);
    expect(document.querySelector(".cm-outline-navigation-highlight")).not.toBeNull();
    expect(editMessages()).toEqual([]);

    vi.advanceTimersByTime(800);
    expect(document.querySelector(".cm-outline-navigation-highlight")).toBeNull();
    expect(view.state.doc.toString()).toBe(source);
    expect(editMessages()).toEqual([]);
    vi.useRealTimers();
  });

  it("rejects stale identity, version, and heading ranges without moving or editing", async () => {
    const source = "# Heading\nbody";
    const { view } = await createController(source);
    const initialSelection = view.state.selection.main.anchor;

    navigateToHeading({ sessionId: "stale-session" });
    navigateToHeading({ documentUri: "file:///other.md" });
    navigateToHeading({ documentVersion: 2 });
    navigateToHeading({ highlightTo: 8 });

    expect(view.state.selection.main.anchor).toBe(initialSelection);
    expect(document.querySelector(".cm-outline-navigation-highlight")).toBeNull();
    expect(view.state.doc.toString()).toBe(source);
    expect(editMessages()).toEqual([]);
  });

  it("rejects navigation while local work or composition is pending", async () => {
    const source = "# Heading\nbody";
    const { content, view } = await createController(source);
    view.dispatch({ changes: { from: source.length, insert: "!" } });
    const selectionAfterEdit = view.state.selection.main.anchor;

    navigateToHeading({ highlightTo: 9 });
    expect(view.state.selection.main.anchor).toBe(selectionAfterEdit);
    expect(document.querySelector(".cm-outline-navigation-highlight")).toBeNull();
    expect(editMessages()).toHaveLength(1);

    acknowledge("edit", 1, 2, `${source}!`);
    content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    navigateToHeading({ documentVersion: 2 });
    expect(view.state.selection.main.anchor).toBe(selectionAfterEdit);
    expect(document.querySelector(".cm-outline-navigation-highlight")).toBeNull();
    content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });

  it("rejects navigation during a Save barrier without creating another operation", async () => {
    const source = "# Heading\nbody";
    const { content, view } = await createController(source);
    const initialSelection = view.state.selection.main.anchor;
    dispatchBarrierShortcut(content, "s");
    expect(messages.at(-1)).toMatchObject({ kind: "save", sequence: 1 });

    navigateToHeading();
    expect(view.state.selection.main.anchor).toBe(initialSelection);
    expect(view.state.doc.toString()).toBe(source);
    expect(messages.filter((message) => message.kind === "save")).toHaveLength(1);
    expect(editMessages()).toEqual([]);
  });

  it("rejects navigation in recovery without changing protected source", async () => {
    const source = "# Heading\nbody";
    const { view } = await createController(source);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "protocol-error", note: "fixture recovery" },
      }),
    );
    const initialSelection = view.state.selection.main.anchor;

    navigateToHeading();
    expect(view.state.selection.main.anchor).toBe(initialSelection);
    expect(view.state.doc.toString()).toBe(source);
    expect(document.querySelector(".cm-outline-navigation-highlight")).toBeNull();
    expect(editMessages()).toEqual([]);
  });

  it("does not let the highlight timer touch a disposed editor", async () => {
    const source = "# Heading\nbody";
    await createController(source);
    vi.useFakeTimers();
    navigateToHeading();
    expect(document.querySelector(".cm-outline-navigation-highlight")).not.toBeNull();

    window.dispatchEvent(new Event("unload"));
    expect((): void => {
      navigateToHeading();
    }).not.toThrow();
    expect((): void => {
      vi.advanceTimersByTime(800);
    }).not.toThrow();
  });
});

describe("MarkdownWebviewController recovery", () => {
  it("adopts the host sequence after controller recreation instead of restarting at one", async () => {
    vi.stubGlobal("acquireVsCodeApi", (): { postMessage(message: PostedMessage): void } => ({
      postMessage(message: PostedMessage): void {
        messages.push(message);
      },
    }));
    document.body.innerHTML = `
      <main id="editor-root"></main>
      <div id="editor-status" hidden></div>
      <script id="markdown-live-editor-bootstrap" type="application/json">
        {"diagnosticMode":"off","documentUri":"file:///composition.md","documentVersion":1,"sessionId":"session-a","nextSequence":1,"text":"old"}
      </script>
    `;

    await import("../../src/webview/editor.js");
    activateLatestController("current", 44, 133);
    const content = document.querySelector<HTMLElement>(".cm-content");
    const view = content === null ? null : EditorView.findFromDOM(content);
    expect(view?.state.doc.toString()).toBe("current");

    view?.dispatch({ changes: { from: 7, insert: "!" } });
    expect(editMessages()).toEqual([
      expect.objectContaining({
        sequence: 133,
        documentVersion: 44,
        changes: [expect.objectContaining({ expectedText: "current", text: "current!" })],
      }),
    ]);
  });

  it("preserves restored unconfirmed local text and selection when host authority differs", async () => {
    const persisted = {
      protocolVersion: PROTOCOL_VERSION,
      documentUri: "file:///composition.md",
      sessionId: "session-a",
      authorityText: "old authority",
      localText: "protected local",
      selectionAnchor: 3,
      selectionHead: 9,
      recoveryActive: false,
    };
    let savedState: unknown;
    vi.stubGlobal(
      "acquireVsCodeApi",
      (): {
        getState(): unknown;
        postMessage(message: PostedMessage): void;
        setState(value: unknown): void;
      } => ({
        getState(): unknown {
          return persisted;
        },
        postMessage(message: PostedMessage): void {
          messages.push(message);
        },
        setState(value: unknown): void {
          savedState = value;
        },
      }),
    );
    document.body.innerHTML = `
      <main id="editor-root"></main>
      <div id="editor-status" hidden></div>
      <script id="markdown-live-editor-bootstrap" type="application/json">
        {"diagnosticMode":"off","documentUri":"file:///composition.md","documentVersion":1,"sessionId":"session-a","nextSequence":1,"text":"bootstrap"}
      </script>
    `;

    await import("../../src/webview/editor.js");
    activateLatestController("host authority", 9, 133);
    const content = document.querySelector<HTMLElement>(".cm-content");
    const view = content === null ? null : EditorView.findFromDOM(content);

    expect(view?.state.doc.toString()).toBe("protected local");
    expect(view?.state.selection.main).toMatchObject({ anchor: 3, head: 9 });
    expect(document.getElementById("editor-status")?.hidden).toBe(false);
    expect(document.getElementById("editor-status")?.textContent).toContain(
      "local text remains visible",
    );
    expect(editMessages()).toHaveLength(0);
    expect(savedState).toMatchObject({
      authorityText: "host authority",
      localText: "protected local",
      recoveryActive: true,
    });
  });

  it("does not send a composition final edit after an external snapshot requires recovery", async () => {
    vi.stubGlobal("acquireVsCodeApi", (): { postMessage(message: PostedMessage): void } => ({
      postMessage(message: PostedMessage): void {
        messages.push(message);
      },
    }));
    document.body.innerHTML = `
      <main id="editor-root"></main>
      <div id="editor-status" hidden></div>
      <script id="markdown-live-editor-bootstrap" type="application/json">
        {"diagnosticMode":"off","documentUri":"file:///composition.md","documentVersion":1,"sessionId":"session-a","nextSequence":1,"text":"- "}
      </script>
    `;

    await import("../../src/webview/editor.js");
    activateLatestController("- ");
    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    content?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const view = content === null ? undefined : EditorView.findFromDOM(content);
    expect(view).toBeDefined();
    view?.dispatch({
      changes: { from: 2, insert: "か" },
      annotations: Transaction.userEvent.of("input.type.compose"),
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "external",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          text: "X",
        },
      }),
    );
    content?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "external",
          documentUri: "file:///composition.md",
          documentVersion: 3,
          text: "Y",
        },
      }),
    );
    content?.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyS",
        ctrlKey: true,
        key: "s",
      }),
    );

    expect(document.getElementById("editor-status")?.hidden).toBe(false);
    expect(view?.state.doc.toString()).toBe("- か");
    expect(
      messages.some(
        (message) =>
          message.kind === "edit" ||
          message.kind === "save" ||
          message.kind === "undo" ||
          message.kind === "redo",
      ),
    ).toBe(false);
    const diagnosticMetadata = messages.filter((message) => message.kind === "diagnostic");
    expect(diagnosticMetadata.some((message) => message.event === "sync.recovery")).toBe(true);
    expect(JSON.stringify(diagnosticMetadata)).not.toContain("- か");
  });

  it("ignores a delayed older document snapshot after acknowledging an edit", async () => {
    vi.stubGlobal("acquireVsCodeApi", (): { postMessage(message: PostedMessage): void } => ({
      postMessage(message: PostedMessage): void {
        messages.push(message);
      },
    }));
    document.body.innerHTML = `
      <main id="editor-root"></main>
      <div id="editor-status" hidden></div>
      <script id="markdown-live-editor-bootstrap" type="application/json">
        {"diagnosticMode":"off","documentUri":"file:///composition.md","documentVersion":1,"sessionId":"session-a","nextSequence":1,"text":"- "}
      </script>
    `;

    await import("../../src/webview/editor.js");
    activateLatestController("- ");
    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = content === null ? undefined : EditorView.findFromDOM(content);
    expect(view).toBeDefined();
    view?.dispatch({ changes: { from: 2, insert: "か" } });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "operation-ack",
          operation: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          sequence: 1,
          text: "- か",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          text: "- か",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 1,
          text: "- ",
        },
      }),
    );
    view?.dispatch({ changes: { from: 3, insert: "き" } });

    const edits = messages.filter(
      (message): message is Extract<WebviewToHostMessage, { readonly kind: "edit" }> =>
        message.kind === "edit",
    );
    expect(edits.at(-1)).toMatchObject({
      sequence: 2,
      documentVersion: 2,
      changes: [{ expectedText: "- か", text: "- かき" }],
    });
    expect(document.getElementById("editor-status")?.hidden).toBe(true);
  });

  it("defers an exact in-flight update until its ACK, then sends one composition final edit", async () => {
    vi.stubGlobal("acquireVsCodeApi", (): { postMessage(message: PostedMessage): void } => ({
      postMessage(message: PostedMessage): void {
        messages.push(message);
      },
    }));
    document.body.innerHTML = `
      <main id="editor-root"></main>
      <div id="editor-status" hidden></div>
      <script id="markdown-live-editor-bootstrap" type="application/json">
        {"diagnosticMode":"off","documentUri":"file:///composition.md","documentVersion":1,"sessionId":"session-a","nextSequence":1,"text":"- "}
      </script>
    `;

    await import("../../src/webview/editor.js");
    activateLatestController("- ");
    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = content === null ? undefined : EditorView.findFromDOM(content);
    expect(view).toBeDefined();
    view?.dispatch({ changes: { from: 2, insert: "a" } });
    content?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view?.dispatch({
      changes: { from: 3, insert: "\u304b" },
      annotations: Transaction.userEvent.of("input.type.compose"),
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          text: "- a",
        },
      }),
    );
    content?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "operation-ack",
          operation: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          sequence: 1,
          text: "- a",
        },
      }),
    );

    const edits = messages.filter(
      (message): message is Extract<WebviewToHostMessage, { readonly kind: "edit" }> =>
        message.kind === "edit",
    );
    expect(edits).toEqual([
      expect.objectContaining({
        sequence: 1,
        documentVersion: 1,
        changes: [expect.objectContaining({ expectedText: "- ", text: "- a" })],
      }),
      expect.objectContaining({
        sequence: 2,
        documentVersion: 2,
        changes: [expect.objectContaining({ expectedText: "- a", text: "- a\u304b" })],
      }),
    ]);
    expect(document.getElementById("editor-status")?.hidden).toBe(true);
    expect(
      JSON.stringify(messages.filter((message) => message.kind === "diagnostic")),
    ).not.toContain("- a\u304b");
  });

  it("uses a deferred newer exact snapshot version after an older matching ACK", async () => {
    const { content, view } = await createController();
    view.dispatch({ changes: { from: 2, insert: "a" } });
    content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch({
      changes: { from: 3, insert: "か" },
      annotations: Transaction.userEvent.of("input.type.compose"),
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 3,
          text: "- a",
        },
      }),
    );
    content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "operation-ack",
          operation: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          sequence: 1,
          text: "- a",
        },
      }),
    );

    expect(editMessages()).toEqual([
      expect.objectContaining({
        sequence: 1,
        documentVersion: 1,
        changes: [expect.objectContaining({ expectedText: "- ", text: "- a" })],
      }),
      expect.objectContaining({
        sequence: 2,
        documentVersion: 3,
        changes: [expect.objectContaining({ expectedText: "- a", text: "- aか" })],
      }),
    ]);
    expect(document.getElementById("editor-status")?.hidden).toBe(true);
  });

  it("treats an edit-reason update with different text as external and suppresses delayed events in recovery", async () => {
    const { view } = await createController();
    view.dispatch({ changes: { from: 2, insert: "a" } });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          text: "different external text",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "operation-ack",
          operation: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          sequence: 1,
          text: "- a",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          text: "- a",
        },
      }),
    );

    expect(document.getElementById("editor-status")?.hidden).toBe(false);
    expect(view.state.doc.toString()).toBe("- a");
    expect(editMessages()).toHaveLength(1);
    expect(diagnosticMessages().some((message) => message.event === "sync.recovery")).toBe(true);
    expect(
      diagnosticMessages().some(
        (message) => message.event === "sync.document.update.ignored-recovery",
      ),
    ).toBe(true);
    expect(JSON.stringify(diagnosticMessages())).not.toContain("different external text");
  });

  it("reports a correlated recovery incident with valid metadata and no source text in off mode", async () => {
    const { content, view } = await createController();
    content.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    view.dispatch({ changes: { from: 2, insert: "confidential-local" } });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "external",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          text: "external-secret",
          correlation: {
            causalId: "cause-17",
            publicationId: "publication-22",
            source: "external-event",
            queueEnqueueOrdinal: 6,
            queueStartOrdinal: 7,
            externalEventId: "external-9",
          },
        },
      }),
    );

    const update = diagnosticMessages().find((message) => message.event === "sync.document.update");
    const recovery = diagnosticMessages().find((message) => message.event === "sync.recovery");
    expect(update?.details).toMatchObject({
      sessionId: "session-a",
      correlationCausalId: "cause-17",
      correlationPublicationId: "publication-22",
      correlationSource: "external-event",
      correlationQueueEnqueueOrdinal: 6,
      correlationQueueStartOrdinal: 7,
      correlationExternalEventId: "external-9",
    });
    expect(recovery?.details).toMatchObject({
      recoveryIncidentId: 1,
      correlationCausalId: "cause-17",
      correlationPublicationId: "publication-22",
      correlationSource: "external-event",
    });
    expect(recovery?.details).not.toHaveProperty("correlationOriginSessionId");
    expect(document.getElementById("editor-status")?.textContent).toContain("[incident 1]");
    const invalidDiagnostic = diagnosticMessages().find(
      (message) => !decodeWebviewToHostMessage(message).ok,
    );
    expect(invalidDiagnostic).toBeUndefined();
    const serialized = JSON.stringify(diagnosticMessages());
    expect(serialized).not.toContain("confidential-local");
    expect(serialized).not.toContain("external-secret");
  });

  it("uses a newer same-text snapshot after ACK as the next edit base version", async () => {
    const { view } = await createController();
    view.dispatch({ changes: { from: 2, insert: "a" } });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "operation-ack",
          operation: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          sequence: 1,
          text: "- a",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "external",
          documentUri: "file:///composition.md",
          documentVersion: 3,
          text: "- a",
        },
      }),
    );
    view.dispatch({ changes: { from: 3, insert: "b" } });

    expect(editMessages().at(-1)).toMatchObject({
      sequence: 2,
      documentVersion: 3,
      changes: [{ expectedText: "- a", text: "- ab" }],
    });
    expect(document.getElementById("editor-status")?.hidden).toBe(true);
  });

  it("keeps a pending local target behind an exact in-flight update until ACK", async () => {
    const { view } = await createController();
    view.dispatch({ changes: { from: 2, insert: "a" } });
    view.dispatch({ changes: { from: 3, insert: "b" } });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 3,
          text: "- a",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "operation-ack",
          operation: "edit",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          sequence: 1,
          text: "- a",
        },
      }),
    );

    expect(editMessages()).toEqual([
      expect.objectContaining({
        sequence: 1,
        documentVersion: 1,
        changes: [expect.objectContaining({ expectedText: "- ", text: "- a" })],
      }),
      expect.objectContaining({
        sequence: 2,
        documentVersion: 3,
        changes: [expect.objectContaining({ expectedText: "- a", text: "- ab" })],
      }),
    ]);
    expect(view.state.doc.toString()).toBe("- ab");
    expect(document.getElementById("editor-status")?.hidden).toBe(true);
    const updateDiagnostic = diagnosticMessages().find(
      (message) => message.event === "sync.document.update",
    );
    expect(updateDiagnostic?.details).toMatchObject({
      currentDocumentVersion: 1,
      matchesAuthority: false,
      matchesInFlightTarget: true,
      matchesPendingTarget: false,
      messageOrdinal: 2,
    });
  });

  it("keeps active composition preedit on an authority-equal newer snapshot and commits once", async () => {
    const { content, view } = await createController();
    content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch({
      changes: { from: 2, insert: "か" },
      annotations: Transaction.userEvent.of("input.type.compose"),
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "external",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          text: "- ",
        },
      }),
    );
    expect(view.state.doc.toString()).toBe("- か");
    expect(editMessages()).toHaveLength(0);
    content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();

    expect(editMessages()).toEqual([
      expect.objectContaining({
        sequence: 1,
        documentVersion: 2,
        changes: [expect.objectContaining({ expectedText: "- ", text: "- か" })],
      }),
    ]);
    expect(document.getElementById("editor-status")?.hidden).toBe(true);
  });

  it("resumes sending only after a matching resync replaces protected recovery text", async () => {
    vi.stubGlobal("acquireVsCodeApi", (): { postMessage(message: PostedMessage): void } => ({
      postMessage(message: PostedMessage): void {
        messages.push(message);
      },
    }));
    document.body.innerHTML = `
      <main id="editor-root"></main>
      <div id="editor-status" hidden></div>
      <script id="markdown-live-editor-bootstrap" type="application/json">
        {"diagnosticMode":"off","documentUri":"file:///composition.md","documentVersion":1,"sessionId":"session-a","nextSequence":1,"text":"- "}
      </script>
    `;

    await import("../../src/webview/editor.js");
    activateLatestController("- ");
    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = content === null ? undefined : EditorView.findFromDOM(content);
    expect(view).toBeDefined();
    content?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view?.dispatch({
      changes: { from: 2, insert: "か" },
      annotations: Transaction.userEvent.of("input.type.compose"),
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "document-update",
          reason: "external",
          documentUri: "file:///composition.md",
          documentVersion: 2,
          text: "X",
        },
      }),
    );
    content?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "resync",
          reason: "change-mismatch",
          documentUri: "file:///composition.md",
          documentVersion: 3,
          nextSequence: 2,
          note: "authoritative text now matches local text",
          text: "- か",
        },
      }),
    );
    view?.dispatch({ changes: { from: 3, insert: "き" } });

    const edits = messages.filter(
      (message): message is Extract<WebviewToHostMessage, { readonly kind: "edit" }> =>
        message.kind === "edit",
    );
    expect(edits).toEqual([
      expect.objectContaining({
        sequence: 2,
        documentVersion: 3,
        changes: [expect.objectContaining({ expectedText: "- か", text: "- かき" })],
      }),
    ]);
  });
});
