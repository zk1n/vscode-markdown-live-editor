import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { findMarkdownLinks } from "../../core/markdown/markdownLinks.js";
import { editorPreferences } from "../editorPreferences.js";

interface Height {
  readonly from: number;
  readonly to: number;
  readonly height: number;
  readonly textHeight: number;
}
const measured = StateEffect.define<readonly Height[]>();
const textHeight = StateEffect.define<ReadonlyMap<number, number>>();
const geometry = StateField.define<readonly Height[]>({
  create: () => [],
  update(value, tr) {
    let next = value
      .filter((item) => !tr.changes.touchesRange(item.from, item.to))
      .map((item) => ({
        ...item,
        from: tr.changes.mapPos(item.from, -1),
        to: tr.changes.mapPos(item.to, 1),
      }));
    for (const effect of tr.effects) if (effect.is(measured)) next = [...effect.value];
    return next;
  },
});
const session = StateField.define<readonly Height[]>({
  create: () => [],
  update(value, tr) {
    if (!tr.state.facet(editorPreferences).imageKeepHeight) return [];
    let next = value.flatMap((current) => {
      const removed: boolean[] = [];
      tr.changes.iterChangedRanges((from, to) => {
        removed.push(from <= current.from && to >= current.to && to > from);
      });
      return removed.some(Boolean)
        ? []
        : [
            {
              ...current,
              from: tr.changes.mapPos(current.from, -1),
              to: tr.changes.mapPos(current.to, 1),
            },
          ];
    });
    if (!tr.docChanged)
      next.push(
        ...tr.startState
          .field(geometry)
          .filter((item) => !next.some((other) => other.from === item.from)),
      );
    next = next.filter((item) =>
      tr.newSelection.ranges.some((range) => range.from <= item.to && range.to >= item.from),
    );
    for (const effect of tr.effects)
      if (effect.is(textHeight))
        next = next.map((item) => ({
          ...item,
          textHeight: effect.value.get(item.from) ?? item.textHeight,
        }));
    return next;
  },
});
class SourceHeight extends WidgetType {
  constructor(private readonly height: number) {
    super();
  }
  override eq(other: SourceHeight): boolean {
    return this.height === other.height;
  }
  override get estimatedHeight(): number {
    return this.height;
  }
  override toDOM(): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-image-source-height";
    dom.style.height = `${String(this.height)}px`;
    dom.setAttribute("aria-hidden", "true");
    return dom;
  }
}
function decorations(state: EditorState): DecorationSet {
  const current = state.field(session);
  const seen = new Set<number>();
  return Decoration.set(
    current.flatMap((item) => {
      const line = state.doc.lineAt(item.from);
      if (seen.has(line.from)) return [];
      seen.add(line.from);
      return [
        Decoration.line({
          class: "cm-image-source-line",
          attributes: { "data-image-source-height": String(item.from) },
        }).range(line.from),
        Decoration.widget({
          block: true,
          side: 1,
          widget: new SourceHeight(Math.max(0, item.height - item.textHeight)),
        }).range(state.doc.lineAt(item.to).to),
      ];
    }),
    true,
  );
}
export const imageSourceHeight: Extension = [
  geometry,
  session,
  EditorView.decorations.compute([session], decorations),
  ViewPlugin.fromClass(
    class {
      private destroyed = false;
      constructor(private readonly view: EditorView) {
        this.measure();
      }
      private readonly measure = (): void => {
        if (this.destroyed) return;
        this.view.requestMeasure({
          key: this,
          read: (view) => {
            const values: Height[] = [];
            const links = findMarkdownLinks(view.state.doc.toString()).filter((link) => link.image);
            for (const element of view.contentDOM.querySelectorAll<HTMLElement>(
              ".cm-image-preview",
            )) {
              const from = Number(element.dataset["imageFrom"]);
              const link = links.find((link) => link.from === from);
              const rect = element.closest(".cm-line")?.getBoundingClientRect();
              if (link && rect && rect.height > 0)
                values.push({
                  from,
                  to: link.to,
                  height: rect.height,
                  textHeight: view.defaultLineHeight,
                });
            }
            const heights = new Map<number, number>();
            for (const item of view.state.field(session)) {
              const line = view.contentDOM.querySelector<HTMLElement>(
                `[data-image-source-height="${String(item.from)}"]`,
              );
              const rect = line?.getBoundingClientRect();
              const end = view.coordsAtPos(item.to, -1);
              if (rect)
                heights.set(
                  item.from,
                  Math.max(rect.height, (end?.bottom ?? rect.bottom) - rect.top),
                );
            }
            return { doc: view.state.doc, values, heights };
          },
          write: ({ doc, values, heights }) => {
            const effects: StateEffect<unknown>[] = [];
            const current = this.view.state.field(session);
            if (
              values.length &&
              JSON.stringify(values) !== JSON.stringify(this.view.state.field(geometry))
            )
              effects.push(measured.of(values));
            if (
              current.some(
                (item) =>
                  heights.has(item.from) &&
                  Math.abs(item.textHeight - (heights.get(item.from) ?? 0)) > 0.5,
              )
            )
              effects.push(textHeight.of(heights));
            if (effects.length)
              queueMicrotask(() => {
                if (!this.destroyed && this.view.state.doc === doc) this.view.dispatch({ effects });
              });
          },
        });
      };
      update(): void {
        this.measure();
      }
      destroy(): void {
        this.destroyed = true;
      }
    },
  ),
  EditorView.baseTheme({ ".cm-image-source-height": { pointerEvents: "none" } }),
];
