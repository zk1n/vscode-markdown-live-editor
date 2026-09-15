import { describe, expect, it } from "vitest";
import {
  defaultEditorPreferences,
  normalizeEditorPreferences,
} from "../../src/protocol/editorPreferences.js";

describe("editor presentation preferences", () => {
  it("uses safe defaults and clamps every numeric presentation setting", () => {
    expect(normalizeEditorPreferences(undefined)).toEqual(defaultEditorPreferences);
    expect(
      normalizeEditorPreferences({
        tableMinWidth: -1,
        tableMaxWidth: 500,
        tableBandSize: 1,
        structuralGap: 100,
        linkHoverDelay: 0,
      }),
    ).toMatchObject({
      tableMinWidth: 3,
      tableMaxWidth: 100,
      tableBandSize: 10,
      structuralGap: 32,
      linkHoverDelay: 100,
    });
  });
});
