import { PROTOCOL_VERSION } from "./messages.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export interface RichIdentity {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly documentUri: string;
  readonly sessionId: string;
  readonly controllerId: string;
}
export type RichOperation =
  "image-resolve" | "image-import" | "image-pick" | "link-preview" | "link-open";
export interface RichRequest extends RichIdentity {
  readonly kind: "rich-request";
  readonly requestId: number;
  readonly operation: RichOperation;
  readonly documentVersion: number;
  readonly target?: string;
  readonly name?: string;
  readonly data?: string;
}
export interface RichResponse extends RichIdentity {
  readonly kind: "rich-response";
  readonly requestId: number;
  readonly documentVersion: number;
  readonly ok: boolean;
  readonly note?: string;
  readonly url?: string;
  readonly markdown?: string;
  readonly text?: string;
  readonly title?: string;
  readonly offset?: number;
}
export type RichCommand = "find" | "replace" | "insert-table" | "insert-image";
export interface RichCommandMessage extends RichIdentity {
  readonly kind: "rich-command";
  readonly command: RichCommand;
}

export function isRichIdentity(value: unknown): value is RichIdentity & Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["protocolVersion"] === PROTOCOL_VERSION &&
    ["documentUri", "sessionId", "controllerId"].every(
      (key) =>
        typeof record[key] === "string" && record[key].length > 0 && record[key].length <= 4096,
    )
  );
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function decodeRichRequest(value: unknown): RichRequest | undefined {
  if (
    !isRichIdentity(value) ||
    value["kind"] !== "rich-request" ||
    !integer(value["requestId"]) ||
    !integer(value["documentVersion"])
  )
    return undefined;
  const operation = value["operation"];
  if (
    operation !== "image-resolve" &&
    operation !== "image-import" &&
    operation !== "image-pick" &&
    operation !== "link-preview" &&
    operation !== "link-open"
  )
    return undefined;
  const target = value["target"];
  const name = value["name"];
  const data = value["data"];
  if (
    (target !== undefined && (typeof target !== "string" || target.length > 8192)) ||
    (name !== undefined && (typeof name !== "string" || name.length > 255)) ||
    (data !== undefined &&
      (typeof data !== "string" || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4))
  )
    return undefined;
  if (
    (operation === "image-resolve" || operation === "link-preview" || operation === "link-open") &&
    typeof target !== "string"
  )
    return undefined;
  if (operation === "image-import" && typeof data !== "string") return undefined;
  return {
    kind: "rich-request",
    protocolVersion: PROTOCOL_VERSION,
    documentUri: value.documentUri,
    sessionId: value.sessionId,
    controllerId: value.controllerId,
    requestId: value["requestId"],
    documentVersion: value["documentVersion"],
    operation,
    ...(typeof target === "string" ? { target } : {}),
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof data === "string" ? { data } : {}),
  };
}
export function decodeRichResponse(value: unknown): RichResponse | undefined {
  if (
    !isRichIdentity(value) ||
    value["kind"] !== "rich-response" ||
    !integer(value["requestId"]) ||
    !integer(value["documentVersion"]) ||
    typeof value["ok"] !== "boolean"
  )
    return undefined;
  for (const key of ["note", "url", "markdown", "text", "title"] as const)
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 65536))
      return undefined;
  if (value["offset"] !== undefined && !integer(value["offset"])) return undefined;
  return {
    kind: "rich-response",
    protocolVersion: PROTOCOL_VERSION,
    documentUri: value.documentUri,
    sessionId: value.sessionId,
    controllerId: value.controllerId,
    requestId: value["requestId"],
    documentVersion: value["documentVersion"],
    ok: value["ok"],
    ...(typeof value["note"] === "string" ? { note: value["note"] } : {}),
    ...(typeof value["url"] === "string" ? { url: value["url"] } : {}),
    ...(typeof value["markdown"] === "string" ? { markdown: value["markdown"] } : {}),
    ...(typeof value["text"] === "string" ? { text: value["text"] } : {}),
    ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
    ...(typeof value["offset"] === "number" ? { offset: value["offset"] } : {}),
  };
}
export function decodeRichCommand(value: unknown): RichCommandMessage | undefined {
  if (!isRichIdentity(value) || value["kind"] !== "rich-command") return undefined;
  const command = value["command"];
  if (
    command !== "find" &&
    command !== "replace" &&
    command !== "insert-table" &&
    command !== "insert-image"
  )
    return undefined;
  return {
    kind: "rich-command",
    protocolVersion: PROTOCOL_VERSION,
    documentUri: value.documentUri,
    sessionId: value.sessionId,
    controllerId: value.controllerId,
    command,
  };
}
