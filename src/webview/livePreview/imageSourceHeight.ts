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
  readonly target: string;
  readonly pending?: boolean;
}
const measured = StateEffect.define<readonly Height[]>();
const textHeight = StateEffect.define<ReadonlyMap<number, number>>();
/** Remove a temporary source-edit reservation after the replacement settles. */
export const imageHeightSettled = StateEffect.define<readonly number[]>();
/** Mark visible images as pending before their resource widgets are rebuilt. */
export const imageHeightRefresh = StateEffect.define();
/** A bounded frame for an image that has not produced a decoded measurement yet. */
export const IMAGE_SOURCE_HEIGHT_PLACEHOLDER = 96;
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
    const images = findMarkdownLinks(tr.state.doc.toString()).filter((link) => link.image);
    const refresh = tr.effects.some((effect) => effect.is(imageHeightRefresh));
    const selected = (from: number, to: number): boolean =>
      tr.newSelection.ranges.some((range) => range.from <= to && range.to >= from);
    let next = value.flatMap((current) => {
      const removed: boolean[] = [];
      tr.changes.iterChangedRanges((from, to) => {
        removed.push(from <= current.from && to >= current.to && to > from);
      });
      const from = tr.changes.mapPos(current.from, -1);
      const to = tr.changes.mapPos(current.to, 1);
      // A whole-source replacement can briefly make the old range look
      // removed even when the replacement is another image. Keep the measured
      // block until that image settles; a real deletion still releases it.
      const replacement = images.find(
        (link) => link.from <= from && link.to >= from && link.to >= to,
      );
      const replacementIsImage = replacement !== undefined;
      const uriChanged = replacementIsImage && replacement.target !== current.target;
      const pending = current.pending === true || refresh || uriChanged || selected(from, to);
      return removed.some(Boolean) && !replacementIsImage
        ? []
        : [
            {
              ...current,
              from,
              to,
              ...(replacementIsImage ? { target: replacement.target } : {}),
              ...(pending ? { pending: true } : {}),
            },
          ];
    });
    if (!tr.docChanged)
      next.push(
        ...tr.startState
          .field(geometry)
          .filter((item) => !next.some((other) => other.from === item.from))
          .map((item) =>
            refresh || selected(item.from, item.to) ? { ...item, pending: true } : item,
          ),
      );
    for (const link of images) {
      if (!selected(link.from, link.to) || next.some((item) => item.from === link.from)) continue;
      next.push({
        from: link.from,
        to: link.to,
        height: IMAGE_SOURCE_HEIGHT_PLACEHOLDER,
        textHeight: 0,
        target: link.target,
        pending: true,
      });
    }
    next = next.filter((item) => item.pending === true || selected(item.from, item.to));
    for (const effect of tr.effects)
      if (effect.is(textHeight))
        next = next.map((item) => ({
          ...item,
          textHeight: effect.value.get(item.from) ?? item.textHeight,
        }));
    for (const effect of tr.effects)
      if (effect.is(imageHeightSettled))
        next = next.filter((item) => !effect.value.includes(item.from));
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
              if (link && rect && rect.height > 0) {
                const previous = view.state.field(geometry).find((item) => item.from === from);
                const loading = element.dataset["imageState"] === "loading";
                // A loading frame is not a decoded image measurement. Keep the
                // prior valid frame if one exists; otherwise the session uses
                // its bounded placeholder until this generation settles.
                if (loading && previous === undefined) continue;
                const height = loading ? Math.max(rect.height, previous?.height ?? 0) : rect.height;
                values.push({
                  from,
                  to: link.to,
                  height,
                  textHeight: view.defaultLineHeight,
                  target: link.target,
                });
              }
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
