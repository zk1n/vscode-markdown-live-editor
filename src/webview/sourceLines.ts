import {
  EditorSelection,
  RangeSet,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  gutterLineClass,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { structuralBlanks } from "./structuralSpacing.js";
import { findTables } from "../core/markdown/tableSource.js";
import { searchReveal } from "./livePreview/searchReveal.js";
import { editorPreferences } from "./editorPreferences.js";

/** Explicit physical-line selection is source editing, including hidden source rows. */
export const sourceLineSelection = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) =>
    tr.selection ? tr.isUserEvent("select.line") : tr.docChanged ? false : value,
});
class HiddenLineNumber extends GutterMarker {
  override elementClass = "cm-source-number-hidden";
}
const hiddenNumber = new HiddenLineNumber();
function hiddenLines(
  state: EditorState,
  revealed: readonly { from: number; to: number }[],
): RangeSet<GutterMarker> {
  const positions = new Set<number>();
  const match = state.field(searchReveal, false);
  if (state.facet(editorPreferences).compactSpacing)
    for (const gap of structuralBlanks(state))
      if (!match || match.to <= gap.from || match.from >= gap.to) positions.add(gap.from + 1);
  for (const table of findTables(state.doc.toString()))
    if (
      !revealed.some(
        (range) => range.from <= table.delimiter.to && range.to >= table.delimiter.from,
      )
    )
      positions.add(table.delimiter.from);
  return RangeSet.of([...positions].sort((a, b) => a - b).map((pos) => hiddenNumber.range(pos)));
}
function selectLines(view: EditorView, start: number, end: number): void {
  const first = view.state.doc.lineAt(Math.min(start, end));
  const last = view.state.doc.lineAt(Math.max(start, end));
  const to = last.number === view.state.doc.lines ? last.to : last.to + 1;
  view.dispatch({
    selection: EditorSelection.single(
      start <= end ? first.from : to,
      start <= end ? to : first.from,
    ),
    userEvent: "select.line",
  });
}
class LineDrag {
  private anchor: number | undefined;
  private pointer: number | undefined;
  constructor(private readonly view: EditorView) {}
  start(event: PointerEvent, from: number): boolean {
    if (event.button !== 0 || this.view.composing || this.view.compositionStarted) return false;
    event.preventDefault();
    this.anchor = event.shiftKey ? (this.anchor ?? this.view.state.selection.main.anchor) : from;
    this.pointer = event.pointerId;
    selectLines(this.view, this.anchor, from);
    this.view.focus();
    const doc = this.view.dom.ownerDocument;
    doc.addEventListener("pointermove", this.move);
    doc.addEventListener("pointerup", this.end);
    doc.addEventListener("pointercancel", this.end);
    doc.defaultView?.addEventListener("blur", this.stop);
    return true;
  }
  private readonly move = (event: PointerEvent): void => {
    if (this.anchor === undefined || this.pointer !== event.pointerId) return;
    const rect = this.view.scrollDOM.getBoundingClientRect();
    if (event.clientY < rect.top || event.clientY > rect.bottom)
      this.view.scrollDOM.scrollTop += event.clientY < rect.top ? -24 : 24;
    const block = this.view.lineBlockAtHeight(event.clientY - this.view.documentTop);
    selectLines(this.view, this.anchor, block.from);
  };
  private readonly end = (event: PointerEvent): void => {
    if (event.pointerId === this.pointer) this.stop();
  };
  private readonly stop = (): void => {
    this.pointer = undefined;
    const doc = this.view.dom.ownerDocument;
    doc.removeEventListener("pointermove", this.move);
    doc.removeEventListener("pointerup", this.end);
    doc.removeEventListener("pointercancel", this.end);
    doc.defaultView?.removeEventListener("blur", this.stop);
  };
  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.stop();
      this.anchor = undefined;
    }
  }
  destroy(): void {
    this.stop();
  }
}
const drag = ViewPlugin.fromClass(LineDrag);
export function sourceLineNumbers(
  revealed: (state: EditorState) => readonly { from: number; to: number }[],
): Extension {
  const markers = StateField.define<RangeSet<GutterMarker>>({
    create: (state) => hiddenLines(state, revealed(state)),
    update: (_value, tr) => hiddenLines(tr.state, revealed(tr.state)),
    provide: (field) => gutterLineClass.from(field),
  });
  return [
    drag,
    lineNumbers({
      domEventHandlers: {
        pointerdown: (view, line, event) =>
          event instanceof PointerEvent && (view.plugin(drag)?.start(event, line.from) ?? false),
        mousedown: () => true,
      },
    }),
    markers,
    EditorView.baseTheme({
      ".cm-gutters": {
        backgroundColor: "var(--vscode-editorGutter-background, var(--vscode-editor-background))",
        color: "var(--vscode-editorLineNumber-foreground, #858585)",
        borderRight: "0",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        cursor: "pointer",
        userSelect: "none",
        padding: "0 6px 0 8px",
        fontVariantNumeric: "tabular-nums",
      },
      ".cm-source-number-hidden": { color: "transparent", pointerEvents: "none" },
    }),
  ];
}
