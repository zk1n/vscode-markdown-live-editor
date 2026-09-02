import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";

import { minimalTextReplacement } from "../../src/core/sync/textReplacement.js";

describe("minimalTextReplacement", () => {
  it("maps an end-of-document undo to its local changed range", () => {
    expect(minimalTextReplacement("abcX", "abc")).toEqual({ from: 3, to: 4, insert: "" });
  });

  it("preserves a terminal selection through the mapped undo change", () => {
    const before = EditorState.create({
      doc: "abcX",
      selection: EditorSelection.cursor(4),
    });
    const replacement = minimalTextReplacement(before.doc.toString(), "abc");
    if (replacement === undefined) {
      throw new Error("The test requires an authoritative text difference.");
    }

    const after = before.update({ changes: replacement }).state;
    expect(after.selection.main.head).toBe(3);
    expect(after.selection.main.head).not.toBe(0);
  });

  it("keeps equal surrounding text outside an authoritative change", () => {
    expect(minimalTextReplacement("ab日本cd", "ab語cd")).toEqual({
      from: 2,
      to: 4,
      insert: "語",
    });
  });

  it("does not dispatch when the authority already matches", () => {
    expect(minimalTextReplacement("abc", "abc")).toBeUndefined();
  });
});
