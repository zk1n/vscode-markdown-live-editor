import { StateEffect, StateField } from "@codemirror/state";
import { editorPreferences } from "../editorPreferences.js";
import { findTables } from "../../core/markdown/tableSource.js";
export const setTableWidths = StateEffect.define<ReadonlyMap<number, number>>();
export const tableWidths = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(value, tr) {
    if (tr.startState.facet(editorPreferences) !== tr.state.facet(editorPreferences))
      return new Map();
    if (!tr.docChanged && !tr.effects.some((effect) => effect.is(setTableWidths))) return value;
    const currentCells = new Set(
      findTables(tr.newDoc.toString()).flatMap((table) =>
        table.rows.flatMap((row) => row.cells.map((cell) => cell.contentFrom)),
      ),
    );
    let next = tr.docChanged
      ? new Map(
          [...value]
            .filter(([from]) => !tr.changes.touchesRange(from, from + 1))
            .map(([from, width]) => [tr.changes.mapPos(from), width] as const)
            .filter(([from]) => currentCells.has(from)),
        )
      : value;
    for (const effect of tr.effects) if (effect.is(setTableWidths)) next = effect.value;
    return next;
  },
});
