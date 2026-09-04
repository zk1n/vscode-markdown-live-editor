import { describe, expect, it } from "vitest";

import { buildOutlineTree, extractOutlineHeadings } from "../../src/core/outline/outlineModel.js";

describe("outline model", () => {
  it("extracts ATX H1-H6 and ignores setext and fenced non-headings", () => {
    const lines = [
      "# Heading 1",
      "## Heading 2",
      "### Heading 3",
      "#### Heading 4",
      "##### Heading 5",
      "###### Heading 6",
      "Underline",
      "---------",
      "```",
      "# In fence",
      "```",
    ];
    const text = lines.join("\n");
    const headings = extractOutlineHeadings(text);
    const ranges = lineRanges(lines);

    expect(headings).toHaveLength(6);
    const line0 = expectDefined(ranges[0], "ranges[0]");
    const line1 = expectDefined(ranges[1], "ranges[1]");
    const line2 = expectDefined(ranges[2], "ranges[2]");
    const line3 = expectDefined(ranges[3], "ranges[3]");
    const line4 = expectDefined(ranges[4], "ranges[4]");
    const line5 = expectDefined(ranges[5], "ranges[5]");
    const lineText0 = expectDefined(lines[0], "lines[0]");
    const lineText1 = expectDefined(lines[1], "lines[1]");
    const lineText2 = expectDefined(lines[2], "lines[2]");
    const lineText3 = expectDefined(lines[3], "lines[3]");
    const lineText4 = expectDefined(lines[4], "lines[4]");
    const lineText5 = expectDefined(lines[5], "lines[5]");
    const marker0 = atxMarkerTo(lineText0);
    const marker1 = atxMarkerTo(lineText1);
    const marker2 = atxMarkerTo(lineText2);
    const marker3 = atxMarkerTo(lineText3);
    const marker4 = atxMarkerTo(lineText4);
    const marker5 = atxMarkerTo(lineText5);
    expect(headings).toMatchObject([
      {
        level: 1,
        from: line0.from,
        to: line0.to,
        contentFrom: line0.from + marker0,
        contentTo: line0.to,
      },
      {
        level: 2,
        from: line1.from,
        to: line1.to,
        contentFrom: line1.from + marker1,
        contentTo: line1.to,
      },
      {
        level: 3,
        from: line2.from,
        to: line2.to,
        contentFrom: line2.from + marker2,
        contentTo: line2.to,
      },
      {
        level: 4,
        from: line3.from,
        to: line3.to,
        contentFrom: line3.from + marker3,
        contentTo: line3.to,
      },
      {
        level: 5,
        from: line4.from,
        to: line4.to,
        contentFrom: line4.from + marker4,
        contentTo: line4.to,
      },
      {
        level: 6,
        from: line5.from,
        to: line5.to,
        contentFrom: line5.from + marker5,
        contentTo: line5.to,
      },
    ]);
  });

  it("supports skipped levels by attaching to the nearest lower-level parent", () => {
    const source = ["# Root", "### Deep", "## Mid", "##### Very deep"].join("\n");
    const nodes = buildOutlineTree(extractOutlineHeadings(source));

    const root = expectDefined(nodes[0], "nodes[0]");
    expect(nodes).toHaveLength(1);
    expect(root).toMatchObject({
      level: 1,
      label: "Root",
      identity: "root/1:Root#1",
    });
    expect(root.children).toHaveLength(2);
    const deepNode = expectDefined(root.children[0], "root.children[0]");
    const midNode = expectDefined(root.children[1], "root.children[1]");
    expect(deepNode).toMatchObject({
      level: 3,
      label: "Deep",
      identity: "root/1:Root#1/3:Deep#1",
    });
    expect(midNode).toMatchObject({
      level: 2,
      label: "Mid",
      identity: "root/1:Root#1/2:Mid#1",
    });
    const veryDeepNode = expectDefined(midNode.children[0], "midNode.children[0]");
    expect(veryDeepNode).toMatchObject({
      level: 5,
      label: "Very deep",
      identity: "root/1:Root#1/2:Mid#1/5:Very%20deep#1",
    });
  });

  it("keeps duplicate labels and Japanese labels as stable unique IDs", () => {
    const nodes = buildOutlineTree(
      extractOutlineHeadings(["# 見出し", "# 見出し", "### 見出し", "### 見出し"].join("\n")),
    );
    const identitySet = new Set(
      nodes.flatMap((node) => [node.identity, ...node.children.map((child) => child.identity)]),
    );

    expect(nodes).toHaveLength(2);
    const first = expectDefined(nodes[0], "nodes[0]");
    const second = expectDefined(nodes[1], "nodes[1]");
    expect(first.identity).toBe("root/1:%E8%A6%8B%E5%87%BA%E3%81%97#1");
    expect(second.identity).toBe("root/1:%E8%A6%8B%E5%87%BA%E3%81%97#2");
    expect(second.children).toHaveLength(2);
    const secondFirst = expectDefined(second.children[0], "second.children[0]");
    const secondSecond = expectDefined(second.children[1], "second.children[1]");
    expect(secondFirst.identity).toBe(
      "root/1:%E8%A6%8B%E5%87%BA%E3%81%97#2/3:%E8%A6%8B%E5%87%BA%E3%81%97#1",
    );
    expect(secondSecond.identity).toBe(
      "root/1:%E8%A6%8B%E5%87%BA%E3%81%97#2/3:%E8%A6%8B%E5%87%BA%E3%81%97#2",
    );
    expect(identitySet).toContain(first.identity);
    expect(identitySet).toContain(second.identity);
    expect(identitySet.size).toBe(4);
  });

  it("extracts labels with trailing ATX-marker trimming and stores source offsets", () => {
    const lines = ["#  Heading  ###", "### 日本語タイトル", "  ### 末尾 #trim ###"];
    const text = lines.join("\n");
    const headings = extractOutlineHeadings(text);
    const ranges = lineRanges(lines);
    const nodes = buildOutlineTree(headings);
    const root = expectDefined(nodes[0], "nodes[0]");
    const child0 = expectDefined(root.children[0], "nodes[0].children[0]");
    const child1 = expectDefined(root.children[1], "nodes[0].children[1]");
    const line0 = expectDefined(ranges[0], "lineRanges[0]");
    const line1 = expectDefined(ranges[1], "lineRanges[1]");
    const line2 = expectDefined(ranges[2], "lineRanges[2]");
    const lineText0 = expectDefined(lines[0], "lines[0]");
    const lineText1 = expectDefined(lines[1], "lines[1]");
    const lineText2 = expectDefined(lines[2], "lines[2]");
    const marker0 = atxMarkerTo(lineText0);
    const marker1 = atxMarkerTo(lineText1);
    const marker2 = atxMarkerTo(lineText2);

    expect(headings).toHaveLength(3);
    expect(nodes).toHaveLength(1);
    expect(root.children).toHaveLength(2);
    expect(root).toMatchObject({
      level: 1,
      label: "Heading",
      from: line0.from,
      to: line0.to,
      contentFrom: line0.from + marker0,
      contentTo: line0.to,
      navigationOffset: line0.from + marker0,
    });
    expect(child0).toMatchObject({
      level: 3,
      label: "日本語タイトル",
      from: line1.from,
      contentFrom: line1.from + marker1,
      navigationOffset: line1.from + marker1,
    });
    expect(child1).toMatchObject({
      level: 3,
      label: "末尾 #trim",
      from: line2.from,
      to: line2.to,
      contentFrom: line2.from + marker2,
      contentTo: line2.to,
      navigationOffset: line2.from + marker2,
    });
  });

  it("supports add/rename/delete/level reparse while preserving stable IDs when offsets shift", () => {
    const baseNodes = buildOutlineTree(extractOutlineHeadings(["# Intro", "### Task"].join("\n")));
    const addedNodes = buildOutlineTree(
      extractOutlineHeadings(["# Intro", "### Task", "# Added"].join("\n")),
    );
    const shiftedNodes = buildOutlineTree(
      extractOutlineHeadings(["Preface", "", "# Intro", "### Task"].join("\n")),
    );
    const renamedNodes = buildOutlineTree(
      extractOutlineHeadings(["# Intro heading", "### Task"].join("\n")),
    );
    const deleteNodes = buildOutlineTree(extractOutlineHeadings(["# Intro"].join("\n")));
    const relevelNodes = buildOutlineTree(
      extractOutlineHeadings(["# Intro", "## Task"].join("\n")),
    );

    expect(baseNodes).toHaveLength(1);
    expect(addedNodes).toHaveLength(2);
    const baseRoot = expectDefined(baseNodes[0], "baseNodes[0]");
    const baseRootChild = expectDefined(baseRoot.children[0], "baseRoot.children[0]");
    const addedRoot = expectDefined(addedNodes[0], "addedNodes[0]");
    const addedChild = expectDefined(addedRoot.children[0], "addedRoot.children[0]");
    const shiftedRoot = expectDefined(shiftedNodes[0], "shiftedNodes[0]");
    const shiftedChild = expectDefined(shiftedRoot.children[0], "shiftedRoot.children[0]");
    const renamedRoot = expectDefined(renamedNodes[0], "renamedNodes[0]");
    const deleteRoot = expectDefined(deleteNodes[0], "deleteNodes[0]");
    const relevelRoot = expectDefined(relevelNodes[0], "relevelNodes[0]");
    const relevelChild = expectDefined(relevelRoot.children[0], "relevelRoot.children[0]");
    expect(addedRoot.identity).toBe(baseRoot.identity);
    expect(addedChild.identity).toBe(baseRootChild.identity);
    expect(shiftedRoot.identity).toBe(baseRoot.identity);
    expect(shiftedChild.contentFrom).toBeGreaterThan(baseRootChild.contentFrom);
    expect(renamedRoot.identity).not.toBe(baseRoot.identity);
    expect(deleteRoot.children).toHaveLength(0);
    expect(relevelChild.level).toBe(2);
    expect(relevelChild.identity).not.toBe(baseRootChild.identity);
  });
});

function expectDefined<T>(value: T | undefined, description: string): T {
  expect(value, `${description} must be defined`).toBeDefined();
  if (value === undefined) {
    throw new Error(`${description} must be defined`);
  }
  return value;
}

function lineRanges(lines: readonly string[]): readonly { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let offset = 0;
  for (const line of lines) {
    ranges.push({ from: offset, to: offset + line.length });
    offset += line.length + 1;
  }

  return ranges;
}

function atxMarkerTo(line: string): number {
  const match = /^( {0,3})(#{1,6})(?:[ \t]+)(?=\S)/.exec(line);
  if (match === null) {
    return 0;
  }
  return match[0].length;
}
