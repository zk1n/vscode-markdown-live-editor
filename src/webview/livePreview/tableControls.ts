import { type EditorState, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { findTables, type SourceTable } from "../../core/markdown/tableSource.js";
import { createControlledTooltip } from "../controlledTooltip.js";
import { editorPreferences } from "../editorPreferences.js";
import type { TableAction } from "./tableEditing.js";
import { setTableWidths, tableWidths } from "./tableMeasurements.js";

interface ButtonSpec {
  key: string;
  action: TableAction;
  target: number;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
  disabled: boolean;
}
export function tableControls(
  isEditable: () => boolean,
  isSource: (state: EditorState, table: SourceTable) => boolean,
  edit: (view: EditorView, action: TableAction, target?: number) => boolean,
): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly tooltip;
      private readonly buttons = new Map<string, HTMLButtonElement>();
      private pressed:
        | {
            button: HTMLButtonElement;
            id: number;
            x: number;
            y: number;
            doc: EditorState["doc"];
            ready: boolean;
          }
        | undefined;
      private destroyed = false;
      constructor(private readonly view: EditorView) {
        this.tooltip = createControlledTooltip(view.dom);
        view.dom.addEventListener("scroll", this.measure, true);
        const doc = view.dom.ownerDocument;
        doc.addEventListener("pointerdown", this.cancel, true);
        doc.addEventListener("pointermove", this.track, true);
        doc.addEventListener("pointerup", this.release, true);
        doc.addEventListener("pointercancel", this.cancel, true);
        doc.defaultView?.addEventListener("blur", this.cancel);
        this.measure();
      }
      private create(spec: ButtonSpec): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.className = spec.action.endsWith("delete")
          ? "cm-table-add cm-table-delete"
          : "cm-table-add";
        button.dataset["tableAdd"] = spec.action;
        button.textContent = spec.action.endsWith("delete") ? "−" : "+";
        button.setAttribute("aria-label", spec.label);
        this.tooltip.attach(button, spec.label);
        button.addEventListener("pointerdown", (event) => {
          if (event.button !== 0 || !isEditable() || button.disabled) return;
          event.preventDefault();
          this.pressed = {
            button,
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            doc: this.view.state.doc,
            ready: false,
          };
        });
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", (event) => {
          const keyboard =
            event.detail === 0 && this.view.dom.ownerDocument.activeElement === button;
          const pointer =
            event.button === 0 &&
            this.pressed?.button === button &&
            this.pressed.ready &&
            this.pressed.doc === this.view.state.doc;
          this.pressed = undefined;
          if ((keyboard || pointer) && !button.hidden && !button.disabled && isEditable())
            edit(this.view, spec.action, Number(button.dataset["tableTarget"]));
        });
        this.view.dom.append(button);
        return button;
      }
      private readonly cancel = (): void => {
        this.pressed = undefined;
      };
      private readonly track = (event: PointerEvent): void => {
        const press = this.pressed;
        if (
          press &&
          (press.id !== event.pointerId ||
            Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4)
        )
          this.cancel();
      };
      private readonly release = (event: PointerEvent): void => {
        const press = this.pressed;
        if (press?.id !== event.pointerId) return;
        const rect = press.button.getBoundingClientRect();
        if (
          event.button === 0 &&
          event.target === press.button &&
          event.clientX >= rect.left &&
          event.clientX < rect.right &&
          event.clientY >= rect.top &&
          event.clientY < rect.bottom
        )
          press.ready = true;
        else this.cancel();
      };
      private readonly measure = (): void => {
        if (this.destroyed) return;
        this.view.requestMeasure({
          key: this,
          read: (view) => {
            const root = view.dom.getBoundingClientRect(),
              scroll = view.scrollDOM.getBoundingClientRect();
            const preferences = view.state.facet(editorPreferences);
            const band = preferences.tableBandSize;
            const specs: ButtonSpec[] = [];
            const widths = new Map<number, number>();
            const canvas = view.dom.ownerDocument.createElement("canvas");
            const context = canvas.getContext("2d");
            for (const table of findTables(view.state.doc.toString())) {
              if (isSource(view.state, table)) continue;
              const rows = [
                ...view.contentDOM.querySelectorAll<HTMLElement>(
                  `[data-table-from="${String(table.from)}"]`,
                ),
              ];
              const first = rows[0],
                last = rows.at(-1);
              const wrapper = first?.closest<HTMLElement>(".cm-table-scroll");
              if (!first || !last || !wrapper) continue;
              const bounds = wrapper.getBoundingClientRect(),
                firstRect = first.getBoundingClientRect(),
                lastRect = last.getBoundingClientRect();
              const cells = rows.flatMap((row) => [
                ...row.querySelectorAll<HTMLElement>(".cm-table-cell"),
              ]);
              for (const cell of cells) {
                const style = getComputedStyle(cell);
                const em = Number.parseFloat(style.fontSize) || 14;
                let textWidth = 0;
                const walker = view.dom.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                  const font = node.parentElement ? getComputedStyle(node.parentElement) : style;
                  if (context)
                    context.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
                  textWidth +=
                    context?.measureText(node.textContent ?? "").width ??
                    (node.textContent?.length ?? 0) * em * 0.6;
                }
                for (const inline of cell.querySelectorAll<HTMLElement>("span, code")) {
                  const css = getComputedStyle(inline);
                  textWidth +=
                    (Number.parseFloat(css.paddingLeft) || 0) +
                    (Number.parseFloat(css.paddingRight) || 0) +
                    (Number.parseFloat(css.borderLeftWidth) || 0) +
                    (Number.parseFloat(css.borderRightWidth) || 0);
                }
                const width = Math.min(
                  preferences.tableMaxWidth * em,
                  Math.max(preferences.tableMinWidth * em, textWidth + 16),
                );
                widths.set(Number(cell.dataset["tableCell"]), Math.ceil(width));
              }
              const left = Math.max(bounds.left, scroll.left),
                right = Math.min(firstRect.right, bounds.right, scroll.right - band - 2);
              const add = (
                key: string,
                action: TableAction,
                target: number,
                label: string,
                x: number,
                y: number,
                width: number,
                height: number,
                disabled = false,
              ): void => {
                if (
                  width <= 1 ||
                  height <= 1 ||
                  y < scroll.top ||
                  y + height > scroll.bottom ||
                  x < scroll.left ||
                  x + width > scroll.right
                )
                  return;
                specs.push({
                  key: `${String(table.from)}:${key}`,
                  action,
                  target,
                  label,
                  left: x - root.left,
                  top: y - root.top,
                  width,
                  height,
                  disabled,
                });
              };
              if (Number(last.dataset["tableRow"]) === table.rows.length - 1)
                add(
                  "row",
                  "row-append",
                  table.from,
                  "末尾に行を追加",
                  left,
                  lastRect.bottom + 2,
                  right - left,
                  band,
                );
              add(
                "column",
                "column-append",
                table.from,
                "末尾に列を追加",
                right + 2,
                Math.max(firstRect.top, scroll.top),
                band,
                Math.min(lastRect.bottom, scroll.bottom) - Math.max(firstRect.top, scroll.top),
              );
              for (const [index, cell] of [
                ...first.querySelectorAll<HTMLElement>(".cm-table-header"),
              ].entries()) {
                const rect = cell.getBoundingClientRect(),
                  target = table.rows[0]?.cells[index];
                const x = Math.max(left, rect.left),
                  end = Math.min(right, rect.right);
                if (target)
                  add(
                    `column-delete-${String(index)}`,
                    "column-delete",
                    target.contentFrom,
                    `${String(index + 1)}列目を削除`,
                    x,
                    firstRect.top - band - 2,
                    end - x,
                    band,
                    table.columns <= 1,
                  );
              }
              for (const row of rows) {
                const index = Number(row.dataset["tableRow"]);
                if (index === 0) continue;
                const rect = row.getBoundingClientRect(),
                  target = table.rows[index]?.cells[0];
                const top = Math.max(rect.top, scroll.top),
                  bottom = Math.min(rect.bottom, scroll.bottom);
                if (target)
                  add(
                    `row-delete-${String(index)}`,
                    "row-delete",
                    target.contentFrom,
                    `${String(index)}行目の本文行を削除`,
                    left - band - 2,
                    top,
                    band,
                    bottom - top,
                  );
              }
            }
            return { specs, widths, doc: view.state.doc };
          },
          write: ({ specs, widths, doc }) => {
            if (this.destroyed) return;
            const previous = this.view.state.field(tableWidths);
            if ([...widths].some(([from, width]) => previous.get(from) !== width))
              queueMicrotask(() => {
                if (!this.destroyed && this.view.state.doc === doc)
                  this.view.dispatch({
                    effects: setTableWidths.of(new Map([...previous, ...widths])),
                  });
              });
            const live = new Set(specs.map((spec) => spec.key));
            for (const [key, button] of this.buttons)
              if (!live.has(key)) {
                button.remove();
                this.buttons.delete(key);
                this.tooltip.hide();
                if (this.pressed?.button === button) this.cancel();
              }
            for (const spec of specs) {
              let button = this.buttons.get(spec.key);
              if (!button) {
                button = this.create(spec);
                this.buttons.set(spec.key, button);
              }
              button.dataset["tableTarget"] = String(spec.target);
              button.dataset["tableFrom"] = spec.key.split(":")[0] ?? "";
              button.disabled = spec.disabled || !isEditable();
              Object.assign(button.style, {
                left: `${String(spec.left)}px`,
                top: `${String(spec.top)}px`,
                width: `${String(spec.width)}px`,
                height: `${String(spec.height)}px`,
              });
            }
            this.tooltip.reposition();
          },
        });
      };
      update(update: ViewUpdate): void {
        if (update.docChanged) {
          this.cancel();
          for (const button of this.buttons.values()) button.remove();
          this.buttons.clear();
          this.tooltip.hide();
        }
        if (
          update.docChanged ||
          update.geometryChanged ||
          update.viewportChanged ||
          update.transactions.some((tr) => tr.effects.length)
        )
          this.measure();
      }
      destroy(): void {
        this.destroyed = true;
        this.cancel();
        this.tooltip.destroy();
        this.view.dom.removeEventListener("scroll", this.measure, true);
        const doc = this.view.dom.ownerDocument;
        doc.removeEventListener("pointerdown", this.cancel, true);
        doc.removeEventListener("pointermove", this.track, true);
        doc.removeEventListener("pointerup", this.release, true);
        doc.removeEventListener("pointercancel", this.cancel, true);
        doc.defaultView?.removeEventListener("blur", this.cancel);
        for (const button of this.buttons.values()) button.remove();
      }
    },
  );
}
