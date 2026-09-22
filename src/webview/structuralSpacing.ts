import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Text,
  type Transaction,
} from "@codemirror/state";
import { sourceNodes } from "../core/markdown/markdownSource.js";

export interface ManagedSeparator {
  readonly heading: number;
  readonly blank: number;
}
const rememberSeparators = StateEffect.define<readonly ManagedSeparator[]>();
/** An authority update may restore provenance only for a known history snapshot. */
export const restoreStructuralHistory = StateEffect.define<boolean>();
export const settleStructuralComposition = StateEffect.define<{
  readonly from: number;
  readonly to: number;
}>();
export const addManagedSeparator = StateEffect.define<ManagedSeparator>();
interface Record {
  readonly doc: Text;
  readonly owned: readonly ManagedSeparator[];
}
interface Provenance extends Record {
  readonly records: readonly Record[];
}

export function topLevelHeadings(doc: Text): readonly { from: number; to: number }[] {
  return sourceNodes(doc.toString(), [
    "ATXHeading1",
    "ATXHeading2",
    "ATXHeading3",
    "ATXHeading4",
    "ATXHeading5",
    "ATXHeading6",
  ]).filter((node) => node.parent === "Document");
}

export const structuralProvenance = StateField.define<Provenance>({
  create: (state) => ({ doc: state.doc, owned: [], records: [] }),
  update(value, tr) {
    if (!tr.docChanged && tr.effects.length === 0) return value;
    let owned = mapOwned(value.owned, tr);
    const restore = tr.effects.find((effect) => effect.is(restoreStructuralHistory));
    if (restore !== undefined) {
      owned = restore.value
        ? ([...value.records].reverse().find((record) => record.doc.eq(tr.newDoc))?.owned ?? [])
        : [];
    }
    for (const effect of tr.effects) {
      if (effect.is(rememberSeparators)) owned = effect.value;
      if (effect.is(addManagedSeparator)) owned = [...owned, effect.value];
    }
    return {
      doc: tr.newDoc,
      owned,
      // This journal contains provenance only; it never supplies text or owns Undo.
      // Unknown/evicted snapshots are conservatively treated as user-owned blanks.
      records: tr.docChanged
        ? [...value.records, { doc: value.doc, owned: value.owned }].slice(-40)
        : value.records,
    };
  },
});

function changesTouchSeparator(changes: Transaction["changes"], blank: number): boolean {
  let touched = false;
  changes.iterChangedRanges((from, to) => {
    // Inserting immediately after a generated blank creates a user-owned
    // empty paragraph while the generated separator remains identifiable;
    // editing at the separator itself transfers ownership to the user.
    if (from === to && from === blank + 1) return;
    if ((from === to && from === blank) || (from <= blank && to >= blank + 1)) touched = true;
  });
  return touched;
}

function mapOwned(
  owned: readonly ManagedSeparator[],
  tr: Transaction,
): readonly ManagedSeparator[] {
  return owned
    .filter((item) => !changesTouchSeparator(tr.changes, item.blank))
    .map((item) => ({
      heading: tr.changes.mapPos(item.heading, -1),
      blank: tr.changes.mapPos(item.blank, 1),
    }))
    .filter((item) => item.blank < tr.newDoc.length && tr.newDoc.lineAt(item.blank).text === "");
}

/** Input assistance is part of the originating transaction, never a save formatter. */
export function structuralInputAssistance(isComposing: () => boolean = () => false): Extension {
  return [
    structuralProvenance,
    EditorState.transactionFilter.of((tr) => {
      const settlement = tr.effects.find((effect) => effect.is(settleStructuralComposition));
      const settled = settlement !== undefined;
      if (
        (!tr.docChanged && !settled) ||
        tr.startState.readOnly ||
        tr.effects.some((effect) => effect.is(restoreStructuralHistory)) ||
        (!settled && !tr.isUserEvent("input") && !tr.isUserEvent("delete")) ||
        (!settled && (isComposing() || tr.isUserEvent("input.type.compose")))
      )
        return tr;
      const headings = topLevelHeadings(tr.newDoc);
      const owned = mapOwned(tr.startState.field(structuralProvenance).owned, tr);
      const changes: { from: number; to?: number; insert: string }[] = [];
      const retained: ManagedSeparator[] = [];
      for (const item of owned) {
        if (headings.some((heading) => heading.from === item.heading)) retained.push(item);
        else if (canRemoveSeparator(tr.newDoc, item))
          changes.push({ from: item.blank, to: item.blank + 1, insert: "" });
      }
      const added: ManagedSeparator[] = [];
      for (const heading of headings) {
        let touched =
          settlement?.is(settleStructuralComposition) === true &&
          settlement.value.from <= heading.to &&
          settlement.value.to >= heading.from;
        tr.changes.iterChangedRanges((_a, _b, from, to) => {
          if (from <= heading.to && to >= heading.from) touched = true;
        });
        if (!touched) continue;
        const line = tr.newDoc.lineAt(heading.from);
        if (line.number === tr.newDoc.lines) continue;
        const next = tr.newDoc.line(line.number + 1);
        if (next.text.trim() === "") continue;
        changes.push({ from: next.from, insert: "\n" });
        added.push({ heading: heading.from, blank: next.from });
      }
      if (changes.length === 0)
        return retained.length === owned.length
          ? tr
          : [tr, { effects: rememberSeparators.of(retained), sequential: true }];
      const adjustment = EditorState.create({ doc: tr.newDoc }).changes(changes);
      const finalOwned = [
        ...retained.map((item) => ({
          heading: adjustment.mapPos(item.heading, -1),
          blank: adjustment.mapPos(item.blank, 1),
        })),
        ...added.map((item) => ({
          heading: adjustment.mapPos(item.heading, -1),
          blank: adjustment.mapPos(item.blank, -1),
        })),
      ];
      return [
        tr,
        {
          changes: adjustment,
          selection: tr.newSelection.map(adjustment),
          effects: rememberSeparators.of(finalOwned),
          sequential: true,
        },
      ];
    }),
  ];
}

function canRemoveSeparator(doc: Text, item: ManagedSeparator): boolean {
  const line = doc.lineAt(item.heading);
  if (line.text.trim() === "") return true;
  const source = doc.toString();
  const candidate = source.slice(0, item.blank) + source.slice(item.blank + 1);
  // A demotion to ordinary prose may remove its own separator. Do not turn a
  // new quote/list into a continuation or reinterpret prose as a Setext heading.
  const isParagraph = (text: string): boolean =>
    sourceNodes(text, ["Paragraph"]).some(
      (node) => node.parent === "Document" && node.from <= item.heading && node.to >= line.to,
    );
  return isParagraph(source) && isParagraph(candidate);
}

/** Existing blanks can be displayed as structure, but are never claimed as owned. */
export function structuralBlanks(state: EditorState): readonly { from: number; to: number }[] {
  const result: { from: number; to: number }[] = [];
  const owned = state.field(structuralProvenance, false)?.owned ?? [];
  for (const heading of topLevelHeadings(state.doc)) {
    const line = state.doc.lineAt(heading.from);
    if (line.number + 1 >= state.doc.lines) continue;
    const blank = state.doc.line(line.number + 1);
    const body = state.doc.line(line.number + 2);
    if (blank.text !== "") continue;
    // Keep intentional multiple blanks, except a known generated separator before
    // the real, empty input line. The input line itself is always retained.
    if (body.text.trim() === "" && !owned.some((item) => item.blank === blank.from)) continue;
    result.push({ from: heading.to, to: body.from });
  }
  return result;
}
