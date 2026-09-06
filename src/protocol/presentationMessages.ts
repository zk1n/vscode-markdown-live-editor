import { PROTOCOL_VERSION, type ProtocolDecodeResult } from "./messages.js";

interface EditorIdentity {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly documentUri: string;
  readonly sessionId: string;
  readonly controllerId: string;
}

/** Presentation-only state. It never authorizes a document mutation. */
export interface EditorStateMessage extends EditorIdentity {
  readonly kind: "editor-state";
  readonly reportSequence: number;
  readonly documentVersion: number;
  readonly selectionAnchor: number;
  readonly selectionHead: number;
  readonly line: number;
  readonly column: number;
  readonly focused: boolean;
  readonly composing: boolean;
  readonly recoveryActive: boolean;
  readonly barrierActive: boolean;
  readonly insertSpaces: boolean;
  readonly tabSize: number;
}

/** Host-resolved effective editor configuration for exactly one controller. */
export interface EditorConfigurationMessage extends EditorIdentity {
  readonly kind: "editor-configuration";
  readonly revision: number;
  readonly insertSpaces: boolean;
  readonly tabSize: number;
}

/** A host UI request that must enter the Webview's existing FIFO boundary. */
export interface EditorCommandMessage extends EditorIdentity {
  readonly kind: "editor-command";
  readonly requestId: string;
  readonly documentVersion: number;
  readonly command: "undo" | "redo" | "set-eol";
  readonly eol?: "lf" | "crlf";
}

/** Host authorization to focus only after an acknowledged history operation. */
export interface RestoreHistoryFocusMessage extends EditorIdentity {
  readonly kind: "restore-history-focus";
  readonly requestId: string;
  readonly documentVersion: number;
  readonly operation: "undo" | "redo";
}

/** Validated presentation CSS for a single controller generation. */
export interface StyleSnapshotMessage extends EditorIdentity {
  readonly kind: "style-snapshot";
  readonly revision: number;
  readonly css: string;
}

export type WebviewPresentationMessage = EditorStateMessage;

export type HostPresentationMessage =
  | EditorConfigurationMessage
  | EditorCommandMessage
  | RestoreHistoryFocusMessage
  | StyleSnapshotMessage;

export function decodeEditorStateMessage(value: unknown): ProtocolDecodeResult<EditorStateMessage> {
  if (!isRecord(value) || value["kind"] !== "editor-state") {
    return { ok: false, error: "kind must be editor-state." };
  }
  const identity = decodeIdentity(value);
  if (!identity.ok) return identity;
  const reportSequence = readNonNegativeInteger(value["reportSequence"], "reportSequence");
  const documentVersion = readNonNegativeInteger(value["documentVersion"], "documentVersion");
  const selectionAnchor = readNonNegativeInteger(value["selectionAnchor"], "selectionAnchor");
  const selectionHead = readNonNegativeInteger(value["selectionHead"], "selectionHead");
  const line = readPositiveInteger(value["line"], "line");
  const column = readPositiveInteger(value["column"], "column");
  const tabSize = readPositiveInteger(value["tabSize"], "tabSize");
  if (!reportSequence.ok) return reportSequence;
  if (!documentVersion.ok) return documentVersion;
  if (!selectionAnchor.ok) return selectionAnchor;
  if (!selectionHead.ok) return selectionHead;
  if (!line.ok) return line;
  if (!column.ok) return column;
  if (!tabSize.ok || tabSize.value > 32) {
    return { ok: false, error: "tabSize must be an integer from 1 through 32." };
  }
  const flags = readFlags(value, [
    "focused",
    "composing",
    "recoveryActive",
    "barrierActive",
    "insertSpaces",
  ]);
  if (!flags.ok) return flags;
  return {
    ok: true,
    value: {
      kind: "editor-state",
      ...identity.value,
      reportSequence: reportSequence.value,
      documentVersion: documentVersion.value,
      selectionAnchor: selectionAnchor.value,
      selectionHead: selectionHead.value,
      line: line.value,
      column: column.value,
      focused: flags.value.focused,
      composing: flags.value.composing,
      recoveryActive: flags.value.recoveryActive,
      barrierActive: flags.value.barrierActive,
      insertSpaces: flags.value.insertSpaces,
      tabSize: tabSize.value,
    },
  };
}

export function decodeHostPresentationMessage(
  value: unknown,
): ProtocolDecodeResult<HostPresentationMessage> {
  if (!isRecord(value)) {
    return { ok: false, error: "Presentation message must be an object." };
  }
  const identity = decodeIdentity(value);
  if (!identity.ok) return identity;
  switch (value["kind"]) {
    case "editor-configuration": {
      const revision = readNonNegativeInteger(value["revision"], "revision");
      const tabSize = readPositiveInteger(value["tabSize"], "tabSize");
      if (!revision.ok) return revision;
      if (!tabSize.ok || tabSize.value > 32) {
        return { ok: false, error: "tabSize must be an integer from 1 through 32." };
      }
      if (typeof value["insertSpaces"] !== "boolean") {
        return { ok: false, error: "insertSpaces must be a boolean." };
      }
      return {
        ok: true,
        value: {
          kind: "editor-configuration",
          ...identity.value,
          revision: revision.value,
          insertSpaces: value["insertSpaces"],
          tabSize: tabSize.value,
        },
      };
    }
    case "editor-command": {
      const requestId = readBoundedString(value["requestId"], "requestId", 96);
      const documentVersion = readNonNegativeInteger(value["documentVersion"], "documentVersion");
      if (!requestId.ok) return requestId;
      if (!documentVersion.ok) return documentVersion;
      const command = value["command"];
      if (command !== "undo" && command !== "redo" && command !== "set-eol") {
        return { ok: false, error: "editor-command command is invalid." };
      }
      const eol = value["eol"];
      if (command !== "set-eol" && eol !== undefined) {
        return { ok: false, error: "editor-command eol is invalid." };
      }
      if (command === "set-eol") {
        if (eol !== "lf" && eol !== "crlf") {
          return { ok: false, error: "editor-command eol is invalid." };
        }
        return {
          ok: true,
          value: {
            kind: "editor-command",
            ...identity.value,
            requestId: requestId.value,
            documentVersion: documentVersion.value,
            command,
            eol,
          },
        };
      }
      return {
        ok: true,
        value: {
          kind: "editor-command",
          ...identity.value,
          requestId: requestId.value,
          documentVersion: documentVersion.value,
          command,
        },
      };
    }
    case "restore-history-focus": {
      const requestId = readBoundedString(value["requestId"], "requestId", 96);
      const documentVersion = readNonNegativeInteger(value["documentVersion"], "documentVersion");
      if (!requestId.ok) return requestId;
      if (!documentVersion.ok) return documentVersion;
      const operation = value["operation"];
      if (operation !== "undo" && operation !== "redo") {
        return { ok: false, error: "restore-history-focus operation is invalid." };
      }
      return {
        ok: true,
        value: {
          kind: "restore-history-focus",
          ...identity.value,
          requestId: requestId.value,
          documentVersion: documentVersion.value,
          operation,
        },
      };
    }
    case "style-snapshot": {
      const revision = readNonNegativeInteger(value["revision"], "revision");
      if (!revision.ok) return revision;
      if (typeof value["css"] !== "string" || value["css"].length > 2 * 64 * 1024) {
        return { ok: false, error: "style-snapshot css is invalid or too large." };
      }
      return {
        ok: true,
        value: {
          kind: "style-snapshot",
          ...identity.value,
          revision: revision.value,
          css: value["css"],
        },
      };
    }
    default:
      return { ok: false, error: "Presentation message kind is invalid." };
  }
}

function decodeIdentity(value: Record<string, unknown>): ProtocolDecodeResult<EditorIdentity> {
  if (value["protocolVersion"] !== PROTOCOL_VERSION) {
    return { ok: false, error: `protocolVersion must be ${String(PROTOCOL_VERSION)}.` };
  }
  const documentUri = readBoundedString(value["documentUri"], "documentUri", 16_384);
  const sessionId = readBoundedString(value["sessionId"], "sessionId", 256);
  const controllerId = readBoundedString(value["controllerId"], "controllerId", 256);
  if (!documentUri.ok) return documentUri;
  if (!sessionId.ok) return sessionId;
  if (!controllerId.ok) return controllerId;
  return {
    ok: true,
    value: {
      protocolVersion: PROTOCOL_VERSION,
      documentUri: documentUri.value,
      sessionId: sessionId.value,
      controllerId: controllerId.value,
    },
  };
}

function readFlags<T extends string>(
  value: Record<string, unknown>,
  fields: readonly T[],
): ProtocolDecodeResult<Record<T, boolean>> {
  const flags = {} as Record<T, boolean>;
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate !== "boolean") {
      return { ok: false, error: `${field} must be a boolean.` };
    }
    flags[field] = candidate;
  }
  return { ok: true, value: flags };
}

function readBoundedString(
  value: unknown,
  field: string,
  maximumLength: number,
): ProtocolDecodeResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    return { ok: false, error: `${field} must be a bounded non-empty string.` };
  }
  return { ok: true, value };
}

function readNonNegativeInteger(value: unknown, field: string): ProtocolDecodeResult<number> {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { ok: true, value }
    : { ok: false, error: `${field} must be a non-negative safe integer.` };
}

function readPositiveInteger(value: unknown, field: string): ProtocolDecodeResult<number> {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? { ok: true, value }
    : { ok: false, error: `${field} must be a positive safe integer.` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
