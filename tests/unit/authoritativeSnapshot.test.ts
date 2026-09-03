import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { minimalTextReplacement } from "../../src/core/sync/textReplacement.js";

describe("authoritative snapshot selection mapping", () => {
  it("maps an Undo deletion to the deletion boundary and keeps Redo text symmetric", () => {
    const beforeDocument = "あいうかきく";
    const undoResult = "あいう";
    const beforeSelection = beforeDocument.length;
    const afterUndo = applyAuthoritativeSnapshot(beforeDocument, beforeSelection, undoResult);

    expect(afterUndo.document).toBe(undoResult);
    expect(afterUndo.selection).toBe(undoResult.length);

    const afterRedo = applyAuthoritativeSnapshot(
      afterUndo.document,
      afterUndo.selection,
      beforeDocument,
    );
    expect(afterRedo.document).toBe(beforeDocument);
    expect(afterRedo.selection).toBe(undoResult.length);
  });

  it.each([
    ["# headingかきく", "# heading", "heading"],
    ["**strongかきく**", "**strong**", "strong"],
    ["*emphasisかきく*", "*emphasis*", "emphasis"],
  ])("maps an Undo snapshot beside %s markers", (beforeDocument, undoResult) => {
    const afterUndo = applyAuthoritativeSnapshot(beforeDocument, beforeDocument.length, undoResult);

    expect(afterUndo.document).toBe(undoResult);
    expect(afterUndo.selection).toBe(undoResult.length);
  });
});

function applyAuthoritativeSnapshot(
  beforeDocument: string,
  beforeSelection: number,
  authoritativeResult: string,
): { readonly document: string; readonly selection: number } {
  const replacement = minimalTextReplacement(beforeDocument, authoritativeResult);
  if (replacement === undefined) {
    return { document: beforeDocument, selection: beforeSelection };
  }
  const state = EditorState.create({
    doc: beforeDocument,
    selection: { anchor: beforeSelection },
  });
  const transaction = state.update({ changes: replacement });
  return {
    document: transaction.state.doc.toString(),
    selection: transaction.state.selection.main.head,
  };
}
