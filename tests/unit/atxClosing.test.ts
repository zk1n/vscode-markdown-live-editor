import { expect, it } from "vitest";
import { sourceNodes } from "../../src/core/markdown/markdownSource.js";
import { findPresentationSyntax } from "../../src/webview/livePreview/markdownPresentation.js";
it.each([
  ["# #", 1, ""],
  ["# # text", 1, "# text"],
  ["## text", 2, "text"],
  ["# \\#", 1, "\\#"],
  ["# title ###", 1, "title"],
  ["###### six", 6, "six"],
])(
  "agrees with the Markdown parser and hides only ATX delimiters: %s",
  (source, level, content) => {
    expect(sourceNodes(source, [`ATXHeading${String(level)}`])).toHaveLength(1);
    const heading = findPresentationSyntax(source).find((range) => range.kind === "heading");
    expect(heading?.headingLevel).toBe(level);
    expect(source.slice(heading?.contentFrom, heading?.contentTo)).toBe(content);
  },
);
it.each(["\\# text", "####### text", "normal # text", "```\n# h\n```"])(
  "leaves non headings alone: %s",
  (source) => {
    expect(findPresentationSyntax(source).filter((range) => range.kind === "heading")).toEqual([]);
  },
);
