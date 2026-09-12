import { Prec, type Extension } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { sourceNodes } from "../core/markdown/markdownSource.js";
import { addManagedSeparator } from "./structuralSpacing.js";

/** An explicit Enter command. No open/save/formatter/update observer edits text. */
export function insertHeadingParagraph(view: EditorView): boolean {
  if (view.composing || view.compositionStarted || view.state.readOnly) return false;
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const caret = selection.main.head;
  const line = view.state.doc.lineAt(caret);
  if (caret !== line.to) return false;
  const heading = sourceNodes(view.state.doc.toString(), [
    "ATXHeading1",
    "ATXHeading2",
    "ATXHeading3",
    "ATXHeading4",
    "ATXHeading5",
    "ATXHeading6",
  ]).find(
    (node) =>
      view.state.doc.lineAt(node.from).number === line.number &&
      node.to === line.to &&
      node.parent === "Document",
  );
  if (heading === undefined) return false;
  const next =
    line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1) : undefined;
  if (next?.text === "") {
    const after =
      next.number < view.state.doc.lines ? view.state.doc.line(next.number + 1) : undefined;
    if (after?.text === "") {
      view.dispatch({ selection: { anchor: after.from }, scrollIntoView: true });
    } else {
      view.dispatch({
        changes: { from: next.to, insert: "\n" },
        selection: { anchor: next.to + 1 },
        effects: addManagedSeparator.of({ heading: heading.from, blank: next.to }),
        userEvent: "input.type",
        scrollIntoView: true,
      });
    }
  } else {
    view.dispatch({
      changes: { from: caret, insert: "\n\n" },
      selection: { anchor: caret + 2 },
      effects: addManagedSeparator.of({ heading: heading.from, blank: caret + 1 }),
      userEvent: "input.type",
      scrollIntoView: true,
    });
  }
  return true;
}

export function headingInputAssistance(isEditable: () => boolean): Extension {
  return Prec.high(
    keymap.of([
      {
        key: "Enter",
        run: (view) => isEditable() && insertHeadingParagraph(view),
      },
    ]),
  );
}
