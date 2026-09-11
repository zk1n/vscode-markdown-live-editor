import { StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { frontmatterEnd, sourceNodes } from "../../core/markdown/markdownSource.js";

/** Presentation only: retain a measurable, selectable part of every source line. */
const compactLines = StateField.define<DecorationSet>({
  create: build,
  update(value, transaction) {
    if (transaction.isUserEvent("input.type.compose")) return value.map(transaction.changes);
    if (!transaction.docChanged && transaction.selection === undefined) return value;
    return build(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function build(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const excluded = sourceNodes(text, ["FencedCode", "CodeBlock", "HTMLBlock"]);
  const yamlEnd = frontmatterEnd(text);
  const ranges = [];
  for (let number = 2; number < state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    if (line.text !== "" || line.from < yamlEnd) continue;
    // Multiple intentional blanks and whitespace-only lines remain full height.
    if (
      state.doc.line(number - 1).text.trim() === "" ||
      state.doc.line(number + 1).text.trim() === ""
    )
      continue;
    if (excluded.some((node) => node.from <= line.from && node.to >= line.to)) continue;
    if (state.selection.ranges.some((range) => range.from <= line.to && range.to >= line.from))
      continue;
    ranges.push(Decoration.line({ class: "cm-live-preview-compact-blank" }).range(line.from));
  }
  return Decoration.set(ranges);
}

export const compactSpacing: Extension = [
  compactLines,
  EditorView.baseTheme({
    ".cm-line.cm-live-preview-compact-blank": {
      // A positive line box preserves CodeMirror hit testing, including zoom.
      lineHeight: "0.45em",
      minHeight: "0.45em",
    },
  }),
];
