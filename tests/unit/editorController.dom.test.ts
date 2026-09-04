// @vitest-environment happy-dom

import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebviewToHostMessage } from "../../src/protocol/messages.js";

const messages: WebviewToHostMessage[] = [];

async function createController(): Promise<{
  readonly content: HTMLElement;
  readonly view: EditorView;
}> {
  vi.stubGlobal("acquireVsCodeApi", (): { postMessage(message: WebviewToHostMessage): void } => ({
    postMessage(message: WebviewToHostMessage): void {
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

afterEach((): void => {
  window.dispatchEvent(new Event("unload"));
  document.body.replaceChildren();
  messages.length = 0;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("MarkdownWebviewController recovery", () => {
  it("does not send a composition final edit after an external snapshot requires recovery", async () => {
    vi.stubGlobal("acquireVsCodeApi", (): { postMessage(message: WebviewToHostMessage): void } => ({
      postMessage(message: WebviewToHostMessage): void {
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
    vi.stubGlobal("acquireVsCodeApi", (): { postMessage(message: WebviewToHostMessage): void } => ({
      postMessage(message: WebviewToHostMessage): void {
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
    vi.stubGlobal("acquireVsCodeApi", (): { postMessage(message: WebviewToHostMessage): void } => ({
      postMessage(message: WebviewToHostMessage): void {
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
      messageOrdinal: 1,
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
    vi.stubGlobal("acquireVsCodeApi", (): { postMessage(message: WebviewToHostMessage): void } => ({
      postMessage(message: WebviewToHostMessage): void {
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
