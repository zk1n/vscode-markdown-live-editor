export type PresentationSyntaxKind =
  | "heading"
  | "strong"
  | "emphasis"
  | "strikethrough"
  | "inline-code"
  | "list"
  | "blockquote"
  | "link"
  | "task";

export type MarkerPresentation = "hidden" | "list" | "task-checked" | "task-unchecked";

export interface MarkerRange {
  readonly from: number;
  readonly to: number;
  readonly presentation?: MarkerPresentation;
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
 * fenced code blocks, keeps complex/nested inline forms as source, and does
 * not attempt to normalize or rewrite Markdown.
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
      const inlineCode = findInlineCodeRanges(line, offset);
      const heading = findHeading(line, offset);
      if (heading !== undefined) {
        ranges.push(heading);
      }
      ranges.push(...findBlockPrefixRanges(line, offset));
      ranges.push(...inlineCode);

      const protectedRanges = inlineCode.map(({ from, to }) => ({
        from: from - offset,
        to: to - offset,
      }));
      const links = findLinkRanges(line, offset, protectedRanges);
      ranges.push(...links);
      protectedRanges.push(
        ...links.map(({ from, to }) => ({ from: from - offset, to: to - offset })),
      );

      ranges.push(...findDelimitedRanges(line, offset, "**", "strong", protectedRanges));
      ranges.push(...findDelimitedRanges(line, offset, "__", "strong", protectedRanges));
      ranges.push(...findDelimitedRanges(line, offset, "~~", "strikethrough", protectedRanges));
      ranges.push(...findDelimitedRanges(line, offset, "*", "emphasis", protectedRanges));
      ranges.push(...findDelimitedRanges(line, offset, "_", "emphasis", protectedRanges));
    }
    offset += line.length + 1;
  }

  return ranges;
}

export function isSyntaxActive(
  syntax: PresentationSyntaxRange,
  selections: readonly SelectionRange[],
  documentText = "",
): boolean {
  return selections.some(({ from, to }): boolean => {
    if (from === to) {
      return (
        (from >= syntax.from && from <= syntax.to) ||
        isCaretAdjacentToHiddenMarkerAcrossLineBreak(syntax, from, documentText)
      );
    }
    return from <= syntax.to && to >= syntax.from;
  });
}

/**
 * Reveal a hidden marker when a caret is separated from it only by a newline.
 * This covers a Backspace at the next-line start and a forward Delete at the
 * prior-line end. It does not change the document; it only keeps the source
 * DOM contiguous before the browser processes a native newline deletion.
 */
function isCaretAdjacentToHiddenMarkerAcrossLineBreak(
  syntax: PresentationSyntaxRange,
  caret: number,
  documentText: string,
): boolean {
  return (
    (caret === syntax.to + 1 &&
      documentText[syntax.to] === "\n" &&
      hasHiddenMarkerEndingAt(syntax, syntax.to)) ||
    (caret === syntax.from - 1 &&
      documentText[caret] === "\n" &&
      hasHiddenMarkerStartingAt(syntax, syntax.from))
  );
}

function hasHiddenMarkerEndingAt(syntax: PresentationSyntaxRange, position: number): boolean {
  return syntax.markers.some(
    (marker): boolean =>
      marker.to === position &&
      (marker.presentation === undefined || marker.presentation === "hidden"),
  );
}

function hasHiddenMarkerStartingAt(syntax: PresentationSyntaxRange, position: number): boolean {
  return syntax.markers.some(
    (marker): boolean =>
      marker.from === position &&
      (marker.presentation === undefined || marker.presentation === "hidden"),
  );
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

function findBlockPrefixRanges(line: string, offset: number): readonly PresentationSyntaxRange[] {
  const task = findTask(line, offset);
  if (task !== undefined) {
    return [task];
  }

  const list = findList(line, offset);
  if (list !== undefined) {
    return [list];
  }

  const blockquote = findBlockquote(line, offset);
  return blockquote === undefined ? [] : [blockquote];
}

function findTask(line: string, offset: number): PresentationSyntaxRange | undefined {
  const match = /^( {0,3})(?:[-+*]|\d{1,9}[.)])([ \t]+)(\[[ xX]\])([ \t]+)(?=\S)/.exec(line);
  if (match === null) {
    return undefined;
  }
  const indentation = match[1];
  const beforeCheckbox = match[2];
  const checkbox = match[3];
  const trailingSpace = match[4];
  if (
    indentation === undefined ||
    beforeCheckbox === undefined ||
    checkbox === undefined ||
    trailingSpace === undefined
  ) {
    return undefined;
  }

  const checkboxFrom = indentation.length + line.slice(indentation.length).indexOf(checkbox);
  const checkboxTo = checkboxFrom + checkbox.length;
  const contentFrom = checkboxTo + trailingSpace.length;
  return {
    kind: "task",
    from: offset,
    to: offset + line.length,
    contentFrom: offset + contentFrom,
    contentTo: offset + line.length,
    markers: [
      { from: offset + indentation.length, to: offset + checkboxFrom },
      {
        from: offset + checkboxFrom,
        to: offset + contentFrom,
        presentation: checkbox.toLowerCase() === "[x]" ? "task-checked" : "task-unchecked",
      },
    ],
  };
}

function findList(line: string, offset: number): PresentationSyntaxRange | undefined {
  const match = /^( {0,3})(?:[-+*]|\d{1,9}[.)])([ \t]+)(?=\S)/.exec(line);
  if (match === null) {
    return undefined;
  }
  const indentation = match[1];
  if (indentation === undefined) {
    return undefined;
  }
  const contentFrom = match[0].length;
  return {
    kind: "list",
    from: offset,
    to: offset + line.length,
    contentFrom: offset + contentFrom,
    contentTo: offset + line.length,
    markers: [
      {
        from: offset + indentation.length,
        to: offset + contentFrom,
        presentation: "list",
      },
    ],
  };
}

function findBlockquote(line: string, offset: number): PresentationSyntaxRange | undefined {
  const match = /^( {0,3}>[ \t]?)(?=\S)/.exec(line);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const contentFrom = match[0].length;
  return {
    kind: "blockquote",
    from: offset,
    to: offset + line.length,
    contentFrom: offset + contentFrom,
    contentTo: offset + line.length,
    markers: [{ from: offset, to: offset + contentFrom }],
  };
}

function findInlineCodeRanges(line: string, offset: number): readonly PresentationSyntaxRange[] {
  const ranges: PresentationSyntaxRange[] = [];
  let searchFrom = 0;

  while (searchFrom < line.length) {
    const opening = line.indexOf("`", searchFrom);
    if (opening === -1) {
      break;
    }
    if (isEscaped(line, opening)) {
      searchFrom = opening + 1;
      continue;
    }
    const markerLength = markerRunLength(line, opening, "`");
    const marker = "`".repeat(markerLength);
    const closing = findMatchingInlineCodeMarker(line, marker, opening + markerLength);
    if (closing === -1) {
      searchFrom = opening + markerLength;
      continue;
    }

    const contentFrom = opening + markerLength;
    if (/\S/.test(line.slice(contentFrom, closing))) {
      ranges.push({
        kind: "inline-code",
        from: offset + opening,
        to: offset + closing + markerLength,
        contentFrom: offset + contentFrom,
        contentTo: offset + closing,
        markers: [
          { from: offset + opening, to: offset + contentFrom },
          { from: offset + closing, to: offset + closing + markerLength },
        ],
      });
    }
    searchFrom = closing + markerLength;
  }

  return ranges;
}

function findMatchingInlineCodeMarker(line: string, marker: string, searchFrom: number): number {
  let index = line.indexOf(marker, searchFrom);
  while (index !== -1) {
    if (!isEscaped(line, index) && isStandaloneMarker(line, marker, index)) {
      return index;
    }
    index = line.indexOf(marker, index + marker.length);
  }
  return -1;
}

function findLinkRanges(
  line: string,
  offset: number,
  protectedRanges: readonly LocalRange[],
): readonly PresentationSyntaxRange[] {
  const ranges: PresentationSyntaxRange[] = [];
  const expression = /\[([^\]\\\n]+)\]\(([^()\s]+)\)/g;

  for (const match of line.matchAll(expression)) {
    const fullText = match[0];
    const label = match[1];
    if (label === undefined) {
      continue;
    }
    const from = match.index;
    const to = from + fullText.length;
    if (isEscaped(line, from) || overlapsProtectedRange(from, to, protectedRanges)) {
      continue;
    }

    const contentFrom = from + 1;
    const contentTo = contentFrom + label.length;
    ranges.push({
      kind: "link",
      from: offset + from,
      to: offset + to,
      contentFrom: offset + contentFrom,
      contentTo: offset + contentTo,
      markers: [
        { from: offset + from, to: offset + contentFrom },
        { from: offset + contentTo, to: offset + to },
      ],
    });
  }

  return ranges;
}

function findDelimitedRanges(
  line: string,
  offset: number,
  marker: "**" | "__" | "~~" | "*" | "_",
  kind: "strong" | "emphasis" | "strikethrough",
  protectedRanges: readonly LocalRange[],
): readonly PresentationSyntaxRange[] {
  const ranges: PresentationSyntaxRange[] = [];
  let searchFrom = 0;

  while (searchFrom < line.length) {
    const opening = findOpeningMarker(line, marker, searchFrom);
    if (opening === -1) {
      break;
    }
    if (overlapsProtectedRange(opening, opening + marker.length, protectedRanges)) {
      searchFrom = opening + marker.length;
      continue;
    }
    const closing = findClosingMarker(line, marker, opening + marker.length);
    if (closing === -1) {
      break;
    }
    if (overlapsProtectedRange(closing, closing + marker.length, protectedRanges)) {
      searchFrom = closing + marker.length;
      continue;
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
  const markerCharacter = marker[0];
  if (markerCharacter === undefined) {
    return false;
  }
  return line[index - 1] !== markerCharacter && line[index + marker.length] !== markerCharacter;
}

interface LocalRange {
  readonly from: number;
  readonly to: number;
}

function overlapsProtectedRange(
  from: number,
  to: number,
  protectedRanges: readonly LocalRange[],
): boolean {
  return protectedRanges.some((range) => from < range.to && to > range.from);
}

function markerRunLength(line: string, from: number, markerCharacter: string): number {
  let length = 0;
  while (line[from + length] === markerCharacter) {
    length += 1;
  }
  return length;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let position = index - 1; position >= 0 && text[position] === "\\"; position -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}
