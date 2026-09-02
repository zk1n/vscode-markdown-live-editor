export type PresentationSyntaxKind = "heading" | "strong" | "emphasis";

export interface MarkerRange {
  readonly from: number;
  readonly to: number;
}

export interface PresentationSyntaxRange {
  readonly kind: PresentationSyntaxKind;
  readonly from: number;
  readonly to: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly markers: readonly MarkerRange[];
  readonly headingLevel?: number;
}

export interface SelectionRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Deliberately conservative v0.1 recognition for presentation only. It skips
 * fenced code blocks and does not attempt to normalize or rewrite Markdown.
 */
export function findPresentationSyntax(text: string): readonly PresentationSyntaxRange[] {
  const ranges: PresentationSyntaxRange[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let fencedCode = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fencedCode = !fencedCode;
    } else if (!fencedCode) {
      const heading = findHeading(line, offset);
      if (heading !== undefined) {
        ranges.push(heading);
      }
      ranges.push(...findDelimitedRanges(line, offset, "**", "strong"));
      ranges.push(...findDelimitedRanges(line, offset, "__", "strong"));
      ranges.push(...findDelimitedRanges(line, offset, "*", "emphasis"));
      ranges.push(...findDelimitedRanges(line, offset, "_", "emphasis"));
    }
    offset += line.length + 1;
  }

  return ranges;
}

export function isSyntaxActive(
  syntax: PresentationSyntaxRange,
  selections: readonly SelectionRange[],
): boolean {
  return selections.some(({ from, to }): boolean => {
    if (from === to) {
      return from >= syntax.from && from <= syntax.to;
    }
    return from <= syntax.to && to >= syntax.from;
  });
}

function findHeading(line: string, offset: number): PresentationSyntaxRange | undefined {
  const match = /^( {0,3})(#{1,6})(?:[ \t]+)(?=\S)/.exec(line);
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
  return {
    kind: "heading",
    from: offset,
    to: offset + line.length,
    contentFrom: markerTo,
    contentTo: offset + line.length,
    markers: [{ from: markerFrom, to: markerTo }],
    headingLevel: marker.length,
  };
}

function findDelimitedRanges(
  line: string,
  offset: number,
  marker: "**" | "__" | "*" | "_",
  kind: "strong" | "emphasis",
): readonly PresentationSyntaxRange[] {
  const ranges: PresentationSyntaxRange[] = [];
  let searchFrom = 0;

  while (searchFrom < line.length) {
    const opening = findOpeningMarker(line, marker, searchFrom);
    if (opening === -1) {
      break;
    }
    const closing = findClosingMarker(line, marker, opening + marker.length);
    if (closing === -1) {
      break;
    }

    const contentFrom = opening + marker.length;
    if (contentFrom < closing && /\S/.test(line.slice(contentFrom, closing))) {
      ranges.push({
        kind,
        from: offset + opening,
        to: offset + closing + marker.length,
        contentFrom: offset + contentFrom,
        contentTo: offset + closing,
        markers: [
          { from: offset + opening, to: offset + contentFrom },
          { from: offset + closing, to: offset + closing + marker.length },
        ],
      });
    }
    searchFrom = closing + marker.length;
  }

  return ranges;
}

function findOpeningMarker(line: string, marker: string, searchFrom: number): number {
  let index = line.indexOf(marker, searchFrom);
  while (index !== -1) {
    const before = line[index - 1];
    const after = line[index + marker.length];
    if (
      after !== undefined &&
      !/\s/.test(after) &&
      !isEscaped(line, index) &&
      isStandaloneMarker(line, marker, index) &&
      !(marker === "_" && before !== undefined && /\w/.test(before))
    ) {
      return index;
    }
    index = line.indexOf(marker, index + marker.length);
  }
  return -1;
}

function findClosingMarker(line: string, marker: string, searchFrom: number): number {
  let index = line.indexOf(marker, searchFrom);
  while (index !== -1) {
    const before = line[index - 1];
    const after = line[index + marker.length];
    if (
      before !== undefined &&
      !/\s/.test(before) &&
      !isEscaped(line, index) &&
      isStandaloneMarker(line, marker, index) &&
      !(marker === "_" && after !== undefined && /\w/.test(after))
    ) {
      return index;
    }
    index = line.indexOf(marker, index + marker.length);
  }
  return -1;
}

function isStandaloneMarker(line: string, marker: string, index: number): boolean {
  if (marker.length !== 1) {
    return true;
  }
  return line[index - 1] !== marker && line[index + 1] !== marker;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let position = index - 1; position >= 0 && text[position] === "\\"; position -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}
