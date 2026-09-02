import { markdown } from "@codemirror/lang-markdown";
import {
  Annotation,
  Compartment,
  EditorState,
  Prec,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap, type KeyBinding, type ViewUpdate } from "@codemirror/view";

import {
  recordsDiagnosticTrace,
  usesBarrierKeymap,
  usesDocumentSync,
  usesLivePreview,
  usesMarkdownLanguage,
  type DiagnosticMode,
} from "../core/diagnostics/diagnosticMode.js";
import {
  PROTOCOL_VERSION,
  decodeHostToWebviewMessage,
  type DocumentSnapshotMessage,
  type HostToWebviewMessage,
  type WebviewToHostMessage,
  type WirePosition,
} from "../protocol/messages.js";
import {
  createLivePreviewEngine,
  type LivePreviewEngine,
} from "./livePreview/LivePreviewEngine.js";

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
}

interface WebviewBootstrap {
  readonly diagnosticMode: DiagnosticMode;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly sessionId: string;
  readonly nextSequence: number;
  readonly text: string;
}

declare function acquireVsCodeApi(): VsCodeApi;

const remoteUpdate = Annotation.define<boolean>();

const vscodeEditorTheme = EditorView.theme({
  ".cm-content": {
    caretColor: "var(--vscode-editorCursor-foreground)",
  },
  "&.cm-focused .cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--vscode-editorCursor-foreground)",
  },
});

class MarkdownWebviewController {
  private readonly editable = new Compartment();
  private readonly livePreview: LivePreviewEngine | undefined;
  private readonly diagnostics: DiagnosticTrace;
  private readonly view: EditorView;
  private authoritativeText: string;
  private documentVersion: number;
  private nextSequence: number;
  private inFlightSequence: number | undefined;
  private barrierInFlightSequence: number | undefined;
  private readonly barrierQueue: ("save" | "undo" | "redo")[] = [];
  private hasPendingLocalChanges = false;
  private disposed = false;

  public constructor(
    private readonly vscode: VsCodeApi,
    private readonly bootstrap: WebviewBootstrap,
    private readonly statusElement: HTMLElement,
    parent: HTMLElement,
  ) {
    this.authoritativeText = bootstrap.text;
    this.documentVersion = bootstrap.documentVersion;
    this.nextSequence = bootstrap.nextSequence;
    this.diagnostics = createDiagnosticTrace(bootstrap.diagnosticMode);
    this.livePreview = usesLivePreview(bootstrap.diagnosticMode)
      ? createLivePreviewEngine()
      : undefined;
    const extensions: Extension[] = [
      vscodeEditorTheme,
      this.editable.of(EditorView.editable.of(true)),
      EditorView.updateListener.of((update): void => {
        this.handleUpdate(update);
      }),
    ];
    if (usesMarkdownLanguage(bootstrap.diagnosticMode)) {
      extensions.unshift(markdown());
    }
    if (this.livePreview !== undefined) {
      extensions.push(this.livePreview.extension);
    }
    if (usesBarrierKeymap(bootstrap.diagnosticMode)) {
      extensions.push(
        Prec.highest(
          keymap.of(
            createBarrierKeymap((action): void => {
              this.requestBarrier(action);
            }),
          ),
        ),
      );
    }
    if (recordsDiagnosticTrace(bootstrap.diagnosticMode)) {
      extensions.push(createDiagnosticDomEventTrace(this.diagnostics));
    }
    this.view = new EditorView({
      state: EditorState.create({
        doc: bootstrap.text,
        extensions,
      }),
      parent,
    });
    this.diagnostics.record("diagnostic.mode", {
      mode: bootstrap.diagnosticMode,
      documentSync: usesDocumentSync(bootstrap.diagnosticMode),
      livePreview: usesLivePreview(bootstrap.diagnosticMode),
      markdown: usesMarkdownLanguage(bootstrap.diagnosticMode),
      barrierKeymap: usesBarrierKeymap(bootstrap.diagnosticMode),
    });
  }

  public receive(value: unknown): void {
    if (this.disposed) {
      return;
    }

    this.diagnostics.record("host.message.received", messageSummary(value));
    const decoded = decodeHostToWebviewMessage(value);
    if (!decoded.ok) {
      this.enterRecovery(`Invalid host message: ${decoded.error}`);
      return;
    }

    this.handleHostMessage(decoded.value);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.view.destroy();
    this.livePreview?.dispose();
  }

  private handleUpdate(update: ViewUpdate): void {
    this.traceCodeMirrorUpdate(update);
    if (
      !update.docChanged ||
      this.disposed ||
      update.transactions.some((transaction) => transaction.annotation(remoteUpdate) === true) ||
      !usesDocumentSync(this.bootstrap.diagnosticMode)
    ) {
      return;
    }

    this.hasPendingLocalChanges = true;
    this.diagnostics.record("sync.edit.pending", {
      forwarded: true,
      composing: update.view.composing,
      compositionStarted: update.view.compositionStarted,
      text: textPreview(this.view.state.doc.toString()),
    });
    this.sendPendingEdit();
  }

  private sendPendingEdit(): void {
    if (this.inFlightSequence !== undefined || !this.hasPendingLocalChanges || this.disposed) {
      return;
    }

    const text = this.view.state.doc.toString();
    if (text === this.authoritativeText) {
      this.hasPendingLocalChanges = false;
      return;
    }

    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.inFlightSequence = sequence;
    this.hasPendingLocalChanges = false;
    const message: WebviewToHostMessage = {
      kind: "edit",
      protocolVersion: PROTOCOL_VERSION,
      documentUri: this.bootstrap.documentUri,
      sessionId: this.bootstrap.sessionId,
      sequence,
      documentVersion: this.documentVersion,
      changes: [fullDocumentReplacement(this.authoritativeText, text)],
    };
    this.diagnostics.record("sync.edit.sent", {
      sequence,
      documentVersion: this.documentVersion,
      composing: this.view.composing,
      compositionStarted: this.view.compositionStarted,
      expectedText: textPreview(this.authoritativeText),
      text: textPreview(text),
    });
    this.vscode.postMessage(message);
  }

  private requestBarrier(action: "save" | "undo" | "redo"): void {
    if (this.disposed) {
      return;
    }

    // Freeze before queueing the barrier so an edit made after the command
    // cannot overtake it. The host still supplies the authoritative result.
    this.diagnostics.record("sync.barrier.requested", {
      action,
      composing: this.view.composing,
      compositionStarted: this.view.compositionStarted,
      inFlightSequence: this.inFlightSequence,
      pendingLocalChanges: this.hasPendingLocalChanges,
    });
    this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(false)) });
    this.barrierQueue.push(action);
    this.sendPendingEdit();
    this.sendNextBarrier();
  }

  private handleHostMessage(message: HostToWebviewMessage): void {
    switch (message.kind) {
      case "operation-ack":
        this.handleAcknowledgement(message);
        return;
      case "document-update":
        this.handleDocumentUpdate(message);
        return;
      case "resync":
        this.documentVersion = message.documentVersion;
        this.nextSequence = message.nextSequence;
        this.inFlightSequence = undefined;
        this.barrierInFlightSequence = undefined;
        this.barrierQueue.length = 0;
        this.hasPendingLocalChanges = false;
        if (this.view.state.doc.toString() === this.authoritativeText) {
          this.applyAuthoritativeSnapshot(message);
          this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(true)) });
          this.showStatus(`Resynchronized after ${message.reason}: ${message.note}`);
        } else {
          this.authoritativeText = message.text;
          this.enterRecovery(
            `Resynchronization is required after ${message.reason}; local text remains visible: ${message.note}`,
          );
        }
        return;
      case "protocol-error":
        this.enterRecovery(message.note);
        return;
    }
  }

  private handleAcknowledgement(
    message: Extract<HostToWebviewMessage, { kind: "operation-ack" }>,
  ): void {
    this.diagnostics.record("sync.operation.ack", {
      operation: message.operation,
      sequence: message.sequence,
      documentVersion: message.documentVersion,
      text: textPreview(message.text),
    });
    this.documentVersion = message.documentVersion;
    if (message.operation === "edit" && message.sequence === this.inFlightSequence) {
      this.inFlightSequence = undefined;
      this.authoritativeText = message.text;
      if (this.hasPendingLocalChanges) {
        this.sendPendingEdit();
      } else {
        this.sendNextBarrier();
      }
      return;
    }

    this.applyAuthoritativeSnapshot(message);
    if (message.sequence === this.barrierInFlightSequence) {
      this.barrierInFlightSequence = undefined;
      this.barrierQueue.shift();
      this.sendNextBarrier();
    }
  }

  private handleDocumentUpdate(
    message: Extract<HostToWebviewMessage, { kind: "document-update" }>,
  ): void {
    this.diagnostics.record("sync.document.update", {
      reason: message.reason,
      documentVersion: message.documentVersion,
      text: textPreview(message.text),
      inFlightSequence: this.inFlightSequence,
      pendingLocalChanges: this.hasPendingLocalChanges,
    });
    this.documentVersion = message.documentVersion;
    if (message.text === this.authoritativeText) {
      return;
    }
    if (this.inFlightSequence !== undefined || this.hasPendingLocalChanges) {
      this.enterRecovery(
        "The document changed outside this webview while local edits were pending.",
      );
      return;
    }
    this.applyAuthoritativeSnapshot(message);
  }

  private applyAuthoritativeSnapshot(snapshot: DocumentSnapshotMessage): void {
    this.authoritativeText = snapshot.text;
    if (this.view.state.doc.toString() === snapshot.text) {
      return;
    }
    this.diagnostics.record("sync.authority.applied", {
      documentVersion: snapshot.documentVersion,
      before: textPreview(this.view.state.doc.toString()),
      after: textPreview(snapshot.text),
    });
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: snapshot.text },
      annotations: remoteUpdate.of(true),
    });
  }

  private enterRecovery(note: string): void {
    this.diagnostics.record("sync.recovery", { note });
    this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(false)) });
    this.showStatus(`Editing paused to protect unsynchronized text: ${note}`);
  }

  private sendNextBarrier(): void {
    const action = this.barrierQueue[0];
    if (action === undefined) {
      if (this.barrierInFlightSequence === undefined) {
        this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(true)) });
      }
      return;
    }
    if (
      this.inFlightSequence !== undefined ||
      this.barrierInFlightSequence !== undefined ||
      this.hasPendingLocalChanges ||
      this.disposed
    ) {
      return;
    }

    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.barrierInFlightSequence = sequence;
    const message: WebviewToHostMessage = {
      kind: action,
      protocolVersion: PROTOCOL_VERSION,
      documentUri: this.bootstrap.documentUri,
      sessionId: this.bootstrap.sessionId,
      sequence,
    };
    this.diagnostics.record("sync.barrier.sent", {
      action,
      sequence,
      documentVersion: this.documentVersion,
      composing: this.view.composing,
    });
    this.vscode.postMessage(message);
  }

  private showStatus(note: string): void {
    this.statusElement.textContent = note;
    this.statusElement.hidden = false;
  }

  private traceCodeMirrorUpdate(update: ViewUpdate): void {
    if (!recordsDiagnosticTrace(this.bootstrap.diagnosticMode)) {
      return;
    }
    for (const transaction of update.transactions) {
      const selection = transaction.state.selection.main;
      this.diagnostics.record("codemirror.transaction", {
        docChanged: transaction.docChanged,
        userEvent: transaction.annotation(Transaction.userEvent) ?? "",
        remote: transaction.annotation(remoteUpdate) === true,
        composing: update.view.composing,
        compositionStarted: update.view.compositionStarted,
        transactionCount: update.transactions.length,
        before: textPreview(transaction.startState.doc.toString()),
        after: textPreview(transaction.state.doc.toString()),
        selection: `${String(selection.from)}:${String(selection.to)}`,
      });
    }
  }
}

function createBarrierKeymap(
  requestBarrier: (action: "save" | "undo" | "redo") => void,
): readonly KeyBinding[] {
  const request =
    (action: "save" | "undo" | "redo"): (() => boolean) =>
    () => {
      requestBarrier(action);
      return true;
    };
  return [
    { key: "Mod-s", preventDefault: true, run: request("save") },
    { key: "Mod-z", preventDefault: true, run: request("undo") },
    { key: "Mod-y", preventDefault: true, run: request("redo") },
    { key: "Mod-Shift-z", preventDefault: true, run: request("redo") },
  ];
}

function fullDocumentReplacement(
  expectedText: string,
  text: string,
): {
  readonly range: { readonly start: WirePosition; readonly end: WirePosition };
  readonly expectedText: string;
  readonly text: string;
} {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: offsetToPosition(expectedText, expectedText.length),
    },
    expectedText,
    text,
  };
}

function offsetToPosition(text: string, offset: number): WirePosition {
  const beforeOffset = text.slice(0, offset);
  const lastNewline = beforeOffset.lastIndexOf("\n");
  return {
    line: lastNewline === -1 ? 0 : beforeOffset.split("\n").length - 1,
    character: offset - lastNewline - 1,
  };
}

function readBootstrap(): WebviewBootstrap {
  const element = document.getElementById("markdown-live-editor-bootstrap");
  if (element === null) {
    throw new Error("The editor bootstrap data is missing.");
  }
  const value: unknown = JSON.parse(element.textContent);
  if (!isBootstrap(value)) {
    throw new Error("The editor bootstrap data is invalid.");
  }
  return value;
}

function isBootstrap(value: unknown): value is WebviewBootstrap {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isDiagnosticMode(value["diagnosticMode"]) &&
    typeof value["documentUri"] === "string" &&
    typeof value["sessionId"] === "string" &&
    typeof value["text"] === "string" &&
    Number.isSafeInteger(value["documentVersion"]) &&
    typeof value["documentVersion"] === "number" &&
    value["documentVersion"] >= 0 &&
    Number.isSafeInteger(value["nextSequence"]) &&
    typeof value["nextSequence"] === "number" &&
    value["nextSequence"] >= 0
  );
}

function isDiagnosticMode(value: unknown): value is DiagnosticMode {
  return (
    typeof value === "string" &&
    (value === "off" ||
      value === "raw-cm6" ||
      value === "markdown" ||
      value === "sync" ||
      value === "preview")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type TraceValue = boolean | number | string | undefined;

interface DiagnosticTrace {
  record(kind: string, details: Readonly<Record<string, TraceValue>>): void;
}

const disabledDiagnosticTrace: DiagnosticTrace = {
  record: (): void => undefined,
};

class OnPageDiagnosticTrace implements DiagnosticTrace {
  private readonly lines: string[] = [];

  public constructor(private readonly element: HTMLElement) {}

  public record(kind: string, details: Readonly<Record<string, TraceValue>>): void {
    const timestamp = String(Date.now());
    const serialized = Object.entries(details)
      .map(([key, value]): string => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    this.lines.push(`${timestamp} ${kind}${serialized === "" ? "" : ` ${serialized}`}`);
    if (this.lines.length > 250) {
      this.lines.shift();
    }
    this.element.textContent = this.lines.join("\n");
    this.element.scrollTop = this.element.scrollHeight;
  }
}

function createDiagnosticTrace(mode: DiagnosticMode): DiagnosticTrace {
  if (!recordsDiagnosticTrace(mode)) {
    return disabledDiagnosticTrace;
  }
  const element = document.getElementById("editor-diagnostics");
  if (element === null) {
    throw new Error("Development diagnostic trace output is missing.");
  }
  return new OnPageDiagnosticTrace(element);
}

function createDiagnosticDomEventTrace(trace: DiagnosticTrace): Extension {
  return EditorView.domEventHandlers({
    compositionstart: (event): boolean => {
      traceCompositionEvent(trace, "compositionstart", event);
      return false;
    },
    compositionupdate: (event): boolean => {
      traceCompositionEvent(trace, "compositionupdate", event);
      return false;
    },
    compositionend: (event): boolean => {
      traceCompositionEvent(trace, "compositionend", event);
      return false;
    },
    beforeinput: (event): boolean => {
      traceInputEvent(trace, "beforeinput", event);
      return false;
    },
    input: (event): boolean => {
      traceInputEvent(trace, "input", event);
      return false;
    },
    keydown: (event): boolean => {
      traceKeyboardEvent(trace, "keydown", event);
      return false;
    },
    keyup: (event): boolean => {
      traceKeyboardEvent(trace, "keyup", event);
      return false;
    },
  });
}

function traceCompositionEvent(
  trace: DiagnosticTrace,
  kind: string,
  event: CompositionEvent,
): void {
  trace.record(`dom.${kind}`, { data: event.data, isComposing: eventIsComposing(event) });
}

function traceInputEvent(trace: DiagnosticTrace, kind: string, event: InputEvent): void {
  trace.record(`dom.${kind}`, {
    data: event.data ?? "",
    inputType: event.inputType,
    isComposing: event.isComposing,
  });
}

function traceKeyboardEvent(trace: DiagnosticTrace, kind: string, event: KeyboardEvent): void {
  trace.record(`dom.${kind}`, {
    code: event.code,
    isComposing: event.isComposing,
    key: event.key,
    repeat: event.repeat,
  });
}

function eventIsComposing(event: Event): boolean {
  const value = Reflect.get(event, "isComposing") as unknown;
  return typeof value === "boolean" && value;
}

function messageSummary(value: unknown): Readonly<Record<string, TraceValue>> {
  if (!isRecord(value)) {
    return { kind: "invalid" };
  }
  return {
    documentVersion:
      typeof value["documentVersion"] === "number" ? value["documentVersion"] : undefined,
    kind: typeof value["kind"] === "string" ? value["kind"] : "invalid",
    operation: typeof value["operation"] === "string" ? value["operation"] : undefined,
    reason: typeof value["reason"] === "string" ? value["reason"] : undefined,
    sequence: typeof value["sequence"] === "number" ? value["sequence"] : undefined,
  };
}

function textPreview(text: string): string {
  const maximumLength = 160;
  return text.length <= maximumLength ? text : `${text.slice(0, maximumLength)}…`;
}

const root = document.getElementById("editor-root");
const status = document.getElementById("editor-status");
if (root === null || status === null) {
  throw new Error("The editor webview root is missing.");
}

const controller = new MarkdownWebviewController(acquireVsCodeApi(), readBootstrap(), status, root);
window.addEventListener("message", (event: MessageEvent<unknown>): void => {
  controller.receive(event.data);
});
window.addEventListener("unload", (): void => {
  controller.dispose();
});
