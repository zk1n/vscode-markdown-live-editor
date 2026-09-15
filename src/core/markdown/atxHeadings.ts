export interface AtxHeadingRange {
  readonly level: number;
  readonly from: number;
  readonly to: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly markerFrom: number;
  readonly markerTo: number;
  readonly closingFrom?: number;
}

/**
 * Recognizes the deliberately conservative v0.1 ATX heading boundary shared
 * by Live Preview and the native Outline. Fence handling remains a caller
 * responsibility because presentation parses other syntax in the same pass.
 */
export function parseAtxHeadingLine(line: string, offset: number): AtxHeadingRange | undefined {
  const match = /^( {0,3})(#{1,6})(?:[ \t]+|$)/.exec(line.replace(/\r$/u, ""));
  if (match === null) {
    return undefined;
  }
  const indentation = match[1];
  const marker = match[2];
  if (indentation === undefined || marker === undefined) {
    return undefined;
  }

  const markerFrom = offset + indentation.length;
  const markerTo = offset + match[0].length;
  const end = line.endsWith("\r") ? line.length - 1 : line.length;
  const closing = /(?:^|[ \t]+)#+[ \t]*$/u.exec(line.slice(match[0].length, end));
  const closingFrom = closing === null ? undefined : markerTo + closing.index;
  return {
    level: marker.length,
    from: offset,
    to: offset + line.length,
    contentFrom: markerTo,
    contentTo: closingFrom ?? offset + end,
    markerFrom,
    markerTo,
    ...(closingFrom === undefined ? {} : { closingFrom }),
  };
}

/** Extracts only ATX H1-H6 headings outside fenced code blocks. */
export function findAtxHeadings(text: string): readonly AtxHeadingRange[] {
  const headings: AtxHeadingRange[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let fencedCode = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fencedCode = !fencedCode;
    } else if (!fencedCode) {
      const heading = parseAtxHeadingLine(line, offset);
      if (heading !== undefined) {
        headings.push(heading);
      }
    }
    offset += line.length + 1;
  }

  return headings;
}
