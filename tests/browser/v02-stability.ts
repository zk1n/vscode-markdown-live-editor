import { defaultKeymap, history, isolateHistory, redo, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { findTables } from "../../src/core/markdown/tableSource.js";
import { createLivePreviewEngine } from "../../src/webview/livePreview/LivePreviewEngine.js";
import { editTable, tableEditing } from "../../src/webview/livePreview/tableEditing.js";
import {
  imageEditing,
  insertImage,
  refreshImages,
} from "../../src/webview/livePreview/imageEditing.js";
import { RichClient } from "../../src/webview/richClient.js";
import { selectionTheme } from "../../src/webview/selectionTheme.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`v02 stability: ${message}`);
}
const frame = (): Promise<void> =>
  new Promise((resolve) =>
    requestAnimationFrame(() => {
      resolve();
    }),
  );
async function measure(view: EditorView): Promise<void> {
  view.requestMeasure();
  await frame();
  await frame();
}
async function loaded(view: EditorView): Promise<HTMLImageElement> {
  for (let count = 0; count < 180; count += 1) {
    const image = view.dom.querySelector<HTMLImageElement>(".cm-image-preview img");
    if (
      image?.complete === true &&
      image.naturalWidth > 0 &&
      image.closest<HTMLElement>(".cm-image-preview")?.dataset["imageState"] === "loaded"
    )
      return image;
    await frame();
  }
  throw new Error("cold image did not load");
}
interface ImageFrameRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
interface ImageFrameSample {
  readonly image: ImageFrameRect;
  readonly connected: boolean;
  readonly hidden: boolean;
  readonly complete: boolean;
  readonly natural: { readonly width: number; readonly height: number };
  readonly src: string | null;
  readonly currentSrc: string;
  readonly state: string | undefined;
  readonly status: string | null | undefined;
  readonly statusBounds: ImageFrameRect | undefined;
  readonly preview: ImageFrameRect | undefined;
  readonly line: ImageFrameRect | undefined;
  readonly following: ImageFrameRect | undefined;
}

/** Real layout and sequential interaction evidence, not OS/IME acceptance. */
export async function runV02Stability(
  parent: HTMLElement,
): Promise<readonly Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  const engine = createLivePreviewEngine();
  const selectionSource = "before\n### heading\n\nafter";
  const selectionView = new EditorView({
    parent,
    state: EditorState.create({
      doc: selectionSource,
      extensions: [engine.extension, drawSelection(), selectionTheme],
    }),
  });
  try {
    for (const reverse of [false, true]) {
      const from = selectionView.state.doc.line(2).from;
      const to = selectionView.state.doc.line(3).from;
      selectionView.dispatch({
        selection: { anchor: reverse ? to : from, head: reverse ? from : to },
      });
      selectionView.focus();
      await measure(selectionView);
      const origin = selectionView.coordsAtPos(from);
      check(origin !== null, "multiline text origin missing");
      const backgrounds = [
        ...selectionView.dom.querySelectorAll<HTMLElement>(".cm-selectionBackground"),
      ];
      check(backgrounds.length > 0, "multiline selection background missing");
      check(
        backgrounds.every(
          (background) => background.getBoundingClientRect().left >= origin.left - 1,
        ),
        "multiline selection extends left of text origin",
      );
      check(
        selectionView.state.sliceDoc(
          selectionView.state.selection.main.from,
          selectionView.state.selection.main.to,
        ) === "### heading\n",
        "multiline logical selection differs from source",
      );
      results.push({
        ux10MultilineSelection: true,
        reverse,
        originLeft: origin.left,
        selectionLeft: backgrounds.map((background) => background.getBoundingClientRect().left),
      });
    }
  } finally {
    selectionView.destroy();
  }
  for (const width of [900, 380]) {
    parent.style.width = `${String(width)}px`;
    const source =
      "before\n\n| **名前** | 説明 |\n| --- | --- |\n| 日本語 | escaped \\| `code` [link](a.md) |\n|  | 長い説明の折り返しを確認する文章です。 |\n\nafter";
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: source,
        selection: { anchor: source.indexOf("日本語") },
        extensions: [
          engine.extension,
          tableEditing(() => true),
          history(),
          keymap.of(defaultKeymap),
        ],
      }),
    });
    try {
      const selectionTable = findTables(source)[0];
      const firstCell = selectionTable?.rows[0]?.cells[0];
      const secondCell = selectionTable?.rows[1]?.cells[1];
      check(firstCell !== undefined && secondCell !== undefined, "selection cells missing");
      for (const reverse of [false, true]) {
        view.dispatch({
          selection: {
            anchor: reverse ? secondCell.contentTo : firstCell.contentFrom,
            head: reverse ? firstCell.contentFrom : secondCell.contentTo,
          },
        });
        await measure(view);
        const selected = [
          ...view.contentDOM.querySelectorAll<HTMLElement>(".cm-table-cell-selected"),
        ];
        check(
          selected.length === 4,
          "continuous header/body selection did not highlight all included cells",
        );
        check(
          selected.every((cell) => getComputedStyle(cell).backgroundColor !== "rgba(0, 0, 0, 0)"),
          "full-cell highlight is transparent",
        );
        results.push({ ux10TableSelection: true, width, reverse, fullCells: selected.length });
      }
      view.dispatch({
        selection: { anchor: firstCell.contentFrom, head: firstCell.contentFrom + 1 },
      });
      await measure(view);
      check(
        view.contentDOM.querySelector(".cm-table-cell-selected") === null,
        "partial selection highlighted a full cell",
      );
      view.dispatch({ selection: { anchor: source.indexOf("日本語") } });
      view.focus();
      for (const action of ["row-add", "column-add"] as const) {
        const before = view.state.doc.toString();
        check(editTable(view, action), `${action} failed`);
        await measure(view);
        const position = view.state.selection.main.head;
        const point = view.coordsAtPos(position);
        check(point !== null && point.bottom > point.top, `${action} caret has no visible height`);
        const dom = view.domAtPos(position);
        const element = dom.node instanceof Element ? dom.node : dom.node.parentElement;
        const cell = element?.closest<HTMLElement>(".cm-table-cell");
        check(cell !== null && cell !== undefined, `${action} caret is outside a cell`);
        const bounds = cell.getBoundingClientRect();
        check(
          point.left >= bounds.left - 1 &&
            point.left <= bounds.right + 1 &&
            point.top >= bounds.top - 1 &&
            point.bottom <= bounds.bottom + 1,
          `${action} caret coordinates escape the target cell`,
        );
        check(view.hasFocus, `${action} lost focus`);
        view.dispatch({
          ...view.state.replaceSelection("即入力"),
          annotations: isolateHistory.of("full"),
          userEvent: "input.type",
        });
        const typed = view.state.doc.toString();
        check(typed.includes("| 即入力 |"), `${action} typed through a pipe`);
        check(undo(view), "typing Undo failed");
        check(undo(view), "table Undo failed");
        check(view.state.doc.toString() === before, "table Undo lost literal source");
        check(redo(view) && redo(view), "table/typing Redo failed");
        check(view.state.doc.toString() === typed, "Redo changed source");
        results.push({
          width,
          action,
          caret: point,
          cell: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
          immediateInput: true,
          undoRedo: true,
        });
      }
      const table = findTables(view.state.doc.toString())[0];
      const row = table?.rows[1];
      check(row !== undefined, "data row missing");
      const unchanged = view.state.doc.toString();
      check(editTable(view, "source", row.from), "explicit source mode failed");
      for (let position = row.from; position <= row.to; position += 1) {
        view.dispatch({ selection: { anchor: position } });
        await measure(view);
        const caret = view.coordsAtPos(position);
        check(
          caret !== null && caret.bottom > caret.top,
          `raw row caret invisible at ${String(position - row.from)}`,
        );
        check(
          view.contentDOM.textContent.includes(view.state.doc.sliceString(row.from, row.to)),
          "raw row hid source while moving",
        );
      }
      check(view.state.doc.toString() === unchanged, "caret movement changed Markdown");
      results.push({ width, pipeAndPaddingCaret: true, sourceUnchanged: true });
    } finally {
      view.destroy();
    }
  }
  const events: Record<string, number> = {};
  const requests: Record<string, number> = {};
  const responsiveImageUrls = new Map<string, string>([
    [
      "assets/wide.svg",
      `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="100%" height="100%" fill="#528bff"/></svg>')}`,
    ],
    [
      "assets/tall.svg",
      `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="2400"><rect width="100%" height="100%" fill="#528bff"/></svg>')}`,
    ],
  ]);
  const client = new RichClient((request) => {
    requests[request.operation] = (requests[request.operation] ?? 0) + 1;
    client.receive({
      kind: "rich-response",
      protocolVersion: 2,
      documentUri: "file:///fixture.md",
      sessionId: "browser",
      controllerId: "browser",
      requestId: request.requestId,
      documentVersion: 1,
      ok: true,
      ...(request.operation === "image-resolve"
        ? {
            url:
              responsiveImageUrls.get(request.target ?? "") ??
              "/tests/fixtures/v02-review/assets/example.png?stability",
          }
        : { markdown: "![図](assets/example.png)" }),
    });
  });
  const actions = {
    client,
    isEditable: () => true,
    synchronize: () => Promise.resolve(true),
    notify: (): void => undefined,
    onImageEvent: (event: string) => {
      events[event] = (events[event] ?? 0) + 1;
    },
  };
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "before\n\nafter",
      selection: { anchor: 7 },
      extensions: [
        EditorView.theme({ "& > .cm-scroller > .cm-content": { minWidth: "0" } }),
        engine.extension,
        imageEditing(actions),
        keymap.of(defaultKeymap),
      ],
    }),
  });
  try {
    await insertImage(view, actions);
    view.dispatch({ selection: { anchor: 0 } });
    await loaded(view);
    await measure(view);
    const image = view.dom.querySelector<HTMLImageElement>(".cm-image-preview img");
    check(image !== null, "settled image DOM missing");
    check(
      view.dom.querySelector(".cm-image-preview button") === null,
      "permanent source button remains",
    );
    const baseline = { ...events };
    for (const side of ["before", "after"]) {
      for (let count = 0; count < 12; count += 1) {
        const position = side === "before" ? 0 : view.state.doc.length;
        view.dispatch({
          changes: { from: position, insert: "字" },
          selection: { anchor: position + 1 },
          userEvent: "input.type",
        });
        await measure(view);
        check(
          view.dom.querySelector(".cm-image-preview img") === image,
          `${side} input ${String(count)} recreated image DOM: events=${JSON.stringify(events)} requests=${JSON.stringify(requests)}`,
        );
        check(
          view.dom.querySelector<HTMLElement>(".cm-image-preview")?.dataset["imageState"] ===
            "loaded",
          `${side} input restored loading`,
        );
      }
    }
    check(
      events["dom-created"] === baseline["dom-created"] &&
        events["loading"] === baseline["loading"],
      "unrelated edits restarted image lifecycle",
    );
    results.push({
      coldImage: true,
      naturalWidth: image.naturalWidth,
      continuousTyping: { before: 12, after: 12 },
      events: { ...events },
      requests: { ...requests },
      metric: "DOM/client counters; HTTP requests are recorded separately by the server",
    });
    const text = view.state.doc.toString();
    const from = text.indexOf("![図]");
    const sampleImage = (candidate: HTMLImageElement): ImageFrameSample => {
      const preview = candidate.closest<HTMLElement>(".cm-image-preview");
      const line = preview?.closest<HTMLElement>(".cm-line");
      const status = preview?.querySelector<HTMLElement>("span");
      const imageBounds = candidate.getBoundingClientRect();
      const previewBounds = preview?.getBoundingClientRect();
      const lineBounds = line?.getBoundingClientRect();
      let followingLine = line?.nextElementSibling;
      while (followingLine && !followingLine.classList.contains("cm-line"))
        followingLine = followingLine.nextElementSibling;
      const nextBounds = followingLine?.getBoundingClientRect();
      const statusBounds = status?.getBoundingClientRect();
      return {
        image: {
          left: imageBounds.left,
          top: imageBounds.top,
          width: imageBounds.width,
          height: imageBounds.height,
        },
        connected: candidate.isConnected,
        hidden: candidate.hidden !== false,
        complete: candidate.complete,
        natural: { width: candidate.naturalWidth, height: candidate.naturalHeight },
        src: candidate.getAttribute("src"),
        currentSrc: candidate.currentSrc,
        state: preview?.dataset["imageState"],
        status: status?.textContent,
        statusBounds: statusBounds && {
          left: statusBounds.left,
          top: statusBounds.top,
          width: statusBounds.width,
          height: statusBounds.height,
        },
        preview: previewBounds && {
          left: previewBounds.left,
          top: previewBounds.top,
          width: previewBounds.width,
          height: previewBounds.height,
        },
        line: lineBounds && {
          left: lineBounds.left,
          top: lineBounds.top,
          width: lineBounds.width,
          height: lineBounds.height,
        },
        following: nextBounds && {
          left: nextBounds.left,
          top: nextBounds.top,
          width: nextBounds.width,
          height: nextBounds.height,
        },
      };
    };
    const settledImage = view.dom.querySelector<HTMLImageElement>(".cm-image-preview img");
    check(settledImage !== null, "settled image DOM missing");
    const settledImageGeometry = sampleImage(settledImage);
    view.dispatch({ selection: { anchor: from - 1 } });
    view.focus();
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    check(
      view.state.selection.main.head === from &&
        view.dom.querySelector(".cm-image-preview") === null,
      "keyboard did not enter image source",
    );
    view.dispatch({ selection: { anchor: text.length } });
    const sampleCurrentImage = (): ImageFrameSample | null => {
      const current = view.dom.querySelector<HTMLImageElement>(".cm-image-preview img");
      return current === null ? null : sampleImage(current);
    };
    const restorationFrames = [sampleCurrentImage()];
    await frame();
    restorationFrames.push(sampleCurrentImage());
    const sameGeometry = (
      left: ImageFrameRect | null | undefined,
      right: ImageFrameRect | null | undefined,
    ): boolean =>
      left !== undefined &&
      left !== null &&
      right !== undefined &&
      right !== null &&
      Math.abs(left.left - right.left) <= 1 &&
      Math.abs(left.top - right.top) <= 1 &&
      Math.abs(left.width - right.width) <= 1 &&
      Math.abs(left.height - right.height) <= 1;
    check(
      restorationFrames.every(
        (sample) =>
          sample !== null &&
          sample.connected &&
          !sample.hidden &&
          sample.state !== "error" &&
          sameGeometry(sample.image, settledImageGeometry.image) &&
          sameGeometry(sample.preview, settledImageGeometry.preview) &&
          sameGeometry(sample.line, settledImageGeometry.line) &&
          sameGeometry(sample.following, settledImageGeometry.following),
      ),
      `cached restoration transiently changed image/layout: settled=${JSON.stringify(settledImageGeometry)} restored=${JSON.stringify(restorationFrames)} events=${JSON.stringify(events)} requests=${JSON.stringify(requests)}`,
    );
    await loaded(view);
    check(
      view.hasFocus && view.state.doc.toString() === text,
      "image source roundtrip changed source/focus",
    );
    view.dispatch({ effects: refreshImages.of(null) });
    const refreshed = await loaded(view);
    check(refreshed !== settledImage, "actual resource invalidation was ignored");
    results.push({
      imageKeyboardSource: true,
      resourceInvalidation: true,
      sourceUnchanged: true,
      ux10ImageRestoreFrames: restorationFrames,
    });
    const dimensionsBeforeStyleApplication = new Map<string, ImageFrameRect[]>();
    const captureResponsiveImageLoad = (event: Event): void => {
      if (!(event.target instanceof HTMLImageElement)) return;
      const target = event.target.closest<HTMLElement>(".cm-image-preview")?.dataset["imageTarget"];
      if (target === undefined || !responsiveImageUrls.has(target)) return;
      const bounds = event.target.getBoundingClientRect();
      const frames = dimensionsBeforeStyleApplication.get(target) ?? [];
      frames.push({
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      });
      dimensionsBeforeStyleApplication.set(target, frames);
    };
    document.addEventListener("load", captureResponsiveImageLoad, true);
    try {
      const targetImage = async (target: string): Promise<HTMLImageElement> => {
        const source = view.state.doc.toString();
        const from = source.indexOf("assets/");
        const to = source.indexOf(")", from);
        check(from >= 0 && to >= 0, "responsive image source missing");
        view.dispatch({
          changes: { from, to, insert: target },
          selection: { anchor: 0 },
          userEvent: "input.type",
        });
        await loaded(view);
        await measure(view);
        const image = view.dom.querySelector<HTMLImageElement>(".cm-image-preview img");
        check(image !== null, `responsive image missing: ${target}`);
        return image;
      };
      view.dom.style.width = "462px";
      view.contentDOM.style.width = "410px";
      await measure(view);
      const wide = await targetImage("assets/wide.svg");
      const wideBefore = dimensionsBeforeStyleApplication.get("assets/wide.svg")?.[0];
      const wideAfter = sampleImage(wide).image;
      check(
        wideBefore !== undefined &&
          Math.abs(wideBefore.width - wideAfter.width) <= 1 &&
          Math.abs(wideBefore.height - wideAfter.height) <= 1 &&
          Math.abs(wideAfter.width - 400) <= 1 &&
          Math.abs(wideAfter.height - (400 * 540) / 960) <= 1,
        `wide cached dimensions distorted on load: before=${JSON.stringify(wideBefore)} after=${JSON.stringify(wideAfter)} content=${String(view.contentDOM.getBoundingClientRect().width)}`,
      );
      const wideSource = view.state.doc.toString();
      const wideFrom = wideSource.indexOf("![図]");
      const wideTo = wideSource.indexOf(")", wideFrom) + 1;
      check(wideFrom >= 0 && wideTo > wideFrom, "wide image source range missing");
      const wideSettledGeometry = sampleImage(wide);
      view.dispatch({ selection: { anchor: wideFrom, head: wideTo } });
      await measure(view);
      check(view.dom.querySelector(".cm-image-preview") === null, "wide image source did not open");
      view.dispatch({ selection: { anchor: wideSource.length } });
      const wideRestorationFrames = [sampleCurrentImage()];
      await frame();
      wideRestorationFrames.push(sampleCurrentImage());
      check(
        wideRestorationFrames.every(
          (sample) =>
            sample !== null &&
            sample.connected &&
            !sample.hidden &&
            sample.state !== "error" &&
            sameGeometry(sample.image, wideSettledGeometry.image) &&
            sameGeometry(sample.preview, wideSettledGeometry.preview) &&
            sameGeometry(sample.line, wideSettledGeometry.line) &&
            sameGeometry(sample.following, wideSettledGeometry.following),
        ),
        `wide cached restore changed responsive geometry: settled=${JSON.stringify(wideSettledGeometry)} restored=${JSON.stringify(wideRestorationFrames)}`,
      );
      await loaded(view);
      view.dom.style.width = "302px";
      view.contentDOM.style.width = "250px";
      await measure(view);
      const narrow = view.dom.querySelector<HTMLImageElement>(".cm-image-preview img");
      check(narrow !== null, "narrow responsive image missing");
      const narrowBounds = narrow.getBoundingClientRect();
      check(
        Math.abs(narrowBounds.width - 240) <= 1 &&
          Math.abs(narrowBounds.height - (240 * 540) / 960) <= 1,
        `narrow image lost intrinsic ratio: ${String(narrowBounds.width)}x${String(narrowBounds.height)}`,
      );
      view.dom.style.width = "462px";
      view.contentDOM.style.width = "410px";
      await measure(view);
      const tall = await targetImage("assets/tall.svg");
      const tallBefore = dimensionsBeforeStyleApplication.get("assets/tall.svg")?.[0];
      const tallAfter = sampleImage(tall).image;
      const maxHeight = Number.parseFloat(getComputedStyle(tall).maxHeight);
      check(
        tallBefore !== undefined &&
          Math.abs(tallBefore.width - tallAfter.width) <= 1 &&
          Math.abs(tallBefore.height - tallAfter.height) <= 1 &&
          Math.abs(tallAfter.height - maxHeight) <= 1 &&
          Math.abs(tallAfter.width / tallAfter.height - 960 / 2400) < 0.005,
        `60vh image constraint distorted intrinsic ratio: before=${JSON.stringify(tallBefore)} after=${JSON.stringify(tallAfter)} maxHeight=${String(maxHeight)}`,
      );
      results.push({
        responsiveImageSizing: {
          wide: wideAfter,
          wideRestoreFrames: wideRestorationFrames,
          narrow: { width: narrowBounds.width, height: narrowBounds.height },
          viewportCapped: tallAfter,
          maxHeight,
        },
      });
    } finally {
      document.removeEventListener("load", captureResponsiveImageLoad, true);
    }
  } finally {
    view.destroy();
    client.dispose();
    engine.dispose();
  }
  return results;
}
