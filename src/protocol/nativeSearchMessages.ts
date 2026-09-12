import { isRichIdentity, type RichIdentity } from "./richMessages.js";

export interface NativeSearchRequest extends RichIdentity {
  readonly kind: "native-search";
  readonly mode: "find" | "replace";
  readonly documentVersion: number;
  readonly anchor: number;
  readonly head: number;
}
export function decodeNativeSearchRequest(value: unknown): NativeSearchRequest | undefined {
  if (
    !isRichIdentity(value) ||
    value["kind"] !== "native-search" ||
    (value["mode"] !== "find" && value["mode"] !== "replace") ||
    !["documentVersion", "anchor", "head"].every(
      (key) =>
        typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0,
    )
  )
    return undefined;
  return {
    kind: "native-search",
    protocolVersion: value.protocolVersion,
    documentUri: value.documentUri,
    sessionId: value.sessionId,
    controllerId: value.controllerId,
    mode: value["mode"],
    documentVersion: value["documentVersion"] as number,
    anchor: value["anchor"] as number,
    head: value["head"] as number,
  };
}
