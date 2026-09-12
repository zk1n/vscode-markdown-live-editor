import { MAX_IMAGE_BYTES, isRichIdentity, type RichIdentity } from "./richMessages.js";
export interface SaveAsImageRequest extends RichIdentity {
  readonly kind: "save-as-image";
  readonly documentVersion: number;
  readonly anchor: number;
  readonly head: number;
  readonly name?: string;
  readonly data?: string;
}
export function decodeSaveAsImage(value: unknown): SaveAsImageRequest | undefined {
  if (!isRichIdentity(value) || value["kind"] !== "save-as-image") return undefined;
  const version = value["documentVersion"],
    anchor = value["anchor"],
    head = value["head"];
  if (
    typeof version !== "number" ||
    typeof anchor !== "number" ||
    typeof head !== "number" ||
    ![version, anchor, head].every((item) => Number.isSafeInteger(item) && item >= 0)
  )
    return undefined;
  const name = value["name"],
    data = value["data"];
  if (
    (name !== undefined && (typeof name !== "string" || name.length > 255)) ||
    (data !== undefined &&
      (typeof data !== "string" || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4))
  )
    return undefined;
  return {
    kind: "save-as-image",
    protocolVersion: value.protocolVersion,
    documentUri: value.documentUri,
    sessionId: value.sessionId,
    controllerId: value.controllerId,
    documentVersion: version,
    anchor,
    head,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof data === "string" ? { data } : {}),
  };
}
