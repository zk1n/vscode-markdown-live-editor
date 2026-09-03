export interface TextReplacement {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/**
 * The smallest single replacement from before to after. Normal authority
 * updates use it so CodeMirror maps selection through the changed range.
 */
export function minimalTextReplacement(before: string, after: string): TextReplacement | undefined {
  if (before === after) {
    return undefined;
  }

  let from = 0;
  const sharedLength = Math.min(before.length, after.length);
  while (from < sharedLength && before.charCodeAt(from) === after.charCodeAt(from)) {
    from += 1;
  }

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > from &&
    afterEnd > from &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return { from, to: beforeEnd, insert: after.slice(from, afterEnd) };
}
