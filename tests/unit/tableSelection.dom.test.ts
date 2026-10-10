// @vitest-environment happy-dom

import { history, redo, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findTables, type TableCell } from "../../src/core/markdown/tableSource.js";
import { createLivePreviewEngine } from "../../src/webview/livePreview/LivePreviewEngine.js";
import { editTable, tableEditing } from "../../src/webview/livePreview/tableEditing.js";
import { sourceLineSelection } from "../../src/webview/sourceLines.js";

const views: EditorView[] = [];
const engines: ReturnType<typeof createLivePreviewEngine>[] = [];
const fixture =
  "before\n\n| header | title | last |\n| --- | --- | --- |\n| alpha |  | beta |\n| gamma | delta | end |\n\nafter";

function createView(eol = "\n", source = fixture): EditorView {
  const engine = createLivePreviewEngine();
  engines.push(engine);
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: source.replaceAll("\n", eol),
      selection: { anchor: 0 },
      extensions: [engine.extension, tableEditing(() => true), sourceLineSelection, history()],
    }),
  });
  views.push(view);
  return view;
}
function cells(view: EditorView): readonly TableCell[] {
  const table = findTables(view.state.doc.toString())[0];
  if (!table) throw new Error("Expected fixture table.");
  return table.rows.flatMap((row) => row.cells);
}
function selectedOffsets(view: EditorView): number[] {
  return [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-table-cell-selected")].map(
    (element) => Number(element.dataset["tableCell"]),
  );
}
function transfer(
  view: EditorView,
  type: "copy" | "cut" | "paste",
  data = new DataTransfer(),
): DataTransfer {
  const event = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  return data;
}
function press(view: EditorView, key: string, shiftKey = false): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}
function selectPartialSpan(view: EditorView, reverse: boolean): void {
  const [start, end] = [cells(view)[2], cells(view)[7]];
  if (!start || !end) throw new Error("Expected header/body endpoints.");
  const from = start.contentFrom + 1;
  const to = end.contentFrom + 2;
  view.dispatch({ selection: { anchor: reverse ? to : from, head: reverse ? from : to } });
}
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const engine of engines.splice(0)) engine.dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("continuous table selection and cell highlights", () => {
  it.each(["\n", "\r\n"])("preserves an escaped pipe at partial endpoints for %j", (eol) => {
    const source = "| h1 | h2 |\n| --- | --- |\n| alpha | xx\\|tail |";
    for (const reverse of [false, true])
      for (const operation of ["type", "native-paste", "paste", "tsv", "cut", "delete"] as const) {
        const view = createView(eol, source);
        const first = cells(view)[2],
          last = cells(view)[3];
        if (!first || !last) throw new Error("Expected escaped endpoint cells.");
        const from = first.contentFrom + 1,
          to = last.contentFrom + 3;
        view.dispatch({ selection: { anchor: reverse ? to : from, head: reverse ? from : to } });
        if (operation === "type" || operation === "native-paste")
          view.dispatch({
            ...view.state.replaceSelection("X"),
            userEvent: operation === "type" ? "input.type" : "input.paste",
          });
        else if (operation === "delete") press(view, "Delete");
        else if (operation === "cut")
          expect(transfer(view, "cut").getData("text/plain")).toBe("lpha\txx\\");
        else {
          const data = new DataTransfer();
          data.setData("text/plain", operation === "tsv" ? "X\tY" : "X");
          transfer(view, "paste", data);
        }
        const expected = source
          .replace("alpha", operation === "cut" || operation === "delete" ? "a" : "aX")
          .replace("xx\\|tail", operation === "tsv" ? "Y\\|tail" : "\\|tail");
        expect(view.state.doc.toString()).toBe(expected);
        expect(findTables(view.state.doc.toString())).toHaveLength(1);
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(source);
        expect(redo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(expected);
      }
  });

  it.each([1, 2])("normalizes inserted pipe with %i retained prefix backslashes", (count) => {
    const prefix = `pre${"\\".repeat(count)}`;
    const source = `| h1 | h2 |\n| --- | --- |\n| ${prefix}tail | xx\\|tail |`;
    for (const operation of ["type", "paste", "tsv"] as const) {
      const view = createView("\n", source);
      const first = cells(view)[2],
        last = cells(view)[3];
      if (!first || !last) throw new Error("Expected prefix cells.");
      view.dispatch({
        selection: { anchor: first.contentFrom + prefix.length, head: last.contentFrom + 3 },
      });
      if (operation === "type")
        view.dispatch({ ...view.state.replaceSelection("|"), userEvent: "input.type" });
      else {
        const data = new DataTransfer();
        data.setData("text/plain", operation === "tsv" ? "|\tY" : "|");
        transfer(view, "paste", data);
      }
      const expected = `| h1 | h2 |\n| --- | --- |\n| ${prefix}${count % 2 === 0 ? "\\" : ""}| | ${operation === "tsv" ? "Y" : ""}\\|tail |`;
      expect(view.state.doc.toString()).toBe(expected);
      expect(findTables(view.state.doc.toString())).toHaveLength(1);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
    }
  });
  it.each(["\n", "\r\n"])("matches copy, cut, Delete and undo for %j in both directions", (eol) => {
    for (const reverse of [false, true]) {
      const view = createView(eol);
      selectPartialSpan(view, reverse);
      const source = view.state.doc.toString();
      const parsed = cells(view);
      expect(selectedOffsets(view)).toEqual(parsed.slice(3, 7).map((cell) => cell.contentFrom));
      expect(
        [...view.contentDOM.querySelectorAll(".cm-table-selected-text")].map(
          (node) => node.textContent,
        ),
      ).toEqual(["ast", "de"]);
      const data = transfer(view, "copy");
      expect(data.getData("text/plain")).toBe("ast\nalpha\t\tbeta\ngamma\tde");
      expect(data.getData("text/tab-separated-values")).toBe(""); // ragged text, not a matrix
      expect(view.state.doc.toString()).toBe(source);
      const cut = transfer(view, "cut");
      expect(cut.getData("text/plain")).toBe(data.getData("text/plain"));
      const expected = source
        .replace(" last |", " l |")
        .replace(" alpha |  | beta |", "  |  |  |")
        .replace(" gamma | delta | end |", "  | lta | end |");
      expect(view.state.doc.toString()).toBe(expected);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
      expect(redo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
      undo(view);
      selectPartialSpan(view, reverse);
      press(view, reverse ? "Backspace" : "Delete");
      expect(view.state.doc.toString()).toBe(expected);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
    }
  });

  it("fills the cell including padding only for full content and clears stale highlights", () => {
    const view = createView();
    const cell = cells(view)[3];
    if (!cell) throw new Error("Expected alpha cell.");
    view.dispatch({ selection: { anchor: cell.contentFrom, head: cell.contentTo - 1 } });
    expect(selectedOffsets(view)).toEqual([]);
    expect(view.contentDOM.querySelector(".cm-table-selected-text")?.textContent).toBe("alph");
    view.dispatch({ selection: { anchor: cell.contentTo, head: cell.contentFrom } });
    expect(selectedOffsets(view)).toEqual([cell.contentFrom]);
    expect(view.contentDOM.querySelector(".cm-table-selected-text")).toBeNull();
    expect(view.dom.classList.contains("cm-table-selection-active")).toBe(true);
    view.dispatch({ selection: { anchor: cell.contentFrom } });
    expect(selectedOffsets(view)).toEqual([]);
    expect(view.dom.classList.contains("cm-table-selection-active")).toBe(false);
    view.dispatch({ selection: { anchor: cell.contentFrom, head: cell.contentTo } });
    editTable(view, "source");
    expect(view.dom.querySelector(".cm-table-cell-selected")).toBeNull();
    expect(view.dom.classList.contains("cm-table-selection-active")).toBe(false);
  });

  it("highlights empty cells only when a nonempty range strictly crosses their point", () => {
    const view = createView();
    const [start, empty, end] = cells(view).slice(3, 6);
    if (!start || !empty || !end) throw new Error("Expected body row.");
    view.dispatch({ selection: { anchor: empty.contentFrom } });
    expect(selectedOffsets(view)).toEqual([]);
    view.dispatch({ selection: { anchor: start.contentFrom, head: empty.contentFrom } });
    expect(selectedOffsets(view)).toEqual([start.contentFrom]);
    view.dispatch({ selection: { anchor: start.contentFrom, head: end.contentTo } });
    expect(selectedOffsets(view)).toEqual([start.contentFrom, empty.contentFrom, end.contentFrom]);
    expect(transfer(view, "copy").getData("text/plain")).toBe("alpha\t\tbeta");
    expect(view.state.doc.toString()).toBe(fixture);
  });

  it("round-trips ragged copied slices including partial endpoints without touching neighbors", () => {
    const view = createView();
    selectPartialSpan(view, true);
    const copied = transfer(view, "copy");
    transfer(view, "paste", copied);
    expect(view.state.doc.toString()).toBe(fixture);
    selectPartialSpan(view, false);
    const text = new DataTransfer();
    text.setData("text/plain", "new|value\nline");
    transfer(view, "paste", text);
    expect(view.state.doc.toString()).toBe(
      fixture
        .replace(" last |", " lnew\\|value line |")
        .replace(" alpha |  | beta |", "  |  |  |")
        .replace(" gamma | delta | end |", "  | lta | end |"),
    );
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(fixture);
  });

  it("projects native typed replacement onto selected cell text as one undo unit", () => {
    const view = createView();
    selectPartialSpan(view, false);
    view.dispatch({ ...view.state.replaceSelection("入力|"), userEvent: "input.type" });
    expect(view.state.doc.toString()).toBe(
      fixture
        .replace(" last |", " l入力\\| |")
        .replace(" alpha |  | beta |", "  |  |  |")
        .replace(" gamma | delta | end |", "  | lta | end |"),
    );
    expect(view.state.selection.main.empty).toBe(true);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(fixture);
  });

  it("extends Shift arrows across cells, empty cells and header/body in both directions", () => {
    const view = createView();
    const [first, next, lastHeader, firstBody, empty, lastBody] = cells(view);
    if (!first || !next || !lastHeader || !firstBody || !empty || !lastBody)
      throw new Error("Expected keyboard cells.");
    view.dispatch({ selection: { anchor: first.contentFrom, head: first.contentTo } });
    press(view, "ArrowRight", true);
    expect(view.state.selection.main.anchor).toBe(first.contentFrom);
    expect(view.state.selection.main.head).toBe(next.contentFrom);
    view.dispatch({ selection: { anchor: lastHeader.contentFrom, head: lastHeader.contentTo } });
    press(view, "ArrowRight", true);
    expect(view.state.selection.main.head).toBe(firstBody.contentFrom);
    view.dispatch({ selection: { anchor: firstBody.contentFrom, head: firstBody.contentTo } });
    press(view, "ArrowRight", true);
    expect(view.state.selection.main.head).toBe(empty.contentFrom);
    press(view, "ArrowRight", true);
    expect(view.state.selection.main.head).toBe(lastBody.contentFrom);
    expect(selectedOffsets(view)).toContain(empty.contentFrom);
    press(view, "ArrowLeft", true);
    expect(view.state.selection.main.head).toBe(empty.contentFrom);
    expect(selectedOffsets(view)).not.toContain(empty.contentFrom);
    view.dispatch({ selection: { anchor: firstBody.contentTo, head: firstBody.contentFrom } });
    press(view, "ArrowLeft", true);
    expect(view.state.selection.main.head).toBe(lastHeader.contentTo);
    expect(view.state.doc.toString()).toBe(fixture);
  });

  it("uses browser text hits for continuous pointer endpoints, including empty widgets", () => {
    const view = createView();
    const all = cells(view);
    const first = all[2],
      empty = all[4],
      last = all[7];
    if (!first || !empty || !last) throw new Error("Expected pointer cells.");
    const element = (from: number): HTMLElement | null =>
      view.contentDOM.querySelector<HTMLElement>(`[data-table-cell="${String(from)}"]`);
    const start = element(first.contentFrom),
      finish = element(last.contentFrom);
    if (!start || !finish) throw new Error("Expected pointer DOM cells.");
    vi.spyOn(document, "elementFromPoint").mockImplementation((x) => (x === 10 ? start : finish));
    vi.spyOn(view, "posAtCoords").mockImplementation(({ x }) =>
      x === 10 ? first.contentFrom + 1 : last.contentFrom + 2,
    );
    const down = new MouseEvent("mousedown", { button: 0, detail: 1, clientX: 10 });
    const move = new MouseEvent("mousemove", { buttons: 1, clientX: 100 });
    const makeStyle = view.state.facet(EditorView.mouseSelectionStyle)[0];
    const style = makeStyle?.(view, down);
    if (!style) throw new Error("Expected pointer selection style.");
    view.dispatch({ selection: style.get(move, false, false) });
    expect(view.state.selection.main).toMatchObject({
      from: first.contentFrom + 1,
      to: last.contentFrom + 2,
    });
    expect(selectedOffsets(view)).toContain(empty.contentFrom);
    const reverse = makeStyle?.(
      view,
      new MouseEvent("mousedown", { button: 0, detail: 1, clientX: 100 }),
    );
    if (!reverse) throw new Error("Expected reverse style.");
    view.dispatch({
      selection: reverse.get(new MouseEvent("mousemove", { clientX: 10 }), false, false),
    });
    expect(view.state.selection.main.anchor).toBe(last.contentFrom + 2);
    expect(view.state.selection.main.head).toBe(first.contentFrom + 1);
    expect(view.state.doc.toString()).toBe(fixture);
  });
});
