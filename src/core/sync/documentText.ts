import type { WireChange, WirePosition } from "../../protocol/messages.js";

export type WireChangeApplicationResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly code: "invalid-position" | "overlapping-range" | "expected-text-mismatch";
      readonly note: string;
    };

interface ResolvedChange {
  readonly change: WireChange;
  readonly startOffset: number;
  readonly endOffset: number;
}

function offsetForPosition(text: string, position: WirePosition): number | undefined {
  let line = 0;
  let lineStart = 0;

  for (let index = 0; index < text.length && line < position.line; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }

  if (line !== position.line) {
    return undefined;
  }

  const nextNewline = text.indexOf("\n", lineStart);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  const offset = lineStart + position.character;
  return offset <= lineEnd ? offset : undefined;
}

function compareDescending(left: ResolvedChange, right: ResolvedChange): number {
  if (left.startOffset !== right.startOffset) {
    return right.startOffset - left.startOffset;
  }

  return right.endOffset - left.endOffset;
}

/**
 * Applies changes specified against one original string. The function works in
 * descending order so positions never need to be adjusted after a replacement.
 */
export function applyWireChanges(
  source: string,
  changes: readonly WireChange[],
): WireChangeApplicationResult {
  const resolved: ResolvedChange[] = [];

  for (const change of changes) {
    const startOffset = offsetForPosition(source, change.range.start);
    const endOffset = offsetForPosition(source, change.range.end);
    if (startOffset === undefined || endOffset === undefined) {
      return {
        ok: false,
        code: "invalid-position",
        note: "A change position does not exist in the authoritative text.",
      };
    }
    if (startOffset > endOffset) {
      return {
        ok: false,
        code: "invalid-position",
        note: "A change range starts after it ends.",
      };
    }
    if (source.slice(startOffset, endOffset) !== change.expectedText) {
      return {
        ok: false,
        code: "expected-text-mismatch",
        note: "A change did not match the authoritative text it claimed to replace.",
      };
    }
    resolved.push({ change, startOffset, endOffset });
  }

  resolved.sort(compareDescending);
  for (let index = 1; index < resolved.length; index += 1) {
    const previous = resolved[index - 1];
    const current = resolved[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const duplicateInsertion =
      previous.startOffset === previous.endOffset &&
      previous.startOffset === current.startOffset &&
      current.startOffset === current.endOffset;
    if (current.endOffset > previous.startOffset || duplicateInsertion) {
      return {
        ok: false,
        code: "overlapping-range",
        note: "Changes overlap or insert at the same position ambiguously.",
      };
    }
  }

  let output = source;
  for (const resolvedChange of resolved) {
    output =
      output.slice(0, resolvedChange.startOffset) +
      resolvedChange.change.text +
      output.slice(resolvedChange.endOffset);
  }

  return { ok: true, text: output };
}
