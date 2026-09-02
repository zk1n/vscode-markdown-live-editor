import {
  decodeWebviewToHostMessage,
  type ClientEditMessage,
  type DocumentUpdateMessage,
  type HostToWebviewMessage,
  type ResyncMessage,
  type WebviewToHostMessage,
} from "../../protocol/messages.js";
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
  ): Promise<DocumentPortResult>;
  saveDocument(documentUri: string): Promise<DocumentPortResult>;
  undoDocument(documentUri: string): Promise<DocumentPortResult>;
  redoDocument(documentUri: string): Promise<DocumentPortResult>;
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

  public constructor(private readonly documentPort: DocumentPort) {}

  public async openSession(
    documentUri: string,
    sessionId: string,
    endpoint: WebviewEndpoint,
  ): Promise<OpenSessionResult> {
    return this.enqueue(documentUri, async (): Promise<OpenSessionResult> => {
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
      this.post(endpoint, { kind: "protocol-error", note: decoded.error });
      return;
    }

    await this.enqueue(decoded.value.documentUri, async (): Promise<void> => {
      await this.process(decoded.value, endpoint);
    });
  }

  /**
   * VS Code integration calls this after an authoritative external document
   * change. The snapshot is broadcast without trying to rebase pending edits.
   */
  public async publishExternalChange(documentUri: string): Promise<void> {
    await this.enqueue(documentUri, async (): Promise<void> => {
      try {
        const snapshot = await this.documentPort.readDocument(documentUri);
        if (!isUsableSnapshot(documentUri, snapshot)) {
          this.broadcastProtocolError(
            documentUri,
            "Document port returned an invalid external-change snapshot.",
          );
          return;
        }
        this.broadcastSnapshot(documentUri, "external", snapshot);
      } catch (error: unknown) {
        this.broadcastProtocolError(
          documentUri,
          `Unable to read external document change: ${errorNote(error)}`,
        );
      }
    });
  }

  private async process(
    message: WebviewToHostMessage,
    receivedEndpoint: WebviewEndpoint,
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
      await this.processEdit(session, message, snapshot);
      return;
    }

    await this.processBarrier(session, message);
  }

  private async processEdit(
    session: SessionState,
    message: ClientEditMessage,
    snapshot: DocumentSnapshot,
  ): Promise<void> {
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
      this.resync(session, snapshot, "change-mismatch", appliedChanges.note);
      return;
    }

    let portResult: DocumentPortResult;
    try {
      portResult = await this.documentPort.replaceDocument(
        message.documentUri,
        snapshot.documentVersion,
        appliedChanges.text,
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

    this.acknowledge(session, message, portResult.snapshot);
    this.broadcastSnapshot(message.documentUri, "edit", portResult.snapshot);
  }

  private async processBarrier(
    session: SessionState,
    message: Exclude<WebviewToHostMessage, ClientEditMessage>,
  ): Promise<void> {
    let portResult: DocumentPortResult;
    try {
      switch (message.kind) {
        case "save":
          portResult = await this.documentPort.saveDocument(message.documentUri);
          break;
        case "undo":
          portResult = await this.documentPort.undoDocument(message.documentUri);
          break;
        case "redo":
          portResult = await this.documentPort.redoDocument(message.documentUri);
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
    this.acknowledge(session, message, portResult.snapshot);
    this.broadcastSnapshot(message.documentUri, message.kind, portResult.snapshot);
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
    message: WebviewToHostMessage,
    snapshot: DocumentSnapshot,
  ): void {
    this.post(session.endpoint, {
      kind: "operation-ack",
      operation: message.kind,
      sequence: message.sequence,
      ...snapshot,
    });
  }

  private resync(
    session: SessionState,
    snapshot: DocumentSnapshot,
    reason: ResyncMessage["reason"],
    note: string,
  ): void {
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
  ): void {
    const sessions = this.sessionsByDocument.get(documentUri);
    if (sessions === undefined) {
      return;
    }

    const message: HostToWebviewMessage = {
      kind: "document-update",
      reason,
      ...snapshot,
    };
    for (const session of sessions.values()) {
      this.post(session.endpoint, message);
    }
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

  private async enqueue<T>(documentUri: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(documentUri) ?? Promise.resolve();
    const current = prior.catch((): void => undefined).then(operation);
    this.queues.set(
      documentUri,
      current.then(
        (): void => undefined,
        (): void => undefined,
      ),
    );
    return current;
  }

  private post(endpoint: WebviewEndpoint, message: HostToWebviewMessage): void {
    try {
      endpoint.postMessage(message);
    } catch {
      // A disposed webview cannot be allowed to interrupt the shared document queue.
    }
  }
}
