import {
  decodeWebviewToHostMessage,
  type ClientEditMessage,
  type DocumentUpdateMessage,
  type HostMessageCorrelation,
  type HostToWebviewMessage,
  type ResyncMessage,
  type WebviewToHostMessage,
} from "../../protocol/messages.js";
import { disabledDiagnosticLog, type DiagnosticLog } from "../diagnostics/diagnosticLog.js";
import { textFingerprint } from "../diagnostics/textFingerprint.js";
import { applyWireChanges } from "./documentText.js";

export interface DocumentSnapshot {
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly text: string;
}

export type DocumentPortResult =
  | { readonly kind: "applied"; readonly snapshot: DocumentSnapshot }
  | { readonly kind: "rejected"; readonly snapshot: DocumentSnapshot; readonly note: string };

/**
 * The only mutable boundary required by the pure synchronization core.
 * A VS Code adapter must implement these methods using one TextDocument and
 * its native edit/history/save operations; it must not maintain a second
 * persisted text store.
 */
export interface DocumentPort {
  readDocument(documentUri: string): Promise<DocumentSnapshot>;
  replaceDocument(
    documentUri: string,
    expectedVersion: number,
    text: string,
    causalId?: string,
  ): Promise<DocumentPortResult>;
  saveDocument(documentUri: string, shortcutAttemptId?: string): Promise<DocumentPortResult>;
  undoDocument(documentUri: string, shortcutAttemptId?: string): Promise<DocumentPortResult>;
  redoDocument(documentUri: string, shortcutAttemptId?: string): Promise<DocumentPortResult>;
}

/** Metadata captured at the production document-change listener. */
export interface ExternalChangeObservation {
  readonly eventId: string;
  readonly eventDocumentVersion: number;
  readonly eventTextFingerprint: string;
  readonly eventTextLength: number;
  readonly contentChangeCount: number;
  readonly classification: "own" | "external";
}

export interface WebviewEndpoint {
  postMessage(message: HostToWebviewMessage): void;
}

export type OpenSessionResult =
  | { readonly ok: true; readonly snapshot: DocumentSnapshot }
  | { readonly ok: false; readonly error: string };

interface SessionState {
  readonly endpoint: WebviewEndpoint;
  nextSequence: number;
}

interface QueueContext {
  readonly enqueueOrdinal: number;
  readonly startOrdinal: number;
}

type BroadcastReason = DocumentUpdateMessage["reason"];

function errorNote(error: unknown): string {
  return error instanceof Error ? error.message : "The document port failed unexpectedly.";
}

function isUsableSnapshot(documentUri: string, snapshot: DocumentSnapshot): boolean {
  return (
    snapshot.documentUri === documentUri &&
    Number.isSafeInteger(snapshot.documentVersion) &&
    snapshot.documentVersion >= 0 &&
    typeof snapshot.text === "string"
  );
}

/**
 * Serializes all mutations for each document URI while allowing independent
 * documents to progress independently. A session has its own monotonic client
 * sequence stream; all sessions for a URI share the same FIFO document queue.
 */
export class DocumentSyncCoordinator {
  private readonly sessionsByDocument = new Map<string, Map<string, SessionState>>();
  private readonly queues = new Map<string, Promise<void>>();
  private nextReceiveOrdinal = 1;
  private nextQueueEnqueueOrdinal = 1;
  private nextQueueStartOrdinal = 1;
  private nextPublicationOrdinal = 1;

  public constructor(
    private readonly documentPort: DocumentPort,
    private readonly diagnostics: DiagnosticLog = disabledDiagnosticLog,
  ) {}

  public async openSession(
    documentUri: string,
    sessionId: string,
    endpoint: WebviewEndpoint,
  ): Promise<OpenSessionResult> {
    const causalId = `opened:${sessionId}`;
    return this.enqueue(documentUri, async (queue): Promise<OpenSessionResult> => {
      try {
        const snapshot = await this.documentPort.readDocument(documentUri);
        if (!isUsableSnapshot(documentUri, snapshot)) {
          const error = "Document port returned an invalid initial snapshot.";
          this.post(endpoint, { kind: "protocol-error", note: error });
          return { ok: false, error };
        }

        let sessions = this.sessionsByDocument.get(documentUri);
        if (sessions === undefined) {
          sessions = new Map<string, SessionState>();
          this.sessionsByDocument.set(documentUri, sessions);
        }
        sessions.set(sessionId, { endpoint, nextSequence: 1 });
        this.post(endpoint, {
          kind: "document-update",
          reason: "opened",
          ...snapshot,
          correlation: this.correlation(
            causalId,
            `publication-${String(this.nextPublicationOrdinal++)}`,
            "opened",
            queue,
          ),
        });
        this.diagnostics.record("coordinator.session.opened", {
          documentUri,
          sessionId,
          causalId,
          queueEnqueueOrdinal: queue.enqueueOrdinal,
          queueStartOrdinal: queue.startOrdinal,
          documentVersion: snapshot.documentVersion,
          textFingerprint: textFingerprint(snapshot.text),
          textLength: snapshot.text.length,
        });
        return { ok: true, snapshot };
      } catch (error: unknown) {
        const message = `Unable to open document session: ${errorNote(error)}`;
        this.post(endpoint, { kind: "protocol-error", note: message });
        return { ok: false, error: message };
      }
    });
  }

  public closeSession(documentUri: string, sessionId: string): void {
    const sessions = this.sessionsByDocument.get(documentUri);
    if (sessions === undefined) {
      return;
    }

    sessions.delete(sessionId);
    this.diagnostics.record("coordinator.session.closed", {
      documentUri,
      sessionId,
      remainingSessionCount: sessions.size,
    });
    if (sessions.size === 0) {
      this.sessionsByDocument.delete(documentUri);
    }
  }

  /** Waits for every operation already accepted into a document's FIFO queue. */
  public async flush(documentUri: string): Promise<void> {
    await this.enqueue(documentUri, (): Promise<void> => Promise.resolve());
  }

  /** Receives untrusted webview data. Decode failures never reach the port. */
  public async receive(rawMessage: unknown, endpoint: WebviewEndpoint): Promise<void> {
    const decoded = decodeWebviewToHostMessage(rawMessage);
    if (!decoded.ok) {
      this.diagnostics.record("coordinator.receive.invalid", { note: decoded.error });
      this.post(endpoint, { kind: "protocol-error", note: decoded.error });
      return;
    }

    const message = decoded.value;
    if (message.kind === "diagnostic") {
      const session = this.getSession(message.documentUri, message.sessionId);
      if (session?.endpoint === endpoint) {
        this.diagnostics.record(`webview.${message.event}`, message.details);
      }
      return;
    }

    const receiveOrdinal = this.nextReceiveOrdinal++;
    const causalId = `operation:${message.sessionId}:${String(message.sequence)}`;
    this.diagnostics.record("coordinator.receive", {
      ...messageTrace(message),
      causalId,
      receiveOrdinal,
      sessionId: message.sessionId,
      documentUri: message.documentUri,
    });

    await this.enqueue(message.documentUri, async (queue): Promise<void> => {
      await this.process(message, endpoint, queue, causalId, receiveOrdinal);
    });
  }

  /**
   * VS Code integration calls this after an authoritative external document
   * change. The snapshot is broadcast without trying to rebase pending edits.
   */
  public async publishExternalChange(
    documentUri: string,
    observation?: ExternalChangeObservation,
  ): Promise<void> {
    const eventId =
      observation?.eventId ?? `external-event-${String(this.nextPublicationOrdinal++)}`;
    this.diagnostics.record("coordinator.external.publish-enqueued", {
      eventId,
      documentUri,
      eventDocumentVersion: observation?.eventDocumentVersion ?? -1,
      eventTextFingerprint: observation?.eventTextFingerprint ?? "unavailable",
      eventTextLength: observation?.eventTextLength ?? -1,
      contentChangeCount: observation?.contentChangeCount ?? -1,
      classification: observation?.classification ?? "untraced",
    });
    await this.enqueue(documentUri, async (queue): Promise<void> => {
      try {
        const snapshot = await this.documentPort.readDocument(documentUri);
        if (!isUsableSnapshot(documentUri, snapshot)) {
          this.broadcastProtocolError(
            documentUri,
            "Document port returned an invalid external-change snapshot.",
          );
          return;
        }
        const drifted =
          observation !== undefined &&
          (snapshot.documentVersion !== observation.eventDocumentVersion ||
            textFingerprint(snapshot.text) !== observation.eventTextFingerprint);
        this.diagnostics.record("coordinator.external.publish-executed", {
          eventId,
          documentUri,
          eventDocumentVersion: observation?.eventDocumentVersion ?? -1,
          eventTextFingerprint: observation?.eventTextFingerprint ?? "unavailable",
          eventTextLength: observation?.eventTextLength ?? -1,
          snapshotDocumentVersion: snapshot.documentVersion,
          snapshotTextFingerprint: textFingerprint(snapshot.text),
          snapshotTextLength: snapshot.text.length,
          temporalDrift: drifted,
          queueEnqueueOrdinal: queue.enqueueOrdinal,
          queueStartOrdinal: queue.startOrdinal,
        });
        this.broadcastSnapshot(documentUri, "external", snapshot, undefined, {
          causalId: `external:${eventId}`,
          externalEventId: eventId,
          queue,
        });
      } catch (error: unknown) {
        this.broadcastProtocolError(
          documentUri,
          `Unable to read external document change: ${errorNote(error)}`,
        );
      }
    });
  }

  private async process(
    message: Exclude<WebviewToHostMessage, { readonly kind: "diagnostic" }>,
    receivedEndpoint: WebviewEndpoint,
    queue: QueueContext,
    causalId: string,
    receiveOrdinal: number,
  ): Promise<void> {
    const session = this.getSession(message.documentUri, message.sessionId);
    if (session?.endpoint !== receivedEndpoint) {
      this.post(receivedEndpoint, {
        kind: "protocol-error",
        note: "The message does not belong to an open document session.",
      });
      return;
    }

    let snapshot: DocumentSnapshot;
    try {
      snapshot = await this.documentPort.readDocument(message.documentUri);
    } catch (error: unknown) {
      this.post(session.endpoint, {
        kind: "protocol-error",
        note: `Unable to read authoritative document state: ${errorNote(error)}`,
      });
      return;
    }

    if (!isUsableSnapshot(message.documentUri, snapshot)) {
      this.post(session.endpoint, {
        kind: "protocol-error",
        note: "Document port returned an invalid authoritative snapshot.",
      });
      return;
    }

    if (message.sequence !== session.nextSequence) {
      this.resync(
        session,
        snapshot,
        "sequence-gap",
        `Expected sequence ${String(session.nextSequence)}, received ${String(message.sequence)}.`,
      );
      return;
    }

    // A correctly sequenced message is consumed even if its contents are stale.
    // The resync response tells the client the next sequence to use after rebasing.
    session.nextSequence += 1;

    if (message.kind === "edit") {
      await this.processEdit(session, message, snapshot, queue, causalId, receiveOrdinal);
      return;
    }

    await this.processBarrier(session, message, queue, causalId, receiveOrdinal);
  }

  private async processEdit(
    session: SessionState,
    message: ClientEditMessage,
    snapshot: DocumentSnapshot,
    queue: QueueContext,
    causalId: string,
    receiveOrdinal: number,
  ): Promise<void> {
    const firstChange = message.changes[0];
    this.diagnostics.record("coordinator.edit", {
      authorityTextFingerprint: textFingerprint(snapshot.text),
      changeCount: message.changes.length,
      changeRange:
        firstChange === undefined
          ? "none"
          : `${String(firstChange.range.start.line)}:${String(firstChange.range.start.character)}-${String(firstChange.range.end.line)}:${String(firstChange.range.end.character)}`,
      sequence: message.sequence,
      documentVersion: message.documentVersion,
      expectedTextFingerprint:
        firstChange === undefined ? "none" : textFingerprint(firstChange.expectedText),
      replacementTextFingerprint:
        firstChange === undefined ? "none" : textFingerprint(firstChange.text),
      textLength: firstChange?.text.length,
      causalId,
      receiveOrdinal,
      queueEnqueueOrdinal: queue.enqueueOrdinal,
      queueStartOrdinal: queue.startOrdinal,
    });
    if (message.documentVersion !== snapshot.documentVersion) {
      this.resync(
        session,
        snapshot,
        "stale-version",
        `Edit was based on version ${String(message.documentVersion)}, but authority is version ${String(snapshot.documentVersion)}.`,
      );
      return;
    }

    const appliedChanges = applyWireChanges(snapshot.text, message.changes);
    if (!appliedChanges.ok) {
      this.diagnostics.record("coordinator.edit.change-mismatch", {
        actualTextFingerprint: appliedChanges.mismatch?.actualTextFingerprint ?? "unavailable",
        authorityTextFingerprint: textFingerprint(snapshot.text),
        documentVersion: snapshot.documentVersion,
        expectedTextFingerprint: appliedChanges.mismatch?.expectedTextFingerprint ?? "unavailable",
        range:
          appliedChanges.mismatch === undefined
            ? "unavailable"
            : `${String(appliedChanges.mismatch.startOffset)}:${String(appliedChanges.mismatch.endOffset)}`,
        sequence: message.sequence,
      });
      this.resync(session, snapshot, "change-mismatch", appliedChanges.note);
      return;
    }

    let portResult: DocumentPortResult;
    try {
      portResult = await this.documentPort.replaceDocument(
        message.documentUri,
        snapshot.documentVersion,
        appliedChanges.text,
        causalId,
      );
    } catch (error: unknown) {
      await this.resyncAfterPortFailure(
        session,
        message.documentUri,
        `Document replacement failed: ${errorNote(error)}`,
      );
      return;
    }

    if (!isUsableSnapshot(message.documentUri, portResult.snapshot)) {
      this.post(session.endpoint, {
        kind: "protocol-error",
        note: "Document port returned an invalid replacement result.",
      });
      return;
    }
    if (portResult.kind === "rejected") {
      this.resync(session, portResult.snapshot, "port-rejected", portResult.note);
      return;
    }
    if (portResult.snapshot.text !== appliedChanges.text) {
      this.resync(
        session,
        portResult.snapshot,
        "port-inconsistent",
        "Document port acknowledged a replacement with different authoritative text.",
      );
      return;
    }

    this.acknowledge(session, message, portResult.snapshot, queue, causalId, receiveOrdinal);
    this.broadcastSnapshot(message.documentUri, "edit", portResult.snapshot, message.sessionId, {
      causalId,
      queue,
      receiveOrdinal,
      originSessionId: message.sessionId,
      operationSequence: message.sequence,
    });
  }

  private async processBarrier(
    session: SessionState,
    message: Exclude<WebviewToHostMessage, ClientEditMessage | { readonly kind: "diagnostic" }>,
    queue: QueueContext,
    causalId: string,
    receiveOrdinal: number,
  ): Promise<void> {
    this.diagnostics.record("coordinator.barrier", {
      documentUri: message.documentUri,
      operation: message.kind,
      sequence: message.sequence,
      sessionId: message.sessionId,
      shortcutAttemptId: message.shortcutAttemptId ?? "untraced",
      causalId,
      receiveOrdinal,
      queueEnqueueOrdinal: queue.enqueueOrdinal,
      queueStartOrdinal: queue.startOrdinal,
    });
    let portResult: DocumentPortResult;
    try {
      switch (message.kind) {
        case "save":
          portResult = await this.documentPort.saveDocument(
            message.documentUri,
            message.shortcutAttemptId,
          );
          break;
        case "undo":
          portResult = await this.documentPort.undoDocument(
            message.documentUri,
            message.shortcutAttemptId,
          );
          break;
        case "redo":
          portResult = await this.documentPort.redoDocument(
            message.documentUri,
            message.shortcutAttemptId,
          );
          break;
      }
    } catch (error: unknown) {
      await this.resyncAfterPortFailure(
        session,
        message.documentUri,
        `${message.kind} failed: ${errorNote(error)}`,
      );
      return;
    }

    if (!isUsableSnapshot(message.documentUri, portResult.snapshot)) {
      this.post(session.endpoint, {
        kind: "protocol-error",
        note: `Document port returned an invalid ${message.kind} result.`,
      });
      return;
    }
    if (portResult.kind === "rejected") {
      this.resync(session, portResult.snapshot, "port-rejected", portResult.note);
      return;
    }

    // The coordinator read authoritative state after every preceding queued
    // operation before entering this method, so this command is a FIFO barrier.
    this.acknowledge(session, message, portResult.snapshot, queue, causalId, receiveOrdinal);
    this.broadcastSnapshot(
      message.documentUri,
      message.kind,
      portResult.snapshot,
      message.sessionId,
      {
        causalId,
        queue,
        receiveOrdinal,
        originSessionId: message.sessionId,
        operationSequence: message.sequence,
      },
    );
  }

  private async resyncAfterPortFailure(
    session: SessionState,
    documentUri: string,
    note: string,
  ): Promise<void> {
    try {
      const snapshot = await this.documentPort.readDocument(documentUri);
      if (isUsableSnapshot(documentUri, snapshot)) {
        this.resync(session, snapshot, "port-inconsistent", note);
        return;
      }
    } catch {
      // The explicit protocol error below is the only safe response when no
      // authoritative snapshot can be obtained.
    }

    this.post(session.endpoint, { kind: "protocol-error", note });
  }

  private acknowledge(
    session: SessionState,
    message: Exclude<WebviewToHostMessage, { readonly kind: "diagnostic" }>,
    snapshot: DocumentSnapshot,
    queue: QueueContext,
    causalId: string,
    receiveOrdinal: number,
  ): void {
    this.diagnostics.record("coordinator.ack", {
      operation: message.kind,
      sequence: message.sequence,
      originSessionId: message.sessionId,
      documentVersion: snapshot.documentVersion,
      textLength: snapshot.text.length,
      textFingerprint: textFingerprint(snapshot.text),
      causalId,
      receiveOrdinal,
      queueEnqueueOrdinal: queue.enqueueOrdinal,
      queueStartOrdinal: queue.startOrdinal,
    });
    this.post(session.endpoint, {
      kind: "operation-ack",
      operation: message.kind,
      sequence: message.sequence,
      ...snapshot,
      correlation: this.correlation(
        causalId,
        `publication-${String(this.nextPublicationOrdinal++)}`,
        "operation-ack",
        queue,
        message.sessionId,
        message.sequence,
      ),
    });
  }

  private resync(
    session: SessionState,
    snapshot: DocumentSnapshot,
    reason: ResyncMessage["reason"],
    note: string,
  ): void {
    this.diagnostics.record("coordinator.resync", {
      reason,
      documentVersion: snapshot.documentVersion,
      nextSequence: session.nextSequence,
      note,
      textLength: snapshot.text.length,
    });
    this.post(session.endpoint, {
      kind: "resync",
      reason,
      nextSequence: session.nextSequence,
      note,
      ...snapshot,
    });
  }

  private broadcastSnapshot(
    documentUri: string,
    reason: BroadcastReason,
    snapshot: DocumentSnapshot,
    excludedSessionId?: string,
    origin?: {
      readonly causalId: string;
      readonly queue: QueueContext;
      readonly receiveOrdinal?: number;
      readonly originSessionId?: string;
      readonly operationSequence?: number;
      readonly externalEventId?: string;
    },
  ): void {
    const sessions = this.sessionsByDocument.get(documentUri);
    if (sessions === undefined) {
      return;
    }

    const message: HostToWebviewMessage = {
      kind: "document-update",
      reason,
      ...snapshot,
      ...(origin === undefined
        ? {}
        : {
            correlation: this.correlation(
              origin.causalId,
              `publication-${String(this.nextPublicationOrdinal++)}`,
              reason === "external" ? "external-event" : "operation-peer",
              origin.queue,
              origin.originSessionId,
              origin.operationSequence,
              origin.externalEventId,
            ),
          }),
    };
    let peerCount = 0;
    for (const [sessionId, session] of sessions) {
      if (sessionId === excludedSessionId) {
        continue;
      }
      this.post(session.endpoint, message);
      peerCount += 1;
    }
    this.diagnostics.record("coordinator.broadcast", {
      reason,
      originSessionId: excludedSessionId ?? "external",
      excludedSessionId: excludedSessionId ?? "none",
      peerCount,
      logicalOrder: excludedSessionId === undefined ? "external" : "after-ack",
      causalId: origin?.causalId ?? "untraced",
      externalEventId: origin?.externalEventId ?? "",
      queueEnqueueOrdinal: origin?.queue.enqueueOrdinal ?? -1,
      queueStartOrdinal: origin?.queue.startOrdinal ?? -1,
    });
  }

  private broadcastProtocolError(documentUri: string, note: string): void {
    const sessions = this.sessionsByDocument.get(documentUri);
    if (sessions === undefined) {
      return;
    }
    for (const session of sessions.values()) {
      this.post(session.endpoint, { kind: "protocol-error", note });
    }
  }

  private getSession(documentUri: string, sessionId: string): SessionState | undefined {
    return this.sessionsByDocument.get(documentUri)?.get(sessionId);
  }

  private async enqueue<T>(
    documentUri: string,
    operation: (queue: QueueContext) => Promise<T>,
  ): Promise<T> {
    const enqueueOrdinal = this.nextQueueEnqueueOrdinal++;
    this.diagnostics.record("coordinator.queue.enqueued", { documentUri, enqueueOrdinal });
    const prior = this.queues.get(documentUri) ?? Promise.resolve();
    const current = prior
      .catch((): void => undefined)
      .then(async (): Promise<T> => {
        const queue = { enqueueOrdinal, startOrdinal: this.nextQueueStartOrdinal++ };
        this.diagnostics.record("coordinator.queue.started", {
          documentUri,
          enqueueOrdinal: queue.enqueueOrdinal,
          startOrdinal: queue.startOrdinal,
        });
        try {
          return await operation(queue);
        } finally {
          this.diagnostics.record("coordinator.queue.ended", {
            documentUri,
            enqueueOrdinal: queue.enqueueOrdinal,
            startOrdinal: queue.startOrdinal,
          });
        }
      });
    this.queues.set(
      documentUri,
      current.then(
        (): void => undefined,
        (): void => undefined,
      ),
    );
    return current;
  }

  private correlation(
    causalId: string,
    publicationId: string,
    source: HostMessageCorrelation["source"],
    queue: QueueContext,
    originSessionId?: string,
    operationSequence?: number,
    externalEventId?: string,
  ): HostMessageCorrelation {
    return {
      causalId,
      publicationId,
      source,
      queueEnqueueOrdinal: queue.enqueueOrdinal,
      queueStartOrdinal: queue.startOrdinal,
      ...(originSessionId === undefined ? {} : { originSessionId }),
      ...(operationSequence === undefined ? {} : { operationSequence }),
      ...(externalEventId === undefined ? {} : { externalEventId }),
    };
  }

  private post(endpoint: WebviewEndpoint, message: HostToWebviewMessage): void {
    try {
      endpoint.postMessage(message);
    } catch {
      // A disposed webview cannot be allowed to interrupt the shared document queue.
    }
  }
}

function messageTrace(
  message: Exclude<WebviewToHostMessage, { readonly kind: "diagnostic" }>,
): Readonly<Record<string, number | string>> {
  return {
    documentVersion: message.kind === "edit" ? message.documentVersion : "",
    kind: message.kind,
    sequence: message.sequence,
    shortcutAttemptId: message.kind === "edit" ? "" : (message.shortcutAttemptId ?? "untraced"),
  };
}
