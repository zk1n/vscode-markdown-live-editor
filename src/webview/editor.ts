import { markdown } from "@codemirror/lang-markdown";
import { indentUnit } from "@codemirror/language";
import {
  Annotation,
  Compartment,
  countColumn,
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
  type EditorReadyMessage,
  type HostMessageCorrelation,
  type HostToWebviewMessage,
  type WebviewToHostMessage,
  type WirePosition,
} from "../protocol/messages.js";
import {
  decodeHostPresentationMessage,
  type EditorCommandMessage,
  type EditorNavigationMessage,
  type HostPresentationMessage,
  type RestoreHistoryFocusMessage,
  type WebviewPresentationMessage,
} from "../protocol/presentationMessages.js";
import {
  createLivePreviewEngine,
  type LivePreviewEngine,
} from "./livePreview/LivePreviewEngine.js";
import { BarrierInputGate, type BarrierAction } from "./barrierInputGate.js";
import { createBarrierKeymap } from "./barrierKeymap.js";
import { CompositionBuffer } from "./compositionBuffer.js";
import { PendingEditQueue } from "./pendingEditQueue.js";
import { createTabKeymap } from "./tabKeymap.js";
import {
  outlineNavigationHighlightState,
  outlineNavigationHighlightTheme,
  setOutlineNavigationHighlight,
} from "./outline/navigationHighlight.js";

interface VsCodeApi {
  postMessage(
    message: WebviewToHostMessage | EditorReadyMessage | WebviewPresentationMessage,
  ): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}

interface WebviewBootstrap {
  readonly diagnosticMode: DiagnosticMode;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly sessionId: string;
  readonly nextSequence: number;
  readonly text: string;
}

interface PersistedWebviewState {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly documentUri: string;
  readonly sessionId: string;
  readonly authorityText: string;
  readonly localText: string;
  readonly selectionAnchor: number;
  readonly selectionHead: number;
  readonly recoveryActive: boolean;
}

/**
 * A host document-update can race ahead of its matching edit ACK. Keep only
 * metadata here: the exact text remains owned by PendingEditQueue and must
 * never be copied into diagnostics.
 */
interface DeferredInFlightSnapshot {
  readonly documentVersion: number;
  readonly reason: Extract<HostToWebviewMessage, { kind: "document-update" }>["reason"];
}

interface TextDiagnosticMetadata {
  readonly fingerprint: string;
  readonly length: number;
}

declare function acquireVsCodeApi(): VsCodeApi;

const remoteUpdate = Annotation.define<boolean>();
const OUTLINE_HIGHLIGHT_DURATION_MS = 800;

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
  private readonly tabSizeConfiguration = new Compartment();
  private readonly livePreview: LivePreviewEngine | undefined;
  private readonly diagnostics: DiagnosticTrace;
  private readonly view: EditorView;
  private readonly pendingEdits: PendingEditQueue;
  private readonly restoredState: PersistedWebviewState | undefined;
  private documentVersion: number;
  private nextSequence: number;
  private inFlightSequence: number | undefined;
  private hostMessageOrdinal = 0;
  private readonly barriers = new BarrierInputGate();
  private readonly composition = new CompositionBuffer();
  private compositionGeneration = 0;
  private compositionEndObserved = false;
  private compositionBaseMetadata: TextDiagnosticMetadata | undefined;
  private compositionFinalMetadata: TextDiagnosticMetadata | undefined;
  private deferredInFlightSnapshot: DeferredInFlightSnapshot | undefined;
  private nextShortcutAttempt = 1;
  private nextRecoveryIncidentId = 1;
  private recoveryActive = false;
  private controllerReady: boolean;
  private disposed = false;
  private outlineHighlightTimer: number | undefined;
  private outlineNavigationGeneration = 0;
  private editorConfigurationRevision = -1;
  private styleRevision = -1;
  private reportSequence = 1;
  private insertSpaces = true;
  private tabSize = 4;
  private indentSize = 4;
  private styleElement: HTMLStyleElement | undefined;
  private readonly acknowledgedHistoryFocus = new Map<
    string,
    { readonly operation: "undo" | "redo"; readonly documentVersion: number }
  >();

  public constructor(
    private readonly vscode: VsCodeApi,
    private readonly bootstrap: WebviewBootstrap,
    private readonly controllerId: string,
    private readonly statusElement: HTMLElement,
    parent: HTMLElement,
  ) {
    this.restoredState = readPersistedWebviewState(vscode, bootstrap);
    const initialText = this.restoredState?.localText ?? bootstrap.text;
    const initialAuthority = this.restoredState?.authorityText ?? bootstrap.text;
    this.pendingEdits = new PendingEditQueue(initialAuthority);
    this.documentVersion = bootstrap.documentVersion;
    this.nextSequence = bootstrap.nextSequence;
    this.controllerReady = !usesDocumentSync(bootstrap.diagnosticMode);
    this.diagnostics = createDiagnosticTrace(bootstrap.diagnosticMode, (event, details): void => {
      this.vscode.postMessage({
        kind: "diagnostic",
        documentUri: bootstrap.documentUri,
        sessionId: bootstrap.sessionId,
        controllerId,
        event,
        details: definedDiagnosticDetails(details),
      });
    });
    this.livePreview = usesLivePreview(bootstrap.diagnosticMode)
      ? createLivePreviewEngine()
      : undefined;
    const extensions: Extension[] = [
      vscodeEditorTheme,
      this.editable.of(EditorView.editable.of(this.controllerReady)),
      this.tabSizeConfiguration.of([
        EditorState.tabSize.of(this.tabSize),
        indentUnit.of(" ".repeat(this.tabSize)),
      ]),
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
      outlineNavigationHighlightState,
      outlineNavigationHighlightTheme,
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
          EditorView.domEventHandlers({
            keydown: (event): boolean => {
              if (event.key === "Tab") {
                this.recordTabKey(event);
              }
              return false;
            },
          }),
        ),
      );
      extensions.push(
        Prec.highest(
          keymap.of([
            ...createBarrierKeymap((action): void => {
              this.requestBarrier(action);
            }),
            ...createTabKeymap({
              isTabEditable: (): boolean => this.isTabEditable(),
              getInsertSpaces: (): boolean => this.insertSpaces,
              getTabSize: (): number => this.tabSize,
              getIndentSize: (): number => this.indentSize,
            }),
          ]),
        ),
      );
    }
    extensions.push(createDiagnosticDomEventTrace(this.diagnostics));
    this.view = new EditorView({
      state: EditorState.create({
        doc: initialText,
        ...(this.restoredState === undefined
          ? {}
          : {
              selection: {
                anchor: Math.min(this.restoredState.selectionAnchor, initialText.length),
                head: Math.min(this.restoredState.selectionHead, initialText.length),
              },
            }),
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
      controllerId,
      restoredState: this.restoredState !== undefined,
    });
    this.persistState();
  }

  public receive(value: unknown): void {
    if (this.disposed) {
      return;
    }

    if (isHostPresentationCandidate(value)) {
      const presentation = decodeHostPresentationMessage(value);
      if (presentation.ok) {
        this.handlePresentationMessage(presentation.value);
      }
      return;
    }

    this.hostMessageOrdinal += 1;
    this.diagnostics.record("host.message.received", {
      ...messageSummary(value),
      messageOrdinal: this.hostMessageOrdinal,
    });
    const decoded = decodeHostToWebviewMessage(value);
    if (!decoded.ok) {
      if (messageSummary(value)["kind"] === "navigate-to-heading") {
        this.diagnostics.record("outline.navigation.rejected", {
          reason: "invalid-message",
        });
        return;
      }
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
    this.persistState();
    if (this.outlineHighlightTimer !== undefined) {
      window.clearTimeout(this.outlineHighlightTimer);
      this.outlineHighlightTimer = undefined;
    }
    this.styleElement?.remove();
    this.styleElement = undefined;
    this.view.destroy();
    this.livePreview?.dispose();
  }

  private handlePresentationMessage(message: HostPresentationMessage): void {
    if (!this.matchesController(message)) {
      return;
    }
    switch (message.kind) {
      case "editor-navigation":
        this.navigateToPosition(message);
        return;
      case "editor-configuration":
        if (message.revision <= this.editorConfigurationRevision) {
          return;
        }
        this.editorConfigurationRevision = message.revision;
        this.insertSpaces = message.insertSpaces;
        this.tabSize = message.tabSize;
        this.indentSize = message.indentSize ?? message.tabSize;
        this.view.dispatch({
          effects: this.tabSizeConfiguration.reconfigure([
            EditorState.tabSize.of(this.tabSize),
            indentUnit.of(this.insertSpaces ? " ".repeat(this.indentSize) : "\t"),
          ]),
        });
        this.reportEditorState();
        return;
      case "editor-command":
        this.handleEditorCommand(message);
        return;
      case "restore-history-focus":
        this.restoreHistoryFocus(message);
        return;
      case "style-snapshot":
        if (message.revision <= this.styleRevision) {
          return;
        }
        this.styleRevision = message.revision;
        if (message.typography !== undefined) {
          const style = document.documentElement.style;
          style.setProperty("--markdown-font-family", message.typography.fontFamily);
          style.setProperty("--markdown-font-size", `${String(message.typography.fontSize)}px`);
          style.setProperty("--markdown-line-height", String(message.typography.lineHeight));
        }
        this.replaceCustomStyle(message.css);
        return;
    }
  }

  private handleEditorCommand(message: EditorCommandMessage): void {
    if (
      !this.controllerReady ||
      this.recoveryActive ||
      message.documentVersion !== this.documentVersion
    ) {
      return;
    }
    this.requestBarrier(
      message.command,
      message.command === "set-eol" ? message.eol : undefined,
      `host-command:${message.requestId}`,
    );
  }

  private restoreHistoryFocus(message: RestoreHistoryFocusMessage): void {
    const acknowledged = this.acknowledgedHistoryFocus.get(message.requestId);
    this.acknowledgedHistoryFocus.delete(message.requestId);
    if (
      acknowledged?.operation !== message.operation ||
      acknowledged.documentVersion !== message.documentVersion ||
      message.documentVersion !== this.documentVersion ||
      !this.controllerReady ||
      this.recoveryActive ||
      this.composition.isActive ||
      this.inFlightSequence !== undefined ||
      this.pendingEdits.hasPending ||
      this.barriers.isFrozen
    ) {
      return;
    }
    // The authoritative snapshot already mapped the selection through the
    // minimal replacement. Focusing only preserves that caret/selection.
    this.view.focus();
    this.reportEditorState();
  }

  private matchesController(message: {
    readonly documentUri: string;
    readonly sessionId: string;
    readonly controllerId: string;
  }): boolean {
    return (
      message.documentUri === this.bootstrap.documentUri &&
      message.sessionId === this.bootstrap.sessionId &&
      message.controllerId === this.controllerId
    );
  }

  private replaceCustomStyle(css: string): void {
    const next = document.createElement("style");
    next.id = "markdown-live-editor-custom-style";
    next.textContent = css;
    if (this.styleElement === undefined) {
      document.head.append(next);
    } else {
      this.styleElement.replaceWith(next);
    }
    this.styleElement = next;
    // Custom CSS is replaced outside CodeMirror's transaction/theme system.
    // Schedule its public layout pass so font and line metric changes are
    // reflected before the next coordinate-based selection.
    this.view.requestMeasure();
  }

  private isTabEditable(): boolean {
    return (
      this.controllerReady &&
      !this.disposed &&
      !this.recoveryActive &&
      !this.barriers.isFrozen &&
      !this.composition.isActive &&
      !this.view.composing
    );
  }

  private navigateToPosition(message: EditorNavigationMessage): void {
    const blockedReason = this.presentationNavigationBlockedReason(message);
    if (blockedReason !== undefined) {
      this.diagnostics.record("status.navigation.rejected", {
        documentVersion: message.documentVersion,
        reason: blockedReason,
      });
      return;
    }
    const document = this.view.state.doc;
    const targetLine = Math.min(Math.max(message.line, 1), document.lines);
    const line = document.line(targetLine);
    const targetOffset = line.from + Math.min(Math.max(message.column - 1, 0), line.length);
    // Selection/focus/scroll are a presentation transaction only: no document
    // changes, synchronization message, or persistent Undo entry are created.
    this.view.dispatch({
      selection: { anchor: targetOffset },
      effects: EditorView.scrollIntoView(targetOffset, { y: "center" }),
    });
    this.view.focus();
    this.reportEditorState();
    this.diagnostics.record("status.navigation.applied", {
      documentVersion: message.documentVersion,
      line: targetLine,
      column: targetOffset - line.from + 1,
    });
  }

  private presentationNavigationBlockedReason(
    message: EditorNavigationMessage,
  ): string | undefined {
    if (message.documentVersion !== this.documentVersion) {
      return "stale-version";
    }
    if (!this.controllerReady) {
      return "controller-not-ready";
    }
    if (this.recoveryActive) {
      return "recovery-active";
    }
    if (this.composition.isActive || this.view.composing) {
      return "composition-active";
    }
    if (this.inFlightSequence !== undefined || this.pendingEdits.hasPending) {
      return "local-work-pending";
    }
    if (this.barriers.isFrozen) {
      return "barrier-active";
    }
    if (this.view.state.doc.toString() !== this.pendingEdits.authority) {
      return "authority-mismatch";
    }
    return undefined;
  }

  /** Diagnostic-only: records the Tab gate before CodeMirror's keymap decides. */
  private recordTabKey(event: KeyboardEvent): void {
    if (!recordsDiagnosticTrace(this.bootstrap.diagnosticMode)) {
      return;
    }
    const gate = this.tabGateState();
    this.diagnostics.record("tab.key", {
      key: event.key,
      shift: event.shiftKey,
      handled: gate.editable,
      controllerReady: gate.controllerReady,
      disposed: gate.disposed,
      recoveryActive: gate.recoveryActive,
      "barriers.isFrozen": gate.barriersFrozen,
      "composition.isActive": gate.compositionActive,
      "view.composing": gate.viewComposing,
      insertSpaces: this.insertSpaces,
      tabSize: this.tabSize,
      indentSize: this.indentSize,
    });
  }

  private tabGateState(): Readonly<{
    controllerReady: boolean;
    disposed: boolean;
    recoveryActive: boolean;
    barriersFrozen: boolean;
    compositionActive: boolean;
    viewComposing: boolean;
    editable: boolean;
  }> {
    const controllerReady = this.controllerReady;
    const disposed = this.disposed;
    const recoveryActive = this.recoveryActive;
    const barriersFrozen = this.barriers.isFrozen;
    const compositionActive = this.composition.isActive;
    const viewComposing = this.view.composing;
    return {
      controllerReady,
      disposed,
      recoveryActive,
      barriersFrozen,
      compositionActive,
      viewComposing,
      editable:
        controllerReady &&
        !disposed &&
        !recoveryActive &&
        !barriersFrozen &&
        !compositionActive &&
        !viewComposing,
    };
  }

  private reportEditorState(): void {
    if (this.disposed) {
      return;
    }
    const selection = this.view.state.selection.main;
    const line = this.view.state.doc.lineAt(selection.head);
    const column = countColumn(line.text, this.tabSize, selection.head - line.from) + 1;
    this.vscode.postMessage({
      kind: "editor-state",
      protocolVersion: PROTOCOL_VERSION,
      documentUri: this.bootstrap.documentUri,
      sessionId: this.bootstrap.sessionId,
      controllerId: this.controllerId,
      reportSequence: this.reportSequence,
      documentVersion: this.documentVersion,
      selectionAnchor: selection.anchor,
      selectionHead: selection.head,
      line: line.number,
      column,
      focused: this.view.hasFocus,
      composing: this.composition.isActive || this.view.composing,
      recoveryActive: this.recoveryActive,
      barrierActive: this.barriers.isFrozen,
      insertSpaces: this.insertSpaces,
      tabSize: this.tabSize,
      indentSize: this.indentSize,
    });
    this.reportSequence += 1;
  }

  private handleUpdate(update: ViewUpdate): void {
    this.traceCodeMirrorUpdate(update);
    this.persistState();
    this.reportEditorState();
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
      this.compositionFinalMetadata = diagnosticTextMetadata(this.view.state.doc.toString());
      this.diagnostics.record("sync.composition.buffered", {
        composing: update.view.composing,
        compositionStarted: update.view.compositionStarted,
        textFingerprint: textFingerprint(this.view.state.doc.toString()),
      });
      this.persistState();
      return;
    }

    this.queuePendingEdit(this.view.state.doc.toString());
    this.diagnostics.record("sync.edit.pending", {
      forwarded: true,
      composing: update.view.composing,
      compositionStarted: update.view.compositionStarted,
      textFingerprint: textFingerprint(this.view.state.doc.toString()),
    });
    this.persistState();
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
    this.compositionBaseMetadata = diagnosticTextMetadata(localBase);
    this.compositionFinalMetadata = undefined;
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

    this.compositionFinalMetadata = diagnosticTextMetadata(commit.finalText);
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
    if (
      !this.controllerReady ||
      this.inFlightSequence !== undefined ||
      this.recoveryActive ||
      this.disposed
    ) {
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
      controllerId: this.controllerId,
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
      textFingerprint: textFingerprint(text),
      ...this.syncStateDetails(),
    });
    this.vscode.postMessage(message);
    this.persistState();
  }

  private requestBarrier(
    action: BarrierAction,
    eol?: "lf" | "crlf",
    hostRequestAttemptId?: string,
  ): void {
    if (!this.controllerReady || this.recoveryActive || this.disposed) {
      return;
    }

    // Freeze before queueing the barrier so an edit made after the command
    // cannot overtake it. The host still supplies the authoritative result.
    const shortcutAttemptId =
      hostRequestAttemptId ?? `shortcut-${String(this.nextShortcutAttempt)}`;
    if (hostRequestAttemptId === undefined) {
      this.nextShortcutAttempt += 1;
    }
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
      eol,
    );
    this.sendPendingEdit();
    this.sendNextBarrier();
    this.assertBarrierLiveness();
  }

  private handleHostMessage(message: HostToWebviewMessage): void {
    switch (message.kind) {
      case "controller-ready":
        this.handleControllerReady(message);
        return;
      case "operation-ack":
        if (!this.controllerReady) return;
        this.handleAcknowledgement(message);
        return;
      case "document-update":
        if (!this.controllerReady) return;
        this.handleDocumentUpdate(message);
        return;
      case "resync":
        if (!this.controllerReady) return;
        this.resolveDeferredInFlightSnapshot("resync", message.documentVersion);
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
        this.persistState();
        this.reportEditorState();
        return;
      case "protocol-error":
        this.enterRecovery(message.note);
        return;
      case "navigate-to-heading":
        if (!this.controllerReady) return;
        this.navigateToHeading(message);
        return;
    }
  }

  private handleControllerReady(
    message: Extract<HostToWebviewMessage, { kind: "controller-ready" }>,
  ): void {
    if (
      message.documentUri !== this.bootstrap.documentUri ||
      message.sessionId !== this.bootstrap.sessionId ||
      message.controllerId !== this.controllerId
    ) {
      this.diagnostics.record("sync.controller.ready-rejected", {
        controllerId: message.controllerId,
        sessionId: message.sessionId,
      });
      return;
    }
    if (this.controllerReady) {
      this.diagnostics.record("sync.controller.ready-duplicate", {
        controllerId: message.controllerId,
      });
      return;
    }

    const localText = this.view.state.doc.toString();
    const hasUnconfirmedLocalText =
      localText !== this.bootstrap.text ||
      (this.restoredState !== undefined &&
        (this.restoredState.recoveryActive ||
          this.restoredState.localText !== this.restoredState.authorityText));
    this.documentVersion = message.documentVersion;
    this.nextSequence = message.nextSequence;
    this.inFlightSequence = undefined;
    this.deferredInFlightSnapshot = undefined;
    this.barriers.reset();
    this.composition.abandon();
    this.compositionEndObserved = false;
    this.pendingEdits.reset(message.text);
    this.controllerReady = true;

    if (hasUnconfirmedLocalText && localText !== message.text) {
      this.enterRecovery(
        "The Webview controller restarted while local text was not confirmed by the host; local text remains visible.",
      );
      this.persistState();
      return;
    }

    this.applyAuthoritativeSnapshot(message);
    this.recoveryActive = false;
    this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(true)) });
    this.statusElement.hidden = true;
    this.diagnostics.record("sync.controller.ready", {
      controllerId: this.controllerId,
      nextSequence: this.nextSequence,
      documentVersion: this.documentVersion,
      restoredState: this.restoredState !== undefined,
    });
    this.persistState();
    this.reportEditorState();
  }

  private navigateToHeading(
    message: Extract<HostToWebviewMessage, { kind: "navigate-to-heading" }>,
  ): void {
    const blockedReason = this.outlineNavigationBlockedReason(message);
    if (blockedReason !== undefined) {
      this.diagnostics.record("outline.navigation.rejected", {
        documentVersion: message.documentVersion,
        reason: blockedReason,
      });
      return;
    }

    this.outlineNavigationGeneration += 1;
    const generation = this.outlineNavigationGeneration;
    if (this.outlineHighlightTimer !== undefined) {
      window.clearTimeout(this.outlineHighlightTimer);
    }
    this.view.dispatch({
      selection: { anchor: message.targetOffset },
      effects: [
        EditorView.scrollIntoView(message.targetOffset, { y: "center" }),
        setOutlineNavigationHighlight.of(message.highlightFrom),
      ],
    });
    this.view.focus();
    this.diagnostics.record("outline.navigation.applied", {
      documentVersion: message.documentVersion,
      targetOffset: message.targetOffset,
    });
    this.outlineHighlightTimer = window.setTimeout((): void => {
      if (this.disposed || this.outlineNavigationGeneration !== generation) {
        return;
      }
      this.outlineHighlightTimer = undefined;
      this.view.dispatch({ effects: setOutlineNavigationHighlight.of(null) });
    }, OUTLINE_HIGHLIGHT_DURATION_MS);
  }

  private outlineNavigationBlockedReason(
    message: Extract<HostToWebviewMessage, { kind: "navigate-to-heading" }>,
  ): string | undefined {
    if (
      message.documentUri !== this.bootstrap.documentUri ||
      message.sessionId !== this.bootstrap.sessionId
    ) {
      return "session-mismatch";
    }
    if (message.documentVersion !== this.documentVersion) {
      return "stale-version";
    }
    if (this.recoveryActive) {
      return "recovery-active";
    }
    if (this.composition.isActive || this.view.composing) {
      return "composition-active";
    }
    if (this.inFlightSequence !== undefined || this.pendingEdits.hasPending) {
      return "local-work-pending";
    }
    if (this.barriers.isFrozen) {
      return "barrier-active";
    }
    if (this.view.state.doc.toString() !== this.pendingEdits.authority) {
      return "authority-mismatch";
    }
    const documentLength = this.view.state.doc.length;
    if (
      message.highlightFrom > documentLength ||
      message.highlightTo > documentLength ||
      message.targetOffset > documentLength
    ) {
      return "invalid-position";
    }
    const line = this.view.state.doc.lineAt(message.highlightFrom);
    if (
      line.from !== message.highlightFrom ||
      line.to !== message.highlightTo ||
      message.targetOffset < line.from ||
      message.targetOffset > line.to
    ) {
      return "invalid-heading-range";
    }
    return undefined;
  }

  private handleAcknowledgement(
    message: Extract<HostToWebviewMessage, { kind: "operation-ack" }>,
  ): void {
    this.diagnostics.record("sync.operation.ack", {
      currentDocumentVersion: this.documentVersion,
      deferredInFlightSnapshot: this.deferredInFlightSnapshot !== undefined,
      matchesInFlightSequence:
        message.operation === "edit" && message.sequence === this.inFlightSequence,
      matchesInFlightTarget: message.text === this.pendingEdits.inFlightTarget,
      messageOrdinal: this.hostMessageOrdinal,
      operation: message.operation,
      sequence: message.sequence,
      documentVersion: message.documentVersion,
      incomingFingerprint: textFingerprint(message.text),
      ...this.syncStateDetails(),
      ...this.correlationDetails(message.correlation),
    });
    if (this.recoveryActive) {
      return;
    }
    if (message.documentVersion < this.documentVersion) {
      if (message.operation === "edit" && message.sequence === this.inFlightSequence) {
        this.enterRecovery(
          "An edit acknowledgement was older than the current authoritative document version.",
          message.correlation,
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
      if (message.text !== this.pendingEdits.inFlightTarget) {
        this.enterRecovery(
          "The edit acknowledgement did not match the exact in-flight target snapshot.",
          message.correlation,
        );
        return;
      }
      const acknowledgementOrder =
        this.deferredInFlightSnapshot === undefined ? "ack-before-update" : "update-before-ack";
      const authoritativeDocumentVersion = this.resolveDeferredInFlightSnapshot(
        "ack",
        message.documentVersion,
      );
      this.inFlightSequence = undefined;
      this.pendingEdits.acknowledge(message.text);
      this.documentVersion = authoritativeDocumentVersion;
      this.diagnostics.record("sync.operation.ack.applied", {
        acknowledgementOrder,
        documentVersion: authoritativeDocumentVersion,
        sequence: message.sequence,
      });
      this.sendPendingEdit();
      if (this.composition.isActive) {
        this.finalizeCompositionIfSafe();
      } else {
        this.sendNextBarrier();
      }
      this.assertBarrierLiveness();
      this.persistState();
      return;
    }

    const acknowledgedRequest =
      this.barriers.barrierInFlightSequence === message.sequence
        ? this.barriers.nextRequest
        : undefined;
    this.applyAuthoritativeSnapshot(
      message,
      message.operation === "undo" || message.operation === "redo" ? message.operation : undefined,
    );
    if (this.barriers.acknowledgeBarrier(message.sequence)) {
      if (
        acknowledgedRequest !== undefined &&
        (message.operation === "undo" || message.operation === "redo") &&
        acknowledgedRequest.shortcutAttemptId.startsWith("host-command:")
      ) {
        const requestId = acknowledgedRequest.shortcutAttemptId.slice("host-command:".length);
        this.acknowledgedHistoryFocus.set(requestId, {
          operation: message.operation,
          documentVersion: message.documentVersion,
        });
      }
      this.sendNextBarrier();
    }
    this.assertBarrierLiveness();
    this.persistState();
    this.reportEditorState();
  }

  private handleDocumentUpdate(
    message: Extract<HostToWebviewMessage, { kind: "document-update" }>,
  ): void {
    this.diagnostics.record("sync.document.update", {
      compositionActive: this.composition.isActive,
      currentDocumentVersion: this.documentVersion,
      documentVersion: message.documentVersion,
      incomingFingerprint: textFingerprint(message.text),
      inFlightSequence: this.inFlightSequence,
      matchesAuthority: message.text === this.pendingEdits.authority,
      matchesInFlightTarget: message.text === this.pendingEdits.inFlightTarget,
      matchesPendingTarget: message.text === this.pendingEdits.pendingTarget,
      messageOrdinal: this.hostMessageOrdinal,
      pendingLocalChanges: this.pendingEdits.hasPending,
      reason: message.reason,
      ...this.syncStateDetails(),
      ...this.correlationDetails(message.correlation),
    });
    if (this.recoveryActive) {
      this.diagnostics.record("sync.document.update.ignored-recovery", {
        reason: message.reason,
        documentVersion: message.documentVersion,
        textFingerprint: textFingerprint(message.text),
      });
      this.persistState();
      return;
    }
    if (message.documentVersion < this.documentVersion) {
      this.diagnostics.record("sync.document.update.ignored-stale", {
        reason: message.reason,
        documentVersion: message.documentVersion,
        currentDocumentVersion: this.documentVersion,
        textFingerprint: textFingerprint(message.text),
      });
      this.persistState();
      return;
    }
    // ACK/update ordering matrix:
    // - exact in-flight target before its ACK: defer without changing authority;
    // - ACK before its matching update: ACK advances authority and the later update is a no-op;
    // - every other newer snapshot while local state is pending: visible recovery.
    // The host-provided reason alone is never evidence that a snapshot is ours.
    if (this.inFlightSequence !== undefined && message.text === this.pendingEdits.inFlightTarget) {
      const deferred = this.deferredInFlightSnapshot;
      if (deferred === undefined || message.documentVersion >= deferred.documentVersion) {
        this.deferredInFlightSnapshot = {
          documentVersion: message.documentVersion,
          reason: message.reason,
        };
      }
      this.diagnostics.record("sync.document.update.deferred-in-flight-target", {
        documentVersion: message.documentVersion,
        inFlightSequence: this.inFlightSequence,
        reason: message.reason,
        targetFingerprint: textFingerprint(message.text),
      });
      this.persistState();
      return;
    }
    if (message.text === this.pendingEdits.authority) {
      this.documentVersion = message.documentVersion;
      this.diagnostics.record("sync.document.update.authority-equal", {
        documentVersion: message.documentVersion,
        reason: message.reason,
      });
      this.persistState();
      return;
    }
    if (
      !this.controllerReady ||
      this.inFlightSequence !== undefined ||
      this.pendingEdits.hasPending ||
      this.composition.isActive
    ) {
      this.enterRecovery(
        "The document changed outside this webview while local edits were pending.",
        message.correlation,
      );
      this.persistState();
      return;
    }
    this.applyAuthoritativeSnapshot(message);
    this.assertBarrierLiveness();
    this.persistState();
  }

  private applyAuthoritativeSnapshot(
    snapshot: DocumentSnapshotMessage,
    historyOperation?: "undo" | "redo",
  ): void {
    this.documentVersion = snapshot.documentVersion;
    this.pendingEdits.replaceAuthority(snapshot.text);
    const before = this.view.state.doc.toString();
    const replacement = minimalTextReplacement(before, snapshot.text);
    if (replacement === undefined) {
      this.persistState();
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
    const currentSelection = this.view.state.selection.main;
    const historyInsertionCaret =
      historyOperation !== undefined &&
      currentSelection.empty &&
      replacement.from === replacement.to &&
      currentSelection.head === replacement.from
        ? replacement.from + replacement.insert.length
        : undefined;
    this.view.dispatch({
      changes: replacement,
      ...(historyInsertionCaret === undefined
        ? {}
        : { selection: { anchor: historyInsertionCaret } }),
      annotations: remoteUpdate.of(true),
    });
    this.persistState();
  }

  private enterRecovery(note: string, correlation?: HostMessageCorrelation): void {
    const recoveryIncidentId = this.nextRecoveryIncidentId;
    this.nextRecoveryIncidentId += 1;
    this.diagnostics.record("sync.recovery", {
      recoveryIncidentId,
      compositionActive: this.composition.isActive,
      currentDocumentVersion: this.documentVersion,
      inFlightSequence: this.inFlightSequence,
      messageOrdinal: this.hostMessageOrdinal,
      note,
      pendingLocalChanges: this.pendingEdits.hasPending,
      ...this.syncStateDetails(),
      ...this.correlationDetails(correlation),
    });
    this.recoveryActive = true;
    this.deferredInFlightSnapshot = undefined;
    this.barriers.reset();
    this.composition.abandon();
    this.compositionEndObserved = false;
    this.compositionBaseMetadata = undefined;
    this.compositionFinalMetadata = undefined;
    this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(false)) });
    this.showStatus(
      `Editing paused to protect unsynchronized text: ${note} [incident ${String(recoveryIncidentId)}]`,
    );
    this.persistState();
    this.reportEditorState();
  }

  private sendNextBarrier(): void {
    const request = this.barriers.nextRequest;
    if (request === undefined) {
      if (this.barriers.completeIfIdle()) {
        this.diagnostics.record("sync.barrier.completed", this.focusTraceDetails());
        this.reportEditorState();
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
    let message: WebviewToHostMessage;
    if (request.action === "set-eol") {
      if (request.eol === undefined) {
        this.enterRecovery("An EOL request reached the FIFO without a requested line ending.");
        return;
      }
      message = {
        kind: "set-eol",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: this.bootstrap.documentUri,
        sessionId: this.bootstrap.sessionId,
        controllerId: this.controllerId,
        sequence,
        documentVersion: this.documentVersion,
        eol: request.eol,
      };
    } else {
      message = {
        kind: request.action,
        protocolVersion: PROTOCOL_VERSION,
        documentUri: this.bootstrap.documentUri,
        sessionId: this.bootstrap.sessionId,
        controllerId: this.controllerId,
        sequence,
        shortcutAttemptId: request.shortcutAttemptId,
      };
    }
    this.diagnostics.record("sync.barrier.sent", {
      action: request.action,
      sequence,
      shortcutAttemptId: request.shortcutAttemptId,
      documentVersion: this.documentVersion,
      composing: this.view.composing,
      ...this.syncStateDetails(),
    });
    this.reportEditorState();
    this.vscode.postMessage(message);
    this.persistState();
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

  private resolveDeferredInFlightSnapshot(
    resolution: "ack" | "resync",
    resolvedDocumentVersion: number,
  ): number {
    const deferred = this.deferredInFlightSnapshot;
    this.deferredInFlightSnapshot = undefined;
    if (deferred === undefined) {
      return resolvedDocumentVersion;
    }
    const authoritativeDocumentVersion =
      resolution === "ack"
        ? Math.max(resolvedDocumentVersion, deferred.documentVersion)
        : resolvedDocumentVersion;
    this.diagnostics.record("sync.document.update.deferred-resolved", {
      authoritativeDocumentVersion,
      deferredDocumentVersion: deferred.documentVersion,
      reason: deferred.reason,
      resolvedDocumentVersion,
      resolution,
    });
    return authoritativeDocumentVersion;
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
    this.reportEditorState();
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
      editable: this.controllerReady && !this.recoveryActive,
      webviewActive: document.visibilityState === "visible",
    };
  }

  private syncStateDetails(): Readonly<Record<string, TraceValue>> {
    const authority = diagnosticTextMetadata(this.pendingEdits.authority);
    const inFlight = this.pendingEdits.inFlightTarget;
    const pending = this.pendingEdits.pendingTarget;
    return {
      sessionId: this.bootstrap.sessionId,
      controllerId: this.controllerId,
      authorityFingerprint: authority.fingerprint,
      authorityLength: authority.length,
      inFlightTargetFingerprint: inFlight === undefined ? "none" : textFingerprint(inFlight),
      inFlightTargetLength: inFlight?.length ?? -1,
      pendingTargetFingerprint: pending === undefined ? "none" : textFingerprint(pending),
      pendingTargetLength: pending?.length ?? -1,
      compositionBaseFingerprint: this.compositionBaseMetadata?.fingerprint ?? "none",
      compositionBaseLength: this.compositionBaseMetadata?.length ?? -1,
      compositionFinalFingerprint: this.compositionFinalMetadata?.fingerprint ?? "none",
      compositionFinalLength: this.compositionFinalMetadata?.length ?? -1,
    };
  }

  private persistState(): void {
    if (this.vscode.setState === undefined) {
      return;
    }
    const selection = this.view.state.selection.main;
    this.vscode.setState({
      protocolVersion: PROTOCOL_VERSION,
      documentUri: this.bootstrap.documentUri,
      sessionId: this.bootstrap.sessionId,
      authorityText: this.pendingEdits.authority,
      localText: this.view.state.doc.toString(),
      selectionAnchor: selection.anchor,
      selectionHead: selection.head,
      recoveryActive: this.recoveryActive,
    } satisfies PersistedWebviewState);
  }

  private correlationDetails(
    correlation: HostMessageCorrelation | undefined,
  ): Readonly<Record<string, TraceValue>> {
    return {
      correlationCausalId: correlation?.causalId,
      correlationPublicationId: correlation?.publicationId,
      correlationSource: correlation?.source,
      correlationQueueEnqueueOrdinal: correlation?.queueEnqueueOrdinal,
      correlationQueueStartOrdinal: correlation?.queueStartOrdinal,
      correlationOriginSessionId: correlation?.originSessionId,
      correlationOperationSequence: correlation?.operationSequence,
      correlationExternalEventId: correlation?.externalEventId,
    };
  }
}

function diagnosticTextMetadata(text: string): TextDiagnosticMetadata {
  return { fingerprint: textFingerprint(text), length: text.length };
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

function readPersistedWebviewState(
  vscode: VsCodeApi,
  bootstrap: WebviewBootstrap,
): PersistedWebviewState | undefined {
  const value = vscode.getState?.();
  if (
    !isRecord(value) ||
    value["protocolVersion"] !== PROTOCOL_VERSION ||
    value["documentUri"] !== bootstrap.documentUri ||
    value["sessionId"] !== bootstrap.sessionId ||
    typeof value["authorityText"] !== "string" ||
    typeof value["localText"] !== "string" ||
    typeof value["recoveryActive"] !== "boolean" ||
    typeof value["selectionAnchor"] !== "number" ||
    !Number.isSafeInteger(value["selectionAnchor"]) ||
    value["selectionAnchor"] < 0 ||
    typeof value["selectionHead"] !== "number" ||
    !Number.isSafeInteger(value["selectionHead"]) ||
    value["selectionHead"] < 0
  ) {
    return undefined;
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    documentUri: bootstrap.documentUri,
    sessionId: bootstrap.sessionId,
    authorityText: value["authorityText"],
    localText: value["localText"],
    selectionAnchor: value["selectionAnchor"],
    selectionHead: value["selectionHead"],
    recoveryActive: value["recoveryActive"],
  };
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

function isHostPresentationCandidate(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const kind = value["kind"];
  return (
    kind === "editor-navigation" ||
    kind === "editor-configuration" ||
    kind === "editor-command" ||
    kind === "restore-history-focus" ||
    kind === "style-snapshot"
  );
}

type TraceValue = boolean | number | string | undefined;

function definedDiagnosticDetails(
  details: Readonly<Record<string, TraceValue>>,
): Readonly<Record<string, boolean | number | string>> {
  return Object.fromEntries(
    Object.entries(details).filter(
      (entry): entry is [string, boolean | number | string] => entry[1] !== undefined,
    ),
  );
}

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
    copy: (): void => {
      trace.record("dom.copy", {});
    },
    cut: (): void => {
      trace.record("dom.cut", {});
    },
    paste: (): void => {
      trace.record("dom.paste", {});
    },
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

const vscodeApi = acquireVsCodeApi();
const bootstrap = readBootstrap();
const controllerId = globalThis.crypto.randomUUID();
const controller = new MarkdownWebviewController(vscodeApi, bootstrap, controllerId, status, root);
window.addEventListener("message", (event: MessageEvent<unknown>): void => {
  controller.receive(event.data);
});
window.addEventListener("unload", (): void => {
  controller.dispose();
});
vscodeApi.postMessage({
  kind: "editor-ready",
  protocolVersion: PROTOCOL_VERSION,
  documentUri: bootstrap.documentUri,
  sessionId: bootstrap.sessionId,
  controllerId,
});
