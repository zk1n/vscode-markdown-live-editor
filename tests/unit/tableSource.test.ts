import { describe, expect, it } from "vitest";

import {
  changeTableColumn,
  findTables,
  parseTableRow,
  tableCellAt,
} from "../../src/core/markdown/tableSource.js";

describe("table source parsing", () => {
  it("keeps escaped pipes inside a cell and preserves literal source when adding a column", () => {
    const source = [
      "before",
      "| **見出し** | [link](docs/a.md) |",
      "| :--- | ---: |",
      "| a\\|b | `code` |",
      "",
      "after",
    ].join("\n");
    const [table] = findTables(source);
    if (table === undefined) {
      throw new Error("Expected a parser-recognized GFM table.");
    }

    expect(table.columns).toBe(2);
    expect(table.alignments).toEqual(["left", "right"]);
    expect(source.slice(table.rows[1]?.cells[0]?.from, table.rows[1]?.cells[0]?.to)).toBe(
      " a\\|b ",
    );
    expect(tableCellAt(table, source.indexOf("a\\|b") + 2)).toMatchObject({ row: 1, column: 0 });

    const edits = changeTableColumn(source, table, 1, false);
    let rebuilt = source;
    for (const edit of [...edits].reverse()) {
      rebuilt = `${rebuilt.slice(0, edit.from)}${edit.insert}${rebuilt.slice(edit.to)}`;
    }
    expect(rebuilt).toContain("| **見出し** |  | [link](docs/a.md) |");
    expect(rebuilt).toContain("| a\\|b |  | `code` |");
    expect(rebuilt).toContain("before\n");
    expect(rebuilt).toContain("\nafter");
  });

  it("keeps malformed and ragged source outside the table editor", () => {
    expect(findTables("| heading | other |\n| --- |\n| value | other |")).toEqual([]);
    expect(findTables("heading | ordinary text\n--- | ---\nnot a table")).toEqual([]);
    expect(parseTableRow("| a\\|b | c |", 10).cells).toHaveLength(2);
  });
});
