// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { RichClient } from "../../src/webview/richClient.js";
import {
  imageEditing,
  imageInsertion,
  refreshImages,
  type ImageActions,
} from "../../src/webview/livePreview/imageEditing.js";
import { IMAGE_SOURCE_HEIGHT_PLACEHOLDER } from "../../src/webview/livePreview/imageSourceHeight.js";

const views: EditorView[] = [];
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);

afterEach((): void => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function dataTransfer(file?: File): DataTransfer {
  const transfer = new DataTransfer();
  if (file !== undefined) transfer.items.add(file);
  return transfer;
}

function eventWithTransfer(type: "paste" | "drop", transfer: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", {
    value: transfer,
  });
  return event;
}

function imageFile(name = "image.png", type = "image/png"): File {
  return new File([png], name, { type });
}

function createView(
  text: string,
  selection = 0,
  defer?: (reply: () => void) => void,
  deferResolve?: (target: string, reply: () => void) => void,
): {
  readonly view: EditorView;
  readonly notices: string[];
  readonly requested: string[];
  readonly events: string[];
} {
  const notices: string[] = [];
  const requested: string[] = [];
  const events: string[] = [];
  const client = new RichClient((request): void => {
    requested.push(request.operation);
    const reply = (): void => {
      client.receive({
        kind: "rich-response",
        protocolVersion: 2,
        documentUri: "file:///source.md",
        sessionId: "session",
        controllerId: "controller",
        requestId: request.requestId,
        documentVersion: 1,
        ok: true,
        ...(request.operation === "image-import"
          ? { markdown: "![image](attachments/image.png)" }
          : request.operation === "image-resolve"
            ? { url: `/resolved/${request.target ?? ""}` }
            : {}),
      });
    };
    if (deferResolve && request.operation === "image-resolve")
      deferResolve(request.target ?? "", reply);
    else if (defer && request.operation === "image-import") defer(reply);
    else queueMicrotask(reply);
  });
  const actions: ImageActions = {
    client,
    isEditable: (): boolean => true,
    synchronize: (): Promise<boolean> => Promise.resolve(true),
    notify: (note): void => {
      notices.push(note);
    },
    onImageEvent: (event): void => {
      events.push(event);
    },
  };
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: { anchor: selection },
      extensions: [imageEditing(actions)],
    }),
    parent,
  });
  views.push(view);
  return { view, notices, requested, events };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
}

describe("image paste and drop", () => {
  it("does not reclaim focus after a pending paste moves to another UI or window", async () => {
    for (const departure of ["control", "window", "blur"] as const) {
      let reply: (() => void) | undefined;
      const { view } = createView("before\n\n", 8, (next) => {
        reply = next;
      });
      view.focus();
      view.contentDOM.dispatchEvent(eventWithTransfer("paste", dataTransfer(imageFile())));
      await settle();
      const outside = document.createElement("button");
      document.body.append(outside);
      if (departure === "window") window.dispatchEvent(new Event("blur"));
      if (departure === "blur") view.contentDOM.blur();
      else outside.focus();
      reply?.();
      await settle();
      if (departure !== "blur") expect(document.activeElement).toBe(outside);
      expect(view.hasFocus).toBe(false);
      expect(view.state.doc.toString()).toContain("![image]");
    }
  });
  it("cancels pending insertion after a selection move or disposal", async () => {
    for (const disposal of [false, true]) {
      let reply: (() => void) | undefined;
      const { view } = createView("before", 3, (next) => {
        reply = next;
      });
      view.focus();
      view.contentDOM.dispatchEvent(eventWithTransfer("paste", dataTransfer(imageFile())));
      await settle();
      if (disposal) {
        view.destroy();
        view.dom.remove();
        views.splice(views.indexOf(view), 1);
      } else view.dispatch({ selection: { anchor: 0 } });
      reply?.();
      await settle();
      expect(view.state.doc.toString()).toBe("before");
    }
  });
  it("uses an existing blank line after a standalone image and adds only a needed newline", () => {
    expect(imageInsertion("before\n\nafter", 7, 7, "![](x)")).toEqual({
      text: "![](x)\n",
      caret: 14,
    });
    expect(imageInsertion("before\n\n\nafter", 7, 7, "![](x)")).toEqual({
      text: "![](x)",
      caret: 14,
    });
    expect(imageInsertion("before\n", 7, 7, "![](x)")).toEqual({ text: "![](x)\n", caret: 14 });
    expect(imageInsertion("inline", 3, 3, "![](x)")).toEqual({ text: "![](x)", caret: 9 });
  });
  it("retains the loaded DOM while following each image's current source position", async () => {
    const { view, requested } = createView(
      "before\n![alt](assets/image.png)\n\n![alt](assets/image.png)\n\nafter",
    );
    await settle();
    const originals = [...view.dom.querySelectorAll(".cm-image-preview img")];
    for (let index = 0; index < 5; index += 1)
      view.dispatch({ changes: { from: 0, insert: "x" }, selection: { anchor: 1 } });
    expect([...view.dom.querySelectorAll(".cm-image-preview img")]).toEqual(originals);
    expect(requested.filter((operation) => operation === "image-resolve")).toHaveLength(2);
    const second = view.dom.querySelectorAll<HTMLElement>(".cm-image-preview")[1];
    const from = view.state.doc.toString().lastIndexOf("![alt]");
    expect(second?.dataset["imageFrom"]).toBe(String(from));
    second
      ?.querySelector("img")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view.state.selection.main.from).toBe(from);
  });
  it("keeps the image DOM and measured-sized placeholder during a same-revision source switch", async () => {
    const source = "before\n![alt](first.png)\nafter";
    const { view, requested, events } = createView(source);
    await settle();
    const preview = view.dom.querySelector<HTMLElement>(".cm-image-preview");
    const image = preview?.querySelector("img");
    expect(image).not.toBeNull();
    const created = events.filter((event) => event === "dom-created").length;
    const firstTarget = source.indexOf("first.png");
    view.dispatch({
      changes: { from: firstTarget, to: firstTarget + "first.png".length, insert: "second.png" },
      // Keep the preview visible while the source update is applied; a real
      // source edit can leave the caret outside the image after composition.
      selection: { anchor: 0 },
      userEvent: "input.type",
    });
    await settle();

    expect(preview).toBe(view.dom.querySelector(".cm-image-preview"));
    expect(preview?.querySelector("img")).toBe(image);
    expect(preview?.dataset["imageTarget"]).toBe("second.png");
    expect(preview?.dataset["imageState"]).toBe("loading");
    expect(events.filter((event) => event === "dom-created")).toHaveLength(created);
    expect(requested.filter((operation) => operation === "image-resolve")).toHaveLength(2);
    image?.dispatchEvent(new Event("load"));
    expect(preview?.dataset["imageState"]).toBe("loaded");
  });
  it("ignores a stale resolve after a newer source generation starts", async () => {
    const replies = new Map<string, () => void>();
    const source = "before\n![alt](first.png)\nafter";
    const { view } = createView(source, 0, undefined, (target, reply) => {
      replies.set(target, reply);
    });
    await settle();
    const preview = view.dom.querySelector<HTMLElement>(".cm-image-preview");
    const image = preview?.querySelector("img");
    expect(preview?.dataset["imageState"]).toBe("loading");

    const target = source.indexOf("first.png");
    view.dispatch({
      changes: { from: target, to: target + "first.png".length, insert: "second.png" },
      selection: { anchor: 0 },
      userEvent: "input.type",
    });
    await settle();
    replies.get("first.png")?.();
    await settle();
    expect(preview?.dataset["imageState"]).toBe("loading");
    expect(image?.src).not.toContain("first.png");

    replies.get("second.png")?.();
    await settle();
    image?.dispatchEvent(new Event("load"));
    expect(preview?.dataset["imageState"]).toBe("loaded");
  });

  it("creates a fresh frame after remove and recreate instead of reusing the old request", async () => {
    const replies: (() => void)[] = [];
    const imageText = "![alt](first.png)";
    const source = `before\n${imageText}\nafter`;
    const { view } = createView(source, 0, undefined, (_target, reply) => {
      replies.push(reply);
    });
    await settle();
    const original = view.dom.querySelector<HTMLElement>(".cm-image-preview");
    expect(original).not.toBeNull();
    const from = source.indexOf(imageText);
    view.dispatch({
      changes: { from, to: from + imageText.length },
      selection: { anchor: 0 },
      userEvent: "input.delete",
    });
    await settle();
    expect(view.dom.querySelector(".cm-image-preview")).toBeNull();

    view.dispatch({
      changes: { from: "before\n".length, insert: `${imageText}\n` },
      selection: { anchor: 0 },
      userEvent: "input.type",
    });
    await settle();
    const recreated = view.dom.querySelector<HTMLElement>(".cm-image-preview");
    expect(recreated).not.toBeNull();
    expect(recreated).not.toBe(original);
    replies[0]?.();
    await settle();
    expect(recreated?.dataset["imageState"]).toBe("loading");
    replies[1]?.();
    await settle();
    recreated?.querySelector("img")?.dispatchEvent(new Event("load"));
    expect(recreated?.dataset["imageState"]).toBe("loaded");
  });

  it("uses a bounded placeholder before any decoded image measurement exists", async () => {
    const source = "before\n![alt](first.png)\nafter";
    const { view } = createView(source);
    const from = source.indexOf("![alt]");
    const to = source.indexOf("\n", from);
    view.dispatch({ selection: { anchor: from, head: to } });
    await settle();

    const placeholder = view.dom.querySelector<HTMLElement>(".cm-image-source-height");
    expect(placeholder).not.toBeNull();
    expect(Number.parseFloat(placeholder?.style.height ?? "0")).toBe(
      IMAGE_SOURCE_HEIGHT_PLACEHOLDER,
    );
    expect(view.state.doc.toString()).toBe(source);
  });

  it("keeps the last measured frame across source leave and refresh until the new load settles", async () => {
    const source = "before\n![alt](first.png)\nafter";
    const { view } = createView(source);
    const initialPreview = view.dom.querySelector<HTMLElement>(".cm-image-preview");
    const initialLine = initialPreview?.closest<HTMLElement>(".cm-line");
    expect(initialPreview).not.toBeNull();
    expect(initialLine).not.toBeNull();
    if (initialPreview === null || initialLine === null) throw new Error("image line missing");
    Object.defineProperty(initialLine, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 240, 240),
    });
    initialPreview.querySelector("img")?.dispatchEvent(new Event("load"));
    await settle();

    const from = source.indexOf("![alt]");
    const to = source.indexOf("\n", from);
    view.dispatch({ selection: { anchor: from, head: to } });
    await settle();
    expect(view.dom.querySelector(".cm-image-source-height")).not.toBeNull();

    view.dispatch({ selection: { anchor: 0 } });
    await settle();
    const beforeRefresh = view.dom.querySelector<HTMLElement>(".cm-image-preview");
    expect(beforeRefresh).not.toBeNull();
    expect(view.dom.querySelector(".cm-image-source-height")).not.toBeNull();

    view.dispatch({ effects: refreshImages.of(null) });
    await settle();
    const refreshed = view.dom.querySelector<HTMLElement>(".cm-image-preview");
    expect(refreshed).not.toBeNull();
    expect(refreshed).not.toBe(beforeRefresh);
    expect(view.dom.querySelector(".cm-image-source-height")).not.toBeNull();

    refreshed?.querySelector("img")?.dispatchEvent(new Event("load"));
    await settle();
    expect(view.dom.querySelector(".cm-image-source-height")).toBeNull();
    expect(view.state.doc.toString()).toBe(source);
  });

  it("retains a measured source-height reservation until the replacement image settles", async () => {
    const source = "before\n![alt](first.png)\nafter";
    const { view } = createView(source);
    const initialPreview = view.dom.querySelector<HTMLElement>(".cm-image-preview");
    const initialLine = initialPreview?.closest<HTMLElement>(".cm-line");
    expect(initialPreview).not.toBeNull();
    expect(initialLine).not.toBeNull();
    if (initialPreview === null || initialLine === null) throw new Error("image line missing");
    Object.defineProperty(initialLine, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 240, 240),
    });
    initialPreview.querySelector("img")?.dispatchEvent(new Event("load"));
    await settle();

    const from = source.indexOf("![alt]");
    const to = source.indexOf("\n", from);
    view.dispatch({ selection: { anchor: from, head: to } });
    await settle();
    expect(view.dom.querySelector(".cm-image-source-height")).not.toBeNull();

    const target = source.indexOf("first.png");
    view.dispatch({
      changes: { from: target, to: target + "first.png".length, insert: "second.png" },
      selection: { anchor: 0 },
      userEvent: "input.type",
    });
    await settle();
    const replacement = view.dom.querySelector<HTMLElement>(".cm-image-preview");
    expect(view.dom.querySelector(".cm-image-source-height")).not.toBeNull();
    replacement?.querySelector("img")?.dispatchEvent(new Event("load"));
    await settle();
    expect(view.dom.querySelector(".cm-image-source-height")).toBeNull();
  });
  it("releases a source-height reservation after deletion and final image failure", async () => {
    const source = "before\n![alt](first.png)\nafter";
    const { view } = createView(source);
    const initialPreview = view.dom.querySelector<HTMLElement>(".cm-image-preview");
    const initialLine = initialPreview?.closest<HTMLElement>(".cm-line");
    expect(initialPreview).not.toBeNull();
    expect(initialLine).not.toBeNull();
    if (initialPreview === null || initialLine === null) throw new Error("image line missing");
    Object.defineProperty(initialLine, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 240, 240),
    });
    initialPreview.querySelector("img")?.dispatchEvent(new Event("load"));
    await settle();
    const from = source.indexOf("![alt]");
    const to = source.indexOf("\n", from);
    view.dispatch({ selection: { anchor: from, head: to } });
    await settle();
    expect(view.dom.querySelector(".cm-image-source-height")).not.toBeNull();

    const target = source.indexOf("first.png");
    view.dispatch({
      changes: { from: target, to: target + "first.png".length, insert: "second.png" },
      selection: { anchor: 0 },
      userEvent: "input.type",
    });
    await settle();
    const replacement = view.dom.querySelector<HTMLElement>(".cm-image-preview");
    expect(view.dom.querySelector(".cm-image-source-height")).not.toBeNull();
    replacement?.querySelector("img")?.dispatchEvent(new Event("error"));
    await settle();
    expect(replacement?.dataset["imageState"]).toBe("error");
    expect(view.dom.querySelector(".cm-image-source-height")).toBeNull();

    const current = view.state.doc.toString();
    const currentFrom = current.indexOf("![alt]");
    const currentTo = current.indexOf("\n", currentFrom);
    view.dispatch({
      changes: { from: currentFrom, to: currentTo },
      selection: { anchor: currentFrom },
      userEvent: "input.delete",
    });
    await settle();
    expect(view.dom.querySelector(".cm-image-source-height")).toBeNull();
    expect(view.dom.querySelector(".cm-image-preview")).toBeNull();
  });
  it("accepts an OS file clipboard image whose MIME type is unavailable, without consuming plain text paste", async () => {
    const { view, requested } = createView("before", 3);
    view.focus();
    const imagePaste = eventWithTransfer("paste", dataTransfer(imageFile("screenshot.PNG", "")));

    view.contentDOM.dispatchEvent(imagePaste);
    await settle();

    expect(imagePaste.defaultPrevented).toBe(true);
    expect(requested).toContain("image-import");
    expect(view.state.doc.toString()).toBe("bef![image](attachments/image.png)ore");

    const plainText = dataTransfer();
    plainText.setData("text/plain", "plain text");
    const plainPaste = eventWithTransfer("paste", plainText);
    view.contentDOM.dispatchEvent(plainPaste);

    // CodeMirror owns synthetic plain-text paste and may prevent its browser
    // default; the image handler must leave it out of the rich import path.
    expect(requested.filter((operation) => operation === "image-import")).toHaveLength(1);
    expect(view.state.doc.toString()).toBe("bef![image](attachments/image.png)plain textore");
  });

  it("inserts a dropped image at its resolved drop coordinate and cancels when no coordinate is available", async () => {
    const { view, notices, requested } = createView("abcdef", 0);
    Object.defineProperty(view, "posAtCoords", { configurable: true, value: (): number => 4 });
    const drop = eventWithTransfer("drop", dataTransfer(imageFile()));

    view.contentDOM.dispatchEvent(drop);
    await settle();

    expect(drop.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("abcd![image](attachments/image.png)ef");

    Object.defineProperty(view, "posAtCoords", { configurable: true, value: (): null => null });
    const noCoordinateDrop = eventWithTransfer("drop", dataTransfer(imageFile("second.png")));
    view.contentDOM.dispatchEvent(noCoordinateDrop);
    await settle();

    expect(requested.filter((operation) => operation === "image-import")).toHaveLength(1);
    expect(view.state.doc.toString()).toBe("abcd![image](attachments/image.png)ef");
    expect(notices).toContain("画像をドロップした位置を特定できなかったため挿入しませんでした。");
  });

  it("exposes source-range context on an image preview without mutating Markdown", () => {
    const source = "before\n![alt](assets/image.png)";
    const { view } = createView(source);
    const preview = view.dom.querySelector<HTMLElement>(".cm-image-preview");

    expect(preview?.dataset).toMatchObject({
      imageSource: "markdown",
      imageFrom: String(source.indexOf("![alt]")),
      imageTo: String(source.length),
      imageTarget: "assets/image.png",
    });
    expect(view.state.doc.toString()).toBe(source);
  });
});
