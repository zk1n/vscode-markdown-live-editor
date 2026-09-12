// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { RichClient } from "../../src/webview/richClient.js";
import { imageEditing, type ImageActions } from "../../src/webview/livePreview/imageEditing.js";

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
): {
  readonly view: EditorView;
  readonly notices: string[];
  readonly requested: string[];
} {
  const notices: string[] = [];
  const requested: string[] = [];
  const client = new RichClient((request): void => {
    requested.push(request.operation);
    queueMicrotask(() => {
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
          : {}),
      });
    });
  });
  const actions: ImageActions = {
    client,
    isEditable: (): boolean => true,
    synchronize: (): Promise<boolean> => Promise.resolve(true),
    notify: (note): void => {
      notices.push(note);
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
  return { view, notices, requested };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
}

describe("image paste and drop", () => {
  it("accepts an OS file clipboard image whose MIME type is unavailable, without consuming plain text paste", async () => {
    const { view, requested } = createView("before", 3);
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
