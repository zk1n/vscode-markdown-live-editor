import { markdown } from "@codemirror/lang-markdown";
import {
  Annotation,
  Compartment,
  EditorState,
  Prec,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";

import { minimalTextReplacement } from "../core/sync/textReplacement.js";
import { textFingerprint } from "../core/diagnostics/textFingerprint.js";
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
import { BarrierInputGate, type BarrierAction } from "./barrierInputGate.js";
import { createBarrierKeymap } from "./barrierKeymap.js";
import { CompositionBuffer } from "./compositionBuffer.js";
import { PendingEditQueue } from "./pendingEditQueue.js";

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
  private readonly pendingEdits: PendingEditQueue;
  private documentVersion: number;
  private nextSequence: number;
  private inFlightSequence: number | undefined;
  private readonly barriers = new BarrierInputGate();
  private readonly composition = new CompositionBuffer();
  private compositionGeneration = 0;
  private compositionEndObserved = false;
  private nextShortcutAttempt = 1;
  private recoveryActive = false;
  private disposed = false;

  public constructor(
    private readonly vscode: VsCodeApi,
    private readonly bootstrap: WebviewBootstrap,
    private readonly statusElement: HTMLElement,
    parent: HTMLElement,
  ) {
    this.pendingEdits = new PendingEditQueue(bootstrap.text);
    this.documentVersion = bootstrap.documentVersion;
    this.nextSequence = bootstrap.nextSequence;
    this.diagnostics = createDiagnosticTrace(bootstrap.diagnosticMode, (event, details): void => {
      this.vscode.postMessage({
        kind: "diagnostic",
        documentUri: bootstrap.documentUri,
        sessionId: bootstrap.sessionId,
        event,
        details: details as Readonly<Record<string, boolean | number | string>>,
      });
    });
    this.livePreview = usesLivePreview(bootstrap.diagnosticMode)
      ? createLivePreviewEngine()
      : undefined;
    const extensions: Extension[] = [
      vscodeEditorTheme,
      this.editable.of(EditorView.editable.of(true)),
      EditorView.updateListener.of((update): void => {
        this.handleUpdate(update);
      }),
      EditorState.transactionFilter.of((transaction) => this.filterBarrierInput(transaction)),
      createCompositionLifecycleHandlers(
        (): void => {
          this.handleCompositionStart();
        },
        (): void => {
          this.handleCompositionEnd();
        },
        (kind): void => {
          this.recordFocusEvent(kind);
        },
      ),
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
    extensions.push(createDiagnosticDomEventTrace(this.diagnostics));
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

    if (this.isCompositionUpdate(update) || this.composition.isActive) {
      const compositionTransaction = update.transactions.find(
        (transaction) => transaction.docChanged,
      );
      this.beginComposition(compositionTransaction?.startState.doc.toString());
      this.composition.update(this.view.state.doc.toString());
      this.diagnostics.record("sync.composition.buffered", {
        composing: update.view.composing,
        compositionStarted: update.view.compositionStarted,
        textFingerprint: textFingerprint(this.view.state.doc.toString()),
      });
      return;
    }

    this.queuePendingEdit(this.view.state.doc.toString());
    this.diagnostics.record("sync.edit.pending", {
      forwarded: true,
      composing: update.view.composing,
      compositionStarted: update.view.compositionStarted,
      textFingerprint: textFingerprint(this.view.state.doc.toString()),
    });
  }

  private filterBarrierInput(transaction: Transaction): Transaction | readonly Transaction[] {
    if (
      !transaction.docChanged ||
      transaction.annotation(remoteUpdate) === true ||
      this.barriers.acceptsLocalTransaction(
        this.composition.isActive ? this.compositionGeneration : undefined,
      )
    ) {
      if (transaction.docChanged && transaction.annotation(remoteUpdate) !== true) {
        this.diagnostics.record("sync.barrier.input-accepted", {
          reason: this.composition.isActive ? "active-composition" : "not-frozen",
          ...this.focusTraceDetails(),
        });
      }
      return transaction;
    }
    this.diagnostics.record("sync.barrier.input-blocked", {
      reason: "post-barrier-non-composition",
      ...this.focusTraceDetails(),
    });
    return [];
  }

  private isCompositionUpdate(update: ViewUpdate): boolean {
    return (
      update.view.composing ||
      update.view.compositionStarted ||
      update.transactions.some((transaction) => {
        const userEvent = transaction.annotation(Transaction.userEvent);
        return userEvent?.startsWith("input.type.compose") === true;
      })
    );
  }

  private beginComposition(baseText: string | undefined): void {
    if (this.composition.isActive) {
      return;
    }
    const localBase = baseText ?? this.view.state.doc.toString();
    this.composition.begin(this.documentVersion, localBase);
    this.compositionGeneration += 1;
    this.compositionEndObserved = false;
    this.diagnostics.record("sync.composition.started", {
      baseDocumentVersion: this.documentVersion,
      baseTextFingerprint: textFingerprint(localBase),
      ...this.focusTraceDetails(),
    });
    if (localBase !== this.pendingEdits.authority) {
      // The first composition transaction may already have changed EditorView.
      // Commit the captured pre-composition base, never that mutable current text.
      this.queuePendingEdit(localBase);
    }
  }

  private handleCompositionStart(): void {
    if (this.disposed || !usesDocumentSync(this.bootstrap.diagnosticMode)) {
      return;
    }
    this.beginComposition(undefined);
  }

  private handleCompositionEnd(): void {
    if (this.disposed || !this.composition.isActive) {
      return;
    }
    this.compositionEndObserved = true;
    this.diagnostics.record("sync.composition.end-observed", this.focusTraceDetails());
    queueMicrotask((): void => {
      this.finalizeCompositionIfSafe();
    });
  }

  private finalizeCompositionIfSafe(): void {
    if (this.disposed || !this.composition.isActive || !this.compositionEndObserved) {
      return;
    }
    if (this.inFlightSequence !== undefined || this.pendingEdits.hasPending) {
      return;
    }

    const commit = this.composition.finish(this.view.state.doc.toString());
    this.compositionEndObserved = false;
    if (commit === undefined) {
      return;
    }
    if (this.pendingEdits.authority !== commit.baseText) {
      this.enterRecovery(
        "Authority changed while an IME composition was buffered; local composition remains visible.",
      );
      return;
    }
    if (commit.finalText === commit.baseText) {
      this.diagnostics.record("sync.composition.empty", {
        baseDocumentVersion: commit.baseDocumentVersion,
        ...this.focusTraceDetails(),
      });
      this.sendNextBarrier();
      return;
    }

    this.diagnostics.record("sync.composition.commit-ready", {
      baseDocumentVersion: commit.baseDocumentVersion,
      documentVersion: this.documentVersion,
      baseTextFingerprint: textFingerprint(commit.baseText),
      finalTextFingerprint: textFingerprint(commit.finalText),
      ...this.focusTraceDetails(),
    });
    this.queuePendingEdit(commit.finalText);
  }

  private queuePendingEdit(targetText: string): void {
    this.pendingEdits.queue(targetText);
    this.sendPendingEdit();
  }

  private sendPendingEdit(): void {
    if (this.inFlightSequence !== undefined || this.recoveryActive || this.disposed) {
      return;
    }

    const text = this.pendingEdits.takeNext();
    if (text === undefined) {
      return;
    }

    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.inFlightSequence = sequence;
    const message: WebviewToHostMessage = {
      kind: "edit",
      protocolVersion: PROTOCOL_VERSION,
      documentUri: this.bootstrap.documentUri,
      sessionId: this.bootstrap.sessionId,
      sequence,
      documentVersion: this.documentVersion,
      changes: [fullDocumentReplacement(this.pendingEdits.authority, text)],
    };
    this.diagnostics.record("sync.edit.sent", {
      sequence,
      documentVersion: this.documentVersion,
      composing: this.view.composing,
      compositionStarted: this.view.compositionStarted,
      expectedTextFingerprint: textFingerprint(this.pendingEdits.authority),
      inFlightTargetFingerprint: textFingerprint(this.pendingEdits.inFlightTarget ?? ""),
      pendingTargetFingerprint: textFingerprint(this.pendingEdits.pendingTarget ?? ""),
      textFingerprint: textFingerprint(text),
    });
    this.vscode.postMessage(message);
  }

  private requestBarrier(action: BarrierAction): void {
    if (this.recoveryActive || this.disposed) {
      return;
    }

    // Freeze before queueing the barrier so an edit made after the command
    // cannot overtake it. The host still supplies the authoritative result.
    const shortcutAttemptId = `shortcut-${String(this.nextShortcutAttempt)}`;
    this.nextShortcutAttempt += 1;
    this.diagnostics.record("shortcut.keymap.handled", {
      action,
      owner: "webview-keymap",
      shortcutAttemptId,
    });
    this.diagnostics.record("sync.barrier.requested", {
      action,
      shortcutAttemptId,
      composing: this.view.composing,
      compositionStarted: this.view.compositionStarted,
      inFlightSequence: this.inFlightSequence,
      pendingLocalChanges: this.pendingEdits.hasPending,
      compositionActive: this.composition.isActive,
      ...this.focusTraceDetails(),
    });
    // Do not change contenteditable for a normal barrier: it can blur the
    // content DOM. The transaction filter preserves FIFO without remounting or
    // replacing the editor's focusable surface.
    this.barriers.enqueue(
      action,
      this.composition.isActive ? this.compositionGeneration : undefined,
      shortcutAttemptId,
    );
    this.sendPendingEdit();
    this.sendNextBarrier();
    this.assertBarrierLiveness();
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
        this.barriers.reset();
        this.pendingEdits.reset(message.text);
        this.composition.abandon();
        this.compositionEndObserved = false;
        if (this.view.state.doc.toString() === this.pendingEdits.authority) {
          this.applyAuthoritativeSnapshot(message);
          this.recoveryActive = false;
          this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(true)) });
          this.showStatus(`Resynchronized after ${message.reason}: ${message.note}`);
        } else {
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
      textFingerprint: textFingerprint(message.text),
    });
    if (this.recoveryActive) {
      return;
    }
    if (message.documentVersion < this.documentVersion) {
      if (message.operation === "edit" && message.sequence === this.inFlightSequence) {
        this.enterRecovery(
          "An edit acknowledgement was older than the current authoritative document version.",
        );
        return;
      }
      this.diagnostics.record("sync.operation.ack.ignored-stale", {
        sequence: message.sequence,
        documentVersion: message.documentVersion,
        currentDocumentVersion: this.documentVersion,
      });
      return;
    }
    if (message.operation === "edit" && message.sequence === this.inFlightSequence) {
      this.inFlightSequence = undefined;
      this.pendingEdits.acknowledge(message.text);
      this.documentVersion = message.documentVersion;
      this.sendPendingEdit();
      if (this.composition.isActive) {
        this.finalizeCompositionIfSafe();
      } else {
        this.sendNextBarrier();
      }
      this.assertBarrierLiveness();
      return;
    }

    this.applyAuthoritativeSnapshot(message);
    if (this.barriers.acknowledgeBarrier(message.sequence)) {
      this.sendNextBarrier();
    }
    this.assertBarrierLiveness();
  }

  private handleDocumentUpdate(
    message: Extract<HostToWebviewMessage, { kind: "document-update" }>,
  ): void {
    this.diagnostics.record("sync.document.update", {
      reason: message.reason,
      documentVersion: message.documentVersion,
      textFingerprint: textFingerprint(message.text),
      inFlightSequence: this.inFlightSequence,
      pendingLocalChanges: this.pendingEdits.hasPending,
      compositionActive: this.composition.isActive,
      ...this.focusTraceDetails(),
    });
    if (this.recoveryActive) {
      this.diagnostics.record("sync.document.update.ignored-recovery", {
        reason: message.reason,
        documentVersion: message.documentVersion,
        textFingerprint: textFingerprint(message.text),
      });
      return;
    }
    if (message.documentVersion < this.documentVersion) {
      this.diagnostics.record("sync.document.update.ignored-stale", {
        reason: message.reason,
        documentVersion: message.documentVersion,
        currentDocumentVersion: this.documentVersion,
        textFingerprint: textFingerprint(message.text),
      });
      return;
    }
    if (message.text === this.pendingEdits.authority) {
      this.documentVersion = message.documentVersion;
      return;
    }
    if (
      this.inFlightSequence !== undefined ||
      this.pendingEdits.hasPending ||
      this.composition.isActive
    ) {
      this.enterRecovery(
        "The document changed outside this webview while local edits were pending.",
      );
      return;
    }
    this.applyAuthoritativeSnapshot(message);
    this.assertBarrierLiveness();
  }

  private applyAuthoritativeSnapshot(snapshot: DocumentSnapshotMessage): void {
    this.documentVersion = snapshot.documentVersion;
    this.pendingEdits.replaceAuthority(snapshot.text);
    const before = this.view.state.doc.toString();
    const replacement = minimalTextReplacement(before, snapshot.text);
    if (replacement === undefined) {
      return;
    }
    this.diagnostics.record("sync.authority.applied", {
      documentVersion: snapshot.documentVersion,
      beforeFingerprint: textFingerprint(before),
      afterFingerprint: textFingerprint(snapshot.text),
      from: replacement.from,
      to: replacement.to,
      ...this.focusTraceDetails(),
    });
    this.view.dispatch({
      changes: replacement,
      annotations: remoteUpdate.of(true),
    });
  }

  private enterRecovery(note: string): void {
    this.diagnostics.record("sync.recovery", { note });
    this.recoveryActive = true;
    this.barriers.reset();
    this.composition.abandon();
    this.compositionEndObserved = false;
    this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(false)) });
    this.showStatus(`Editing paused to protect unsynchronized text: ${note}`);
  }

  private sendNextBarrier(): void {
    const request = this.barriers.nextRequest;
    if (request === undefined) {
      if (this.barriers.completeIfIdle()) {
        this.diagnostics.record("sync.barrier.completed", this.focusTraceDetails());
      }
      return;
    }
    if (
      this.inFlightSequence !== undefined ||
      this.barriers.barrierInFlightSequence !== undefined ||
      this.pendingEdits.hasPending ||
      this.composition.isActive ||
      this.recoveryActive ||
      this.disposed
    ) {
      return;
    }

    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.barriers.markBarrierSent(sequence);
    const message: WebviewToHostMessage = {
      kind: request.action,
      protocolVersion: PROTOCOL_VERSION,
      documentUri: this.bootstrap.documentUri,
      sessionId: this.bootstrap.sessionId,
      sequence,
      shortcutAttemptId: request.shortcutAttemptId,
    };
    this.diagnostics.record("sync.barrier.sent", {
      action: request.action,
      sequence,
      shortcutAttemptId: request.shortcutAttemptId,
      documentVersion: this.documentVersion,
      composing: this.view.composing,
      ...this.focusTraceDetails(),
    });
    this.vscode.postMessage(message);
  }

  private assertBarrierLiveness(): void {
    if (
      this.barriers.hasDeterministicProgress(
        this.composition.isActive,
        this.inFlightSequence !== undefined,
      )
    ) {
      return;
    }
    this.enterRecovery(
      "Save barrier lost its completion path; editing is disabled to prevent silent input loss.",
    );
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
        beforeFingerprint: textFingerprint(transaction.startState.doc.toString()),
        afterFingerprint: textFingerprint(transaction.state.doc.toString()),
        selection: `${String(selection.from)}:${String(selection.to)}`,
        ...this.focusTraceDetails(),
      });
    }
  }

  private recordFocusEvent(kind: "focus" | "blur"): void {
    this.diagnostics.record(`dom.${kind}`, this.focusTraceDetails());
  }

  private focusTraceDetails(): Readonly<Record<string, TraceValue>> {
    const activeElement = document.activeElement;
    return {
      activeElement: activeElement?.tagName ?? "none",
      barrierInFlightSequence: this.barriers.barrierInFlightSequence,
      barrierInputFrozen: this.barriers.isFrozen,
      barrierQueueLength: this.barriers.queueLength,
      compositionActive: this.composition.isActive,
      contentDomFocused: activeElement === this.view.contentDOM,
      documentVersion: this.documentVersion,
      documentVisibility: document.visibilityState,
      editorHasFocus: this.view.hasFocus,
      inFlightSequence: this.inFlightSequence,
      nextSequence: this.nextSequence,
      pendingLocalChanges: this.pendingEdits.hasPending,
      recoveryActive: this.recoveryActive,
      selection: `${String(this.view.state.selection.main.from)}:${String(this.view.state.selection.main.to)}`,
      editable: !this.recoveryActive,
      webviewActive: document.visibilityState === "visible",
    };
  }
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

class OnPageDiagnosticTrace implements DiagnosticTrace {
  private readonly lines: string[] = [];

  public constructor(
    private readonly element: HTMLElement | undefined,
    private readonly report: (event: string, details: Readonly<Record<string, TraceValue>>) => void,
  ) {}

  public record(kind: string, details: Readonly<Record<string, TraceValue>>): void {
    const timestamp = String(Date.now());
    const serialized = Object.entries(details)
      .map(([key, value]): string => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    this.lines.push(`${timestamp} ${kind}${serialized === "" ? "" : ` ${serialized}`}`);
    if (this.lines.length > 250) {
      this.lines.shift();
    }
    if (this.element !== undefined) {
      this.element.textContent = this.lines.join("\n");
      this.element.scrollTop = this.element.scrollHeight;
    }
    this.report(kind, details);
  }
}

function createDiagnosticTrace(
  mode: DiagnosticMode,
  report: (event: string, details: Readonly<Record<string, TraceValue>>) => void,
): DiagnosticTrace {
  const element = document.getElementById("editor-diagnostics");
  if (recordsDiagnosticTrace(mode) && element === null) {
    throw new Error("Development diagnostic trace output is missing.");
  }
  return new OnPageDiagnosticTrace(element ?? undefined, report);
}

function createDiagnosticDomEventTrace(trace: DiagnosticTrace): Extension {
  return EditorView.domEventObservers({
    compositionstart: (event): void => {
      traceCompositionEvent(trace, "compositionstart", event);
    },
    compositionupdate: (event): void => {
      traceCompositionEvent(trace, "compositionupdate", event);
    },
    compositionend: (event): void => {
      traceCompositionEvent(trace, "compositionend", event);
    },
    beforeinput: (event): void => {
      traceInputEvent(trace, "beforeinput", event);
    },
    input: (event): void => {
      traceInputEvent(trace, "input", event);
    },
    keydown: (event): void => {
      traceKeyboardEvent(trace, "keydown", event);
    },
    keyup: (event): void => {
      traceKeyboardEvent(trace, "keyup", event);
    },
  });
}

function createCompositionLifecycleHandlers(
  compositionStart: () => void,
  compositionEnd: () => void,
  focusChanged: (kind: "focus" | "blur") => void,
): Extension {
  return EditorView.domEventHandlers({
    compositionstart: (): boolean => {
      compositionStart();
      return false;
    },
    compositionend: (): boolean => {
      compositionEnd();
      return false;
    },
    focus: (): boolean => {
      focusChanged("focus");
      return false;
    },
    blur: (): boolean => {
      focusChanged("blur");
      return false;
    },
  });
}

function traceCompositionEvent(
  trace: DiagnosticTrace,
  kind: string,
  event: CompositionEvent,
): void {
  trace.record(`dom.${kind}`, {
    isComposing: eventIsComposing(event),
  });
}

function traceInputEvent(trace: DiagnosticTrace, kind: string, event: InputEvent): void {
  trace.record(`dom.${kind}`, {
    inputType: event.inputType,
    isComposing: event.isComposing,
  });
}

function traceKeyboardEvent(trace: DiagnosticTrace, kind: string, event: KeyboardEvent): void {
  if (!isBarrierShortcutEvent(event)) {
    return;
  }
  trace.record(`dom.${kind}`, {
    code: event.code,
    ctrlKey: event.ctrlKey,
    defaultPrevented: event.defaultPrevented,
    isComposing: event.isComposing,
    key: event.key,
    metaKey: event.metaKey,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
  });
}

function isBarrierShortcutEvent(event: KeyboardEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) {
    return false;
  }
  return event.code === "KeyS" || event.code === "KeyZ" || event.code === "KeyY";
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
