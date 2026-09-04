import { describe, expect, it } from "vitest";

import { shouldWarnForMarkdownTrailingWhitespace } from "../../src/extension/markdownTrailingWhitespace.js";

describe("shouldWarnForMarkdownTrailingWhitespace", () => {
  it("warns only when the effective Markdown setting explicitly enables trim", () => {
    expect(shouldWarnForMarkdownTrailingWhitespace(true)).toBe(true);
    expect(shouldWarnForMarkdownTrailingWhitespace(false)).toBe(false);
    expect(shouldWarnForMarkdownTrailingWhitespace(undefined)).toBe(false);
  });
});
