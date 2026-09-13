import { describe, expect, it } from "vitest";
import {
  planSearch,
  isSearchResult,
  type SearchOptions,
} from "../../src/webview/search/searchPlan.js";
const defaults: SearchOptions = {
  search: "needle",
  replace: "new",
  regexp: false,
  caseSensitive: false,
  wholeWord: false,
};
describe("CodeMirror source search plan", () => {
  it("uses full source with word/case semantics and scope containment", () => {
    const text = "needle NEEDLE needles [link](needle.md)";
    expect(planSearch({ text, options: defaults }).matches).toHaveLength(4);
    expect(
      planSearch({ text, options: { ...defaults, wholeWord: true, caseSensitive: true } }).matches,
    ).toHaveLength(2);
    expect(planSearch({ text, options: defaults, scope: { from: 0, to: 5 } }).matches).toHaveLength(
      0,
    );
  });
  it("handles invalid regex, capture references, unmatched groups and zero-length iteration", () => {
    expect(
      planSearch({ text: "a", options: { ...defaults, regexp: true, search: "[" } }).error,
    ).toBe("invalid");
    expect(
      planSearch({
        text: "ab a",
        options: { ...defaults, regexp: true, search: "(a)(b)?", replace: "$2-$1-$$-$&" },
      }).matches.map((match) => match.insert),
    ).toEqual(["b-a-$-ab", "-a-$-a"]);
    const zero = planSearch({
      text: "ab\ncd",
      options: { ...defaults, regexp: true, search: "$", replace: "!" },
    });
    expect(zero.matches.map((match) => match.from)).toEqual([2, 5]);
  });
  it("bounds size and validates results before applying source edits", () => {
    expect(
      planSearch({ text: "x".repeat(10001), options: { ...defaults, search: "x" } }).error,
    ).toBe("limit");
    expect(isSearchResult({ matches: [{ from: 2, to: 5, insert: "" }] }, 4)).toBe(false);
    expect(
      isSearchResult(
        {
          matches: [
            { from: 2, to: 3, insert: "" },
            { from: 0, to: 1, insert: "" },
          ],
        },
        4,
      ),
    ).toBe(false);
  });
});
