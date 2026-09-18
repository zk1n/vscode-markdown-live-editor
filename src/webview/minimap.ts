import { type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { searchMatches } from "./search/floatingSearch.js";
import { searchReveal } from "./livePreview/searchReveal.js";
import { editorPreferences } from "./editorPreferences.js";

interface SummaryLine {
  from: number;
  to: number;
  width: number;
  indent: number;
  block: boolean;
}
interface LineGeometry extends SummaryLine {
  readonly y: number;
  readonly bottom: number;
}
interface LineGeometryCache {
  readonly doc: Text;
  readonly lines: readonly LineGeometry[];
}
interface MatchGeometryCache {
  readonly doc: Text;
  readonly matches: readonly { readonly from: number; readonly to: number }[];
  readonly y: readonly number[];
}
/** Bounded raster detail, covering every source line even when the document exceeds the canvas. */
function summarize(doc: Text): SummaryLine[] {
  const stride = Math.max(1, Math.ceil(doc.lines / 1600));
  const result: SummaryLine[] = [];
  for (let number = 1; number <= doc.lines; number += stride) {
    const first = doc.line(number);
    let width = 0;
    let indent = 80;
    let block = false;
    let to = first.to;
    for (let offset = 0; offset < stride && number + offset <= doc.lines; offset++) {
      const line = doc.line(number + offset);
      width = Math.max(width, line.length);
      indent = Math.min(indent, line.text.search(/\S/u) < 0 ? 80 : line.text.search(/\S/u));
      block ||= /^\s*(?:#{1,6} |\||!\[)/u.test(line.text);
      to = line.to;
    }
    result.push({ from: first.from, to, width: Math.min(width, 100), indent, block });
  }
  return result;
}

/** One canvas and one viewport; no editor, document authority, images or history of its own. */
export const minimap: Extension = [
  EditorView.editorAttributes.of({ class: "cm-has-minimap" }),
  ViewPlugin.fromClass(
    class {
      readonly dom = document.createElement("div");
      readonly canvas = document.createElement("canvas");
      readonly viewport = document.createElement("div");
      private readonly observer: MutationObserver;
      private readonly resize: ResizeObserver;
      private doc: Text;
      private lines: SummaryLine[];
      private contentHeight = 1;
      private height = 1;
      private viewportTop = 0;
      private viewportHeight = 1;
      private dragOffset: number | undefined;
      private pointerId: number | undefined;
      private scrollRange = 0;
      private travel = 0;
      private geometryDirty = true;
      private lineGeometry: LineGeometryCache | undefined;
      private matchGeometry: MatchGeometryCache | undefined;
      private destroyed = false;
      private paints = 0;
      constructor(private readonly view: EditorView) {
        this.doc = view.state.doc;
        this.lines = summarize(this.doc);
        this.dom.className = "cm-minimap";
        this.dom.tabIndex = 0;
        this.dom.setAttribute("role", "scrollbar");
        this.dom.setAttribute(
          "aria-label",
          document.documentElement.lang.startsWith("ja") ? "文書ミニマップ" : "Document minimap",
        );
        this.dom.setAttribute("aria-orientation", "vertical");
        this.canvas.setAttribute("aria-hidden", "true");
        this.viewport.className = "cm-minimap-viewport";
        this.viewport.setAttribute("aria-hidden", "true");
        this.dom.append(this.canvas, this.viewport);
        view.dom.append(this.dom);
        this.dom.addEventListener("pointerdown", this.down);
        this.dom.addEventListener("pointermove", this.move);
        this.dom.addEventListener("pointerup", this.up);
        this.dom.addEventListener("pointercancel", this.up);
        this.dom.addEventListener("lostpointercapture", this.up);
        this.dom.addEventListener("keydown", this.key);
        view.scrollDOM.addEventListener("scroll", this.onScroll);
        this.observer = new MutationObserver(this.invalidateGeometry);
        for (const element of [document.documentElement, document.body])
          this.observer.observe(element, { attributes: true, attributeFilter: ["class", "style"] });
        this.resize = new ResizeObserver(this.invalidateGeometry);
        this.resize.observe(view.scrollDOM);
        this.measure();
      }
      private readonly down = (event: PointerEvent): void => {
        if (event.button !== 0) return;
        event.preventDefault(); // Scrolling preserves editor selection and the current focus owner.
        event.stopPropagation();
        const y = event.clientY - this.dom.getBoundingClientRect().top;
        const onThumb = event.target === this.viewport;
        this.dragOffset = onThumb ? y - this.viewportTop : this.viewportHeight / 2;
        this.pointerId = event.pointerId;
        this.dom.setAttribute("data-dragging", "");
        this.dom.setPointerCapture(event.pointerId);
        // Grabbing any point on the thumb preserves the current scroll exactly.
        if (!onThumb) this.scroll(y);
      };
      private readonly move = (event: PointerEvent): void => {
        if (this.dragOffset === undefined || event.pointerId !== this.pointerId) return;
        this.scroll(event.clientY - this.dom.getBoundingClientRect().top);
      };
      private readonly up = (event: PointerEvent): void => {
        if (event.pointerId !== this.pointerId) return;
        const id = this.pointerId;
        this.pointerId = undefined;
        this.dragOffset = undefined;
        this.dom.removeAttribute("data-dragging");
        if (this.dom.hasPointerCapture(id)) this.dom.releasePointerCapture(id);
      };
      private scroll(y: number): void {
        this.view.scrollDOM.scrollTop =
          this.travel <= 0
            ? 0
            : Math.min(
                this.scrollRange,
                Math.max(0, ((y - (this.dragOffset ?? 0)) / this.travel) * this.scrollRange),
              );
      }
      private readonly onScroll = (): void => {
        this.updateViewportThumb();
      };
      private readonly invalidateGeometry = (): void => {
        if (this.destroyed) return;
        this.geometryDirty = true;
        this.matchGeometry = undefined;
        this.measure();
      };
      private updateViewportThumb(): void {
        if (this.destroyed) return;
        const top = this.view.scrollDOM.scrollTop;
        this.viewportTop =
          this.scrollRange === 0 ? 0 : Math.min(1, top / this.scrollRange) * this.travel;
        this.viewport.style.top = `${String(this.viewportTop)}px`;
        this.dom.setAttribute("aria-valuenow", String(Math.round(top)));
      }
      private readonly key = (event: KeyboardEvent): void => {
        const scroller = this.view.scrollDOM;
        const steps: Record<string, number> = {
          ArrowDown: 40,
          ArrowUp: -40,
          PageDown: scroller.clientHeight,
          PageUp: -scroller.clientHeight,
          Home: -this.contentHeight,
          End: this.contentHeight,
        };
        const step = steps[event.key];
        if (
          step === undefined ||
          event.isComposing ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        scroller.scrollTop += step;
      };
      private readonly measure = (): void => {
        if (this.destroyed) return;
        this.view.requestMeasure({
          key: this,
          read: (view) => {
            const rect = this.dom.getBoundingClientRect();
            const scroller = view.scrollDOM;
            const total = Math.max(1, scroller.scrollHeight, view.contentHeight);
            const padding = view.documentPadding.top;
            const positionY = (pos: number): number => {
              // Visible wrapped lines/cells have exact coordinates. Offscreen blocks use CM's
              // measured/estimated height map, updated after image/font/viewport changes.
              const visible = view.visibleRanges.some(
                (range) => range.from <= pos && pos <= range.to,
              );
              const coords = visible ? view.coordsAtPos(pos) : null;
              return padding + (coords ? coords.top - view.documentTop : view.lineBlockAt(pos).top);
            };
            const style = getComputedStyle(this.dom);
            const token = (name: string, fallback: string): string =>
              style.getPropertyValue(name).trim() || fallback;
            const currentMatches = view.state.field(searchMatches, false) ?? [];
            const cachedLines =
              !this.geometryDirty && this.lineGeometry?.doc === view.state.doc
                ? this.lineGeometry.lines
                : undefined;
            const lines =
              cachedLines ??
              this.lines.map((line) => ({
                ...line,
                y: padding + view.lineBlockAt(line.from).top,
                bottom: padding + view.lineBlockAt(line.to).bottom,
              }));
            const cachedMatches =
              !this.geometryDirty &&
              this.matchGeometry?.doc === view.state.doc &&
              this.matchGeometry.matches === currentMatches
                ? this.matchGeometry.y
                : undefined;
            const matches = cachedMatches ?? currentMatches.map((match) => positionY(match.from));
            return {
              doc: view.state.doc,
              geometryDirty: this.geometryDirty || cachedLines === undefined,
              width: rect.width,
              height: rect.height,
              total,
              top: scroller.scrollTop,
              visible: scroller.clientHeight,
              lineHeight: view.defaultLineHeight,
              lines,
              matches,
              matchSource: currentMatches,
              current: view.state.field(searchReveal, false),
              selection: view.state.selection.ranges
                .filter((range) => !range.empty)
                .map((range) => ({ from: positionY(range.from), to: positionY(range.to) })),
              currentY: positionY(view.state.field(searchReveal, false)?.from ?? 0),
              colors: {
                text: token("--vscode-editor-foreground", "#888"),
                block: token("--vscode-textLink-foreground", "#589bd3"),
                match: token("--vscode-minimap-findMatchHighlight", "#d18616"),
                selection: token("--vscode-minimap-selectionHighlight", "#6199cf"),
              },
            };
          },
          write: (data) => {
            if (this.destroyed || data.width <= 0 || data.height <= 0) return;
            this.dom.toggleAttribute(
              "data-slider-always",
              this.view.state.facet(editorPreferences).minimapSlider === "always",
            );
            this.contentHeight = data.total;
            if (data.geometryDirty) {
              this.lineGeometry = { doc: data.doc, lines: data.lines };
              this.geometryDirty = false;
            }
            const cachedMatchGeometry = this.matchGeometry;
            if (
              cachedMatchGeometry?.doc !== data.doc ||
              cachedMatchGeometry.matches !== data.matchSource
            )
              this.matchGeometry = { doc: data.doc, matches: data.matchSource, y: data.matches };
            // Cap ordinary text at a two-pixel overview pitch. Short documents
            // remain top-aligned; long documents still cover the full source.
            const scale = Math.min(data.height / data.total, 2 / Math.max(1, data.lineHeight));
            this.height = data.total * scale;
            this.scrollRange = Math.max(0, data.total - data.visible);
            const ratio = Math.min(2, window.devicePixelRatio || 1);
            const width = Math.round(data.width * ratio),
              height = Math.round(data.height * ratio);
            if (this.canvas.width !== width || this.canvas.height !== height) {
              this.canvas.width = width;
              this.canvas.height = height;
            }
            const context = this.canvas.getContext("2d");
            if (context) {
              context.setTransform(ratio, 0, 0, ratio, 0, 0);
              context.clearRect(0, 0, data.width, data.height);
              const unit = (data.width - 12) / 100;
              for (const line of data.lines) {
                if (!line.width) continue;
                context.fillStyle = line.block ? data.colors.block : data.colors.text;
                context.globalAlpha = line.block ? 0.65 : 0.4;
                context.fillRect(
                  3 + line.indent * unit,
                  line.y * scale,
                  Math.max(1, (line.width - line.indent) * unit),
                  Math.max(1, Math.min(3, (line.bottom - line.y) * scale)),
                );
              }
              context.globalAlpha = 0.6;
              context.fillStyle = data.colors.selection;
              for (const range of data.selection)
                context.fillRect(
                  0,
                  range.from * scale,
                  data.width,
                  Math.max(2, (range.to - range.from) * scale),
                );
              context.globalAlpha = 1;
              context.fillStyle = data.colors.match;
              for (const y of data.matches) context.fillRect(data.width - 6, y * scale, 6, 2);
              if (data.current) context.fillRect(0, data.currentY * scale, data.width, 2);
            }
            this.viewportHeight = Math.min(this.height, Math.max(12, data.visible * scale));
            this.travel = Math.max(0, this.height - this.viewportHeight);
            this.viewportTop =
              this.scrollRange === 0 ? 0 : Math.min(1, data.top / this.scrollRange) * this.travel;
            this.viewport.style.top = `${String(this.viewportTop)}px`;
            this.viewport.style.height = `${String(this.viewportHeight)}px`;
            this.dom.setAttribute("aria-valuemin", "0");
            this.dom.setAttribute("aria-valuemax", String(Math.max(0, data.total - data.visible)));
            this.dom.setAttribute("aria-valuenow", String(Math.round(data.top)));
            this.dom.dataset["matches"] = String(data.matches.length);
            this.dom.dataset["selections"] = String(data.selection.length);
            this.dom.dataset["paints"] = String(++this.paints);
            this.dom.dataset["extent"] = String(this.height);
            this.dom.dataset["scale"] = String(scale);
          },
        });
      };
      update(update: ViewUpdate): void {
        if (this.doc !== update.state.doc) {
          this.doc = update.state.doc;
          this.lines = summarize(this.doc);
          this.geometryDirty = true;
          this.lineGeometry = undefined;
          this.matchGeometry = undefined;
        }
        if (update.geometryChanged) {
          this.geometryDirty = true;
          this.matchGeometry = undefined;
        }
        if (update.viewportChanged) this.updateViewportThumb();
        if (
          update.docChanged ||
          update.geometryChanged ||
          update.selectionSet ||
          update.transactions.some((tr) => tr.effects.length)
        )
          this.measure();
      }
      destroy(): void {
        this.destroyed = true;
        const id = this.pointerId;
        this.pointerId = undefined;
        this.dragOffset = undefined;
        if (id !== undefined && this.dom.hasPointerCapture(id)) this.dom.releasePointerCapture(id);
        this.observer.disconnect();
        this.resize.disconnect();
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        this.dom.remove();
      }
    },
  ),
  EditorView.baseTheme({
    "&.cm-has-minimap > .cm-scroller": { marginRight: "clamp(36px, 8vw, 72px)", minHeight: "0" },
    ".cm-minimap": {
      position: "absolute",
      right: "0",
      top: "0",
      bottom: "0",
      width: "clamp(36px, 8vw, 72px)",
      overflow: "hidden",
      touchAction: "none",
      userSelect: "none",
      background: "var(--vscode-minimap-background, var(--vscode-editor-background))",
    },
    ".cm-minimap canvas": { width: "100%", height: "100%", display: "block" },
    ".cm-minimap-viewport": {
      position: "absolute",
      left: "0",
      right: "0",
      boxSizing: "border-box",
      cursor: "grab",
      background: "var(--vscode-minimapSlider-background, #80808033)",
      border: "1px solid var(--vscode-contrastBorder, #80808055)",
      opacity: "0",
    },
    ".cm-minimap:hover .cm-minimap-viewport, .cm-minimap[data-dragging] .cm-minimap-viewport, .cm-minimap:focus-visible .cm-minimap-viewport, .cm-minimap[data-slider-always] .cm-minimap-viewport":
      { opacity: "1" },
    ".cm-minimap-viewport:hover": {
      background: "var(--vscode-minimapSlider-hoverBackground, #80808055)",
    },
    ".cm-minimap:focus-visible": {
      outline: "1px solid var(--vscode-focusBorder)",
      outlineOffset: "-1px",
    },
  }),
];
