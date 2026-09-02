import { describe, expect, it } from "vitest";

import { applyWireChanges } from "../../src/core/sync/documentText.js";
import type { WireChange } from "../../src/protocol/messages.js";

function change(
  startCharacter: number,
  endCharacter: number,
  expectedText: string,
  text: string,
): WireChange {
  return {
    range: {
      start: { line: 0, character: startCharacter },
      end: { line: 0, character: endCharacter },
    },
    expectedText,
    text,
  };
}

describe("applyWireChanges", () => {
  it("uses UTF-16 character positions and applies non-overlapping changes against one source", () => {
    const result = applyWireChanges("A😀BC", [change(1, 3, "😀", "猫"), change(4, 5, "C", "Z")]);

    expect(result).toEqual({ ok: true, text: "A猫BZ" });
  });

  it("rejects mismatched expected text without transforming source", () => {
    const result = applyWireChanges("abc", [change(0, 1, "z", "A")]);

    expect(result).toEqual({
      ok: false,
      code: "expected-text-mismatch",
      note: "A change did not match the authoritative text it claimed to replace.",
    });
  });

  it("rejects overlapping ranges and duplicate insertion positions", () => {
    expect(
      applyWireChanges("abcd", [change(0, 2, "ab", "A"), change(1, 3, "bc", "B")]),
    ).toMatchObject({ ok: false, code: "overlapping-range" });
    expect(applyWireChanges("abcd", [change(1, 1, "", "X"), change(1, 1, "", "Y")])).toMatchObject({
      ok: false,
      code: "overlapping-range",
    });
  });
});
