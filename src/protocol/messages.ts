export const PROTOCOL_VERSION = 1 as const;

export interface WirePosition {
  readonly line: number;
  readonly character: number;
}

export interface WireRange {
  readonly start: WirePosition;
  readonly end: WirePosition;
}

/**
 * A change is expressed against the complete authoritative text at
 * `documentVersion`. `expectedText` makes positional edits fail closed.
 */
export interface WireChange {
  readonly range: WireRange;
  readonly expectedText: string;
  readonly text: string;
}

interface ClientOperationBase {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly documentUri: string;
  readonly sessionId: string;
  readonly sequence: number;
}

export interface ClientEditMessage extends ClientOperationBase {
  readonly kind: "edit";
  readonly documentVersion: number;
  readonly changes: readonly WireChange[];
}

export interface ClientBarrierMessage extends ClientOperationBase {
  readonly kind: "save" | "undo" | "redo";
  readonly shortcutAttemptId?: string;
}

export interface ClientDiagnosticMessage {
  readonly kind: "diagnostic";
  readonly documentUri: string;
  readonly sessionId: string;
  readonly event: string;
  readonly details: Readonly<Record<string, boolean | number | string>>;
}

export type WebviewToHostMessage =
  ClientEditMessage | ClientBarrierMessage | ClientDiagnosticMessage;

export interface DocumentSnapshotMessage {
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly text: string;
  /**
   * Metadata-only host correlation. It is intentionally optional so that
   * protocol fixtures and older Webviews remain decodable; it must never be
   * used to relax authority or acknowledgement checks.
   */
  readonly correlation?: HostMessageCorrelation;
}

export interface HostMessageCorrelation {
  readonly causalId: string;
  readonly publicationId: string;
  readonly source: "opened" | "operation-ack" | "operation-peer" | "external-event" | "resync";
  readonly queueEnqueueOrdinal: number;
  readonly queueStartOrdinal: number;
  readonly originSessionId?: string;
  readonly operationSequence?: number;
  readonly externalEventId?: string;
}

export interface OperationAcknowledgement extends DocumentSnapshotMessage {
  readonly kind: "operation-ack";
  readonly operation: ClientEditMessage["kind"] | ClientBarrierMessage["kind"];
  readonly sequence: number;
}

export interface DocumentUpdateMessage extends DocumentSnapshotMessage {
  readonly kind: "document-update";
  readonly reason: "opened" | "edit" | "save" | "undo" | "redo" | "external";
}

export interface ResyncMessage extends DocumentSnapshotMessage {
  readonly kind: "resync";
  readonly reason:
    "sequence-gap" | "stale-version" | "change-mismatch" | "port-rejected" | "port-inconsistent";
  readonly nextSequence: number;
  readonly note: string;
}

export interface ProtocolErrorMessage {
  readonly kind: "protocol-error";
  readonly note: string;
}

export type HostToWebviewMessage =
  OperationAcknowledgement | DocumentUpdateMessage | ResyncMessage | ProtocolErrorMessage;

export type ProtocolDecodeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, field: string): ProtocolDecodeResult<string> {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: `${field} must be a non-empty string.` };
  }

  return { ok: true, value };
}

function readNonNegativeInteger(value: unknown, field: string): ProtocolDecodeResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return { ok: false, error: `${field} must be a non-negative safe integer.` };
  }

  return { ok: true, value };
}

function decodePosition(value: unknown, field: string): ProtocolDecodeResult<WirePosition> {
  if (!isRecord(value)) {
    return { ok: false, error: `${field} must be an object.` };
  }

  const line = readNonNegativeInteger(value["line"], `${field}.line`);
  if (!line.ok) {
    return line;
  }

  const character = readNonNegativeInteger(value["character"], `${field}.character`);
  if (!character.ok) {
    return character;
  }

  return { ok: true, value: { line: line.value, character: character.value } };
}

function comparePositions(left: WirePosition, right: WirePosition): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.character - right.character;
}

function decodeRange(value: unknown, field: string): ProtocolDecodeResult<WireRange> {
  if (!isRecord(value)) {
    return { ok: false, error: `${field} must be an object.` };
  }

  const start = decodePosition(value["start"], `${field}.start`);
  if (!start.ok) {
    return start;
  }

  const end = decodePosition(value["end"], `${field}.end`);
  if (!end.ok) {
    return end;
  }

  if (comparePositions(start.value, end.value) > 0) {
    return { ok: false, error: `${field}.start must not follow ${field}.end.` };
  }

  return { ok: true, value: { start: start.value, end: end.value } };
}

function decodeChange(value: unknown, index: number): ProtocolDecodeResult<WireChange> {
  const field = `changes[${String(index)}]`;
  if (!isRecord(value)) {
    return { ok: false, error: `${field} must be an object.` };
  }

  const range = decodeRange(value["range"], `${field}.range`);
  if (!range.ok) {
    return range;
  }

  if (typeof value["expectedText"] !== "string") {
    return { ok: false, error: `${field}.expectedText must be a string.` };
  }

  if (typeof value["text"] !== "string") {
    return { ok: false, error: `${field}.text must be a string.` };
  }

  return {
    ok: true,
    value: {
      range: range.value,
      expectedText: value["expectedText"],
      text: value["text"],
    },
  };
}

function decodeOperationBase(
  value: Record<string, unknown>,
): ProtocolDecodeResult<Omit<ClientOperationBase, "protocolVersion">> {
  if (value["protocolVersion"] !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `protocolVersion must be ${String(PROTOCOL_VERSION)}.`,
    };
  }

  const documentUri = readNonEmptyString(value["documentUri"], "documentUri");
  if (!documentUri.ok) {
    return documentUri;
  }

  const sessionId = readNonEmptyString(value["sessionId"], "sessionId");
  if (!sessionId.ok) {
    return sessionId;
  }

  const sequence = readNonNegativeInteger(value["sequence"], "sequence");
  if (!sequence.ok) {
    return sequence;
  }

  return {
    ok: true,
    value: {
      documentUri: documentUri.value,
      sessionId: sessionId.value,
      sequence: sequence.value,
    },
  };
}

export function decodeWebviewToHostMessage(
  value: unknown,
): ProtocolDecodeResult<WebviewToHostMessage> {
  if (!isRecord(value)) {
    return { ok: false, error: "Message must be an object." };
  }

  const base = decodeOperationBase(value);
  const kind = value["kind"];
  if (kind === "diagnostic") {
    const documentUri = readNonEmptyString(value["documentUri"], "documentUri");
    const sessionId = readNonEmptyString(value["sessionId"], "sessionId");
    if (!documentUri.ok || !sessionId.ok || typeof value["event"] !== "string") {
      return { ok: false, error: "Diagnostic message is invalid." };
    }
    if (value["event"].length > 96 || !isRecord(value["details"])) {
      return { ok: false, error: "Diagnostic details must be an object." };
    }
    const details: Record<string, boolean | number | string> = {};
    const entries = Object.entries(value["details"]);
    if (entries.length > 32) {
      return { ok: false, error: "Diagnostic details exceed the bounded limit." };
    }
    for (const [key, detail] of entries) {
      if (
        key.length > 64 ||
        (typeof detail !== "boolean" && typeof detail !== "number" && typeof detail !== "string") ||
        (typeof detail === "string" && detail.length > 160)
      ) {
        return { ok: false, error: "Diagnostic detail is invalid." };
      }
      details[key] = detail;
    }
    return {
      ok: true,
      value: {
        kind,
        documentUri: documentUri.value,
        sessionId: sessionId.value,
        event: value["event"],
        details,
      },
    };
  }
  if (!base.ok) {
    return base;
  }
  if (kind === "edit") {
    const documentVersion = readNonNegativeInteger(value["documentVersion"], "documentVersion");
    if (!documentVersion.ok) {
      return documentVersion;
    }

    if (!Array.isArray(value["changes"]) || value["changes"].length === 0) {
      return { ok: false, error: "changes must be a non-empty array." };
    }

    const changes: WireChange[] = [];
    for (const [index, change] of value["changes"].entries()) {
      const decodedChange = decodeChange(change, index);
      if (!decodedChange.ok) {
        return decodedChange;
      }
      changes.push(decodedChange.value);
    }

    return {
      ok: true,
      value: {
        kind,
        protocolVersion: PROTOCOL_VERSION,
        ...base.value,
        documentVersion: documentVersion.value,
        changes,
      },
    };
  }

  if (kind === "save" || kind === "undo" || kind === "redo") {
    const shortcutAttemptId = value["shortcutAttemptId"];
    if (
      (shortcutAttemptId !== undefined && typeof shortcutAttemptId !== "string") ||
      (typeof shortcutAttemptId === "string" && shortcutAttemptId.length > 96)
    ) {
      return { ok: false, error: "shortcutAttemptId must be a string when present." };
    }
    return {
      ok: true,
      value:
        shortcutAttemptId === undefined
          ? { kind, protocolVersion: PROTOCOL_VERSION, ...base.value }
          : { kind, protocolVersion: PROTOCOL_VERSION, ...base.value, shortcutAttemptId },
    };
  }

  return { ok: false, error: "kind must be edit, save, undo, or redo." };
}

function decodeSnapshot(
  value: Record<string, unknown>,
): ProtocolDecodeResult<DocumentSnapshotMessage> {
  const documentUri = readNonEmptyString(value["documentUri"], "documentUri");
  if (!documentUri.ok) {
    return documentUri;
  }
  const documentVersion = readNonNegativeInteger(value["documentVersion"], "documentVersion");
  if (!documentVersion.ok) {
    return documentVersion;
  }
  if (typeof value["text"] !== "string") {
    return { ok: false, error: "text must be a string." };
  }

  const correlation = decodeHostMessageCorrelation(value["correlation"]);
  if (!correlation.ok) {
    return correlation;
  }

  return {
    ok: true,
    value:
      correlation.value === undefined
        ? {
            documentUri: documentUri.value,
            documentVersion: documentVersion.value,
            text: value["text"],
          }
        : {
            documentUri: documentUri.value,
            documentVersion: documentVersion.value,
            text: value["text"],
            correlation: correlation.value,
          },
  };
}

function decodeHostMessageCorrelation(
  value: unknown,
): ProtocolDecodeResult<HostMessageCorrelation | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "correlation must be an object when present." };
  }
  const causalId = readNonEmptyString(value["causalId"], "correlation.causalId");
  const publicationId = readNonEmptyString(value["publicationId"], "correlation.publicationId");
  const queueEnqueueOrdinal = readNonNegativeInteger(
    value["queueEnqueueOrdinal"],
    "correlation.queueEnqueueOrdinal",
  );
  const queueStartOrdinal = readNonNegativeInteger(
    value["queueStartOrdinal"],
    "correlation.queueStartOrdinal",
  );
  const source = value["source"];
  if (!causalId.ok) {
    return { ok: false, error: causalId.error };
  }
  if (!publicationId.ok) {
    return { ok: false, error: publicationId.error };
  }
  if (!queueEnqueueOrdinal.ok) {
    return { ok: false, error: queueEnqueueOrdinal.error };
  }
  if (!queueStartOrdinal.ok) {
    return { ok: false, error: queueStartOrdinal.error };
  }
  if (
    source !== "opened" &&
    source !== "operation-ack" &&
    source !== "operation-peer" &&
    source !== "external-event" &&
    source !== "resync"
  ) {
    return { ok: false, error: "correlation.source is invalid." };
  }
  const originSessionId = value["originSessionId"];
  const externalEventId = value["externalEventId"];
  const operationSequenceValue = value["operationSequence"];
  if (
    (originSessionId !== undefined && typeof originSessionId !== "string") ||
    (externalEventId !== undefined && typeof externalEventId !== "string") ||
    (operationSequenceValue !== undefined &&
      (typeof operationSequenceValue !== "number" ||
        !Number.isSafeInteger(operationSequenceValue) ||
        operationSequenceValue < 0))
  ) {
    return { ok: false, error: "correlation optional fields are invalid." };
  }
  return {
    ok: true,
    value: {
      causalId: causalId.value,
      publicationId: publicationId.value,
      source,
      queueEnqueueOrdinal: queueEnqueueOrdinal.value,
      queueStartOrdinal: queueStartOrdinal.value,
      ...(originSessionId === undefined ? {} : { originSessionId }),
      ...(operationSequenceValue === undefined
        ? {}
        : { operationSequence: operationSequenceValue }),
      ...(externalEventId === undefined ? {} : { externalEventId }),
    },
  };
}

export function decodeHostToWebviewMessage(
  value: unknown,
): ProtocolDecodeResult<HostToWebviewMessage> {
  if (!isRecord(value)) {
    return { ok: false, error: "Message must be an object." };
  }

  if (value["kind"] === "protocol-error") {
    if (typeof value["note"] !== "string") {
      return { ok: false, error: "note must be a string." };
    }
    return { ok: true, value: { kind: "protocol-error", note: value["note"] } };
  }

  const snapshot = decodeSnapshot(value);
  if (!snapshot.ok) {
    return snapshot;
  }

  if (value["kind"] === "operation-ack") {
    const sequence = readNonNegativeInteger(value["sequence"], "sequence");
    if (!sequence.ok) {
      return sequence;
    }
    const operation = value["operation"];
    if (
      operation !== "edit" &&
      operation !== "save" &&
      operation !== "undo" &&
      operation !== "redo"
    ) {
      return { ok: false, error: "operation is invalid." };
    }
    return {
      ok: true,
      value: { kind: "operation-ack", ...snapshot.value, sequence: sequence.value, operation },
    };
  }

  if (value["kind"] === "document-update") {
    const reason = value["reason"];
    if (
      reason !== "opened" &&
      reason !== "edit" &&
      reason !== "save" &&
      reason !== "undo" &&
      reason !== "redo" &&
      reason !== "external"
    ) {
      return { ok: false, error: "document-update reason is invalid." };
    }
    return { ok: true, value: { kind: "document-update", ...snapshot.value, reason } };
  }

  if (value["kind"] === "resync") {
    const nextSequence = readNonNegativeInteger(value["nextSequence"], "nextSequence");
    if (!nextSequence.ok) {
      return nextSequence;
    }
    const reason = value["reason"];
    if (
      reason !== "sequence-gap" &&
      reason !== "stale-version" &&
      reason !== "change-mismatch" &&
      reason !== "port-rejected" &&
      reason !== "port-inconsistent"
    ) {
      return { ok: false, error: "resync reason is invalid." };
    }
    if (typeof value["note"] !== "string") {
      return { ok: false, error: "resync note must be a string." };
    }
    return {
      ok: true,
      value: {
        kind: "resync",
        ...snapshot.value,
        nextSequence: nextSequence.value,
        reason,
        note: value["note"],
      },
    };
  }

  return { ok: false, error: "Host message kind is invalid." };
}
