import { markdownLanguage } from "@codemirror/lang-markdown";

import { parseAtxHeadingLine } from "../../core/markdown/atxHeadings.js";

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

export type MarkerPresentation =
  "hidden" | "list-ordered" | "list-unordered" | "task-checked" | "task-unchecked";

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
 * A single physical line belonging to a CommonMark indented code block. The
 * parser, rather than a leading-whitespace heuristic, establishes membership
 * and the content offset. That offset preserves container prefixes (such as
 * blockquotes and list continuations) without guessing at their width.
 */
export interface IndentedCodeBlockLine {
  readonly from: number;
  readonly to: number;
  readonly indentationTo: number;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}

/**
 * Parser-derived metadata for one physical line in a fenced code block. The
 * marker range begins at a parser-recognized CodeMark and extends through the
 * rest of that physical line, so an inactive preview can remove a fence and
 * its info string without guessing at CommonMark container prefixes.
 */
export interface FencedCodeBlockLine {
  readonly from: number;
  readonly to: number;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly markerFrom?: number;
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
  const blockSyntax = findListAndTaskSyntax(text);
  const codeBlocks = findCodeBlockRanges(text);

  for (const line of lines) {
    if (!isInCodeBlock(offset, codeBlocks)) {
      const inlineCode = findInlineCodeRanges(line, offset);
      const heading = findHeading(line, offset);
      if (heading !== undefined) {
        ranges.push(heading);
      }
      const blockPrefix = blockSyntax.get(offset);
      if (blockPrefix !== undefined) {
        ranges.push(blockPrefix);
      } else {
        const blockquote = findBlockquote(line, offset);
        if (blockquote !== undefined) {
          ranges.push(blockquote);
        }
      }
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
): boolean {
  return selections.some(({ from, to }): boolean => {
    if (from === to) {
      return from >= syntax.from && from <= syntax.to;
    }
    return from <= syntax.to && to >= syntax.from;
  });
}

function findHeading(line: string, offset: number): PresentationSyntaxRange | undefined {
  const heading = parseAtxHeadingLine(line, offset);
  if (heading === undefined) {
    return undefined;
  }
  return {
    kind: "heading",
    from: heading.from,
    to: heading.to,
    contentFrom: heading.contentFrom,
    contentTo: heading.contentTo,
    markers: [{ from: heading.markerFrom, to: heading.markerTo }],
    headingLevel: heading.level,
  };
}

interface SourceRange {
  readonly from: number;
  readonly to: number;
}

const presentationParser = markdownLanguage.parser;

/**
 * The Markdown parser is authoritative for list context. In particular, its
 * tree distinguishes a top-level four-space indented code block from a list
 * nested beneath a preceding list item (including tab-based indentation).
 */
function findListAndTaskSyntax(text: string): ReadonlyMap<number, PresentationSyntaxRange> {
  const listMarks: SourceRange[] = [];
  const taskMarkers: SourceRange[] = [];
  presentationParser.parse(text).iterate({
    enter: ({ name, from, to }): void => {
      if (name === "ListMark") {
        listMarks.push({ from, to });
      } else if (name === "TaskMarker") {
        taskMarkers.push({ from, to });
      }
    },
  });

  const taskByListMark = new Map<number, SourceRange>();
  for (const taskMarker of taskMarkers) {
    const listMark = findListMarkForTask(text, listMarks, taskMarker);
    if (listMark !== undefined) {
      taskByListMark.set(listMark.from, taskMarker);
    }
  }

  const ranges = new Map<number, PresentationSyntaxRange>();
  for (const listMark of listMarks) {
    const lineEnd = text.indexOf("\n", listMark.to);
    const contentTo = lineEnd === -1 ? text.length : lineEnd;
    const taskMarker = taskByListMark.get(listMark.from);
    const contentFrom = skipWhitespace(text, taskMarker?.to ?? listMark.to, contentTo);
    if (contentFrom === contentTo) {
      continue;
    }

    const marker = text.slice(listMark.from, listMark.to);
    if (taskMarker === undefined) {
      const isUnordered = /^[+*-]$/.test(marker);
      const markerFrom = isUnordered ? whitespacePrefixStart(text, listMark.from) : listMark.from;
      ranges.set(lineStart(text, listMark.from), {
        kind: "list",
        from: markerFrom,
        to: contentTo,
        contentFrom,
        contentTo,
        markers: [
          {
            // A whitespace-only prefix is structural list indentation. Keep it
            // with the inactive unordered marker so the native list widget can
            // supply the Preview's measured indentation. Container prefixes
            // such as `> ` deliberately remain source DOM.
            from: markerFrom,
            to: contentFrom,
            presentation: isUnordered ? "list-unordered" : "list-ordered",
          },
        ],
      });
      continue;
    }

    ranges.set(lineStart(text, listMark.from), {
      kind: "task",
      from: listMark.from,
      to: contentTo,
      contentFrom,
      contentTo,
      markers: [
        { from: listMark.from, to: taskMarker.from },
        {
          from: taskMarker.from,
          to: contentFrom,
          presentation:
            text.slice(taskMarker.from, taskMarker.to).toLowerCase() === "[x]"
              ? "task-checked"
              : "task-unchecked",
        },
      ],
    });
  }
  return ranges;
}

function whitespacePrefixStart(text: string, position: number): number {
  const start = lineStart(text, position);
  return /^[ \t]*$/.test(text.slice(start, position)) ? start : position;
}

function findListMarkForTask(
  text: string,
  listMarks: readonly SourceRange[],
  taskMarker: SourceRange,
): SourceRange | undefined {
  for (let index = listMarks.length - 1; index >= 0; index -= 1) {
    const listMark = listMarks[index];
    if (listMark === undefined || listMark.to > taskMarker.from) {
      continue;
    }
    const lineEnd = text.indexOf("\n", listMark.to);
    if (lineEnd === -1 || taskMarker.from < lineEnd) {
      return listMark;
    }
    return undefined;
  }
  return undefined;
}

function findCodeBlockRanges(text: string): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  presentationParser.parse(text).iterate({
    enter: ({ name, from, to }): void => {
      if (name === "CodeBlock" || name === "FencedCode") {
        const blockFrom = lineStart(text, from);
        const blockTo = lineEnd(text, to);
        ranges.push({ from: blockFrom, to: blockTo });
      }
    },
  });
  return ranges;
}

/**
 * Returns only parser-recognized indented code. Fenced code deliberately has
 * a separate presentation path, so it is not returned here.
 *
 * The parser-derived CodeText offset is presentation metadata only. It hides
 * every structural prefix on an inactive line; it never edits or normalizes
 * the CodeMirror document.
 */
export function findIndentedCodeBlockLines(text: string): readonly IndentedCodeBlockLine[] {
  const blocks: SourceRange[] = [];
  const codeTextRanges: SourceRange[] = [];
  presentationParser.parse(text).iterate({
    enter: ({ from, name, to }): void => {
      if (name === "CodeBlock") {
        blocks.push({ from: lineStart(text, from), to: lineEnd(text, to) });
      } else if (name === "CodeText") {
        codeTextRanges.push({ from, to });
      }
    },
  });

  const lines: IndentedCodeBlockLine[] = [];
  for (const block of blocks) {
    const codeTexts = codeTextRanges.filter(
      (codeText) => codeText.from >= block.from && codeText.to <= block.to,
    );
    for (const [index, codeText] of codeTexts.entries()) {
      const from = lineStart(text, codeText.from);
      const to = lineEnd(text, codeText.from);
      lines.push({
        from,
        to,
        indentationTo: codeText.from,
        isFirst: index === 0,
        isLast: index === codeTexts.length - 1,
      });
    }
  }
  return lines;
}

/**
 * Returns parser-recognized fenced-code lines and their opening/closing
 * CodeMark positions. `CodeInfo` is intentionally covered by the opening
 * marker range through the physical line end. An unclosed fence has only its
 * opening marker; its final source line still receives the block end style.
 */
export function findFencedCodeBlockLines(text: string): readonly FencedCodeBlockLine[] {
  const lines: FencedCodeBlockLine[] = [];
  const fences: {
    from: number;
    to: number;
    codeInfos: SourceRange[];
    codeMarks: SourceRange[];
  }[] = [];
  const tree = presentationParser.parse(text);
  tree.iterate({
    enter: ({ from, name, to }): void => {
      if (name === "FencedCode") {
        fences.push({ from, to, codeInfos: [], codeMarks: [] });
        return;
      }
      if (name !== "CodeMark" && name !== "CodeInfo") {
        return;
      }
      const fence = fences.find((candidate) => from >= candidate.from && to <= candidate.to);
      if (fence === undefined) {
        return;
      }
      const range = { from, to };
      if (name === "CodeMark") {
        fence.codeMarks.push(range);
      } else {
        fence.codeInfos.push(range);
      }
    },
  });

  for (const fence of fences) {
    const blockFrom = lineStart(text, fence.from);
    const blockTo = lineEnd(text, fence.to);
    const firstMark = fence.codeMarks[0];
    const lastMark =
      fence.codeMarks.length > 1 ? fence.codeMarks[fence.codeMarks.length - 1] : undefined;
    const openingInfo = fence.codeInfos[0];
    for (let lineFrom = blockFrom; lineFrom <= blockTo;) {
      const lineTo = lineEnd(text, lineFrom);
      const markerFrom =
        firstMark !== undefined &&
        firstMark.from >= lineFrom &&
        firstMark.from <= lineTo &&
        (openingInfo === undefined || openingInfo.from >= firstMark.to)
          ? firstMark.from
          : lastMark !== undefined && lastMark.from >= lineFrom && lastMark.from <= lineTo
            ? lastMark.from
            : undefined;
      const fenceLine = {
        from: lineFrom,
        to: lineTo,
        isFirst: lineFrom === blockFrom,
        isLast: lineTo === blockTo,
      };
      lines.push(markerFrom === undefined ? fenceLine : { ...fenceLine, markerFrom });
      if (lineTo >= blockTo) {
        break;
      }
      lineFrom = lineTo + 1;
    }
  }
  return lines;
}

function lineEnd(text: string, position: number): number {
  const nextNewline = text.indexOf("\n", position);
  return nextNewline === -1 ? text.length : nextNewline;
}

function isInCodeBlock(offset: number, codeBlocks: readonly SourceRange[]): boolean {
  return codeBlocks.some(({ from, to }) => offset >= from && offset <= to);
}

function skipWhitespace(text: string, from: number, to: number): number {
  let position = from;
  while (position < to && /[ \t]/.test(text[position] ?? "")) {
    position += 1;
  }
  return position;
}

function lineStart(text: string, position: number): number {
  const previousNewline = text.lastIndexOf("\n", position - 1);
  return previousNewline === -1 ? 0 : previousNewline + 1;
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
