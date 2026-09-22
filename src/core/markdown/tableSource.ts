import { sourceNodes } from "./markdownSource.js";

export interface TableCell {
  readonly from: number;
  readonly to: number;
  readonly contentFrom: number;
  readonly contentTo: number;
}
export interface TableRow {
  readonly from: number;
  readonly to: number;
  readonly cells: readonly TableCell[];
  readonly pipes: readonly number[];
}
export interface SourceTable {
  readonly from: number;
  readonly to: number;
  readonly rows: readonly TableRow[];
  readonly delimiter: TableRow;
  readonly columns: number;
  readonly alignments: readonly ("left" | "center" | "right")[];
}
export interface SourceEdit {
  readonly from: number;
  readonly to?: number;
  readonly insert: string;
}

export function parseTableRow(text: string, from: number): TableRow {
  const pipes: number[] = [];
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "|" && !escaped) pipes.push(i);
    escaped = char === "\\" && !escaped;
  }
  const start = pipes[0] !== undefined && text.slice(0, pipes[0]).trim() === "" ? pipes[0] + 1 : 0;
  const lastPipe = pipes.at(-1);
  const end =
    lastPipe !== undefined && text.slice(lastPipe + 1).trim() === "" ? lastPipe : text.length;
  const boundaries = [start - 1, ...pipes.filter((pipe) => pipe >= start && pipe < end), end];
  const cells: TableCell[] = [];
  for (let i = 1; i < boundaries.length; i += 1) {
    const left = boundaries[i - 1];
    const right = boundaries[i];
    if (left === undefined || right === undefined) continue;
    const value = text.slice(left + 1, right);
    // One ASCII space at either edge is Markdown table padding. Preserve any
    // additional ASCII space, as well as full-width/other whitespace, as part
    // of the logical cell value instead of trimming it away.
    const leading = value.startsWith(" ") ? 1 : 0;
    const trailing = value.length > leading && value.endsWith(" ") ? 1 : 0;
    const contentLength = Math.max(0, value.length - leading - trailing);
    // A blank cell's insertion point belongs between its padding, not at the
    // following pipe (which may be hidden in preview mode).
    cells.push({
      from: from + left + 1,
      to: from + right,
      contentFrom: from + left + 1 + leading,
      contentTo: from + left + 1 + leading + contentLength,
    });
  }
  return { from, to: from + text.length, cells, pipes: pipes.map((pipe) => pipe + from) };
}

export function findTables(text: string): readonly SourceTable[] {
  const tables: SourceTable[] = [];
  for (const node of sourceNodes(text, ["Table"])) {
    if (node.parent !== "Document") continue;
    let offset = node.from;
    const lines = text
      .slice(node.from, node.to)
      .split("\n")
      .map((line) => {
        const row = parseTableRow(line, offset);
        offset += line.length + 1;
        return row;
      });
    const header = lines[0];
    const delimiter = lines[1];
    if (header === undefined || header.cells.length !== delimiter?.cells.length) continue;
    // Ragged/unfinished tables remain ordinary Markdown source for repair.
    if (lines.some((line) => line.cells.length !== header.cells.length)) continue;
    tables.push({
      from: node.from,
      to: node.to,
      rows: [header, ...lines.slice(2)],
      delimiter,
      columns: header.cells.length,
      alignments: delimiter.cells.map((cell) => {
        const value = text.slice(cell.from, cell.to).trim();
        return value.endsWith(":") ? (value.startsWith(":") ? "center" : "right") : "left";
      }),
    });
  }
  return tables;
}

export function tableCellAt(
  table: SourceTable,
  position: number,
): { row: number; column: number; cell: TableCell } | undefined {
  for (let row = 0; row < table.rows.length; row += 1) {
    const cells = table.rows[row]?.cells ?? [];
    for (let column = 0; column < cells.length; column += 1) {
      const cell = cells[column];
      if (cell !== undefined && position >= cell.from && position <= cell.to)
        return { row, column, cell };
    }
  }
  return undefined;
}

/** Explicit column edits retain every untouched cell's literal source. */
export function changeTableColumn(
  text: string,
  table: SourceTable,
  column: number,
  remove: boolean,
): readonly SourceEdit[] {
  if (remove && table.columns <= 1) return [];
  return [...table.rows, table.delimiter]
    .map((row) => {
      const cells = row.cells.map((cell) => text.slice(cell.from, cell.to));
      if (remove) cells.splice(column, 1);
      else cells.splice(column, 0, row === table.delimiter ? " --- " : "  ");
      // Keep optional outer pipes and leading/trailing whitespace literally.
      const first = row.cells[0];
      const last = row.cells.at(-1);
      if (first === undefined || last === undefined)
        return { from: row.from, to: row.to, insert: text.slice(row.from, row.to) };
      const prefix = text.slice(row.from, first.from);
      const suffix = text.slice(last.to, row.to);
      // A one-column table still needs a pipe to remain a table rather than
      // being reinterpreted as a Setext heading. Cell literals are unchanged.
      const needsOuterPipes = cells.length === 1 && !prefix.includes("|") && !suffix.includes("|");
      return {
        from: row.from,
        to: row.to,
        insert:
          prefix +
          (needsOuterPipes ? "|" : "") +
          cells.join("|") +
          (needsOuterPipes ? "|" : "") +
          suffix,
      };
    })
    .sort((a, b) => a.from - b.from);
}
