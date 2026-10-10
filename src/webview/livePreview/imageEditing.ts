import {
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type StateEffect,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { findMarkdownLinks, type MarkdownLink } from "../../core/markdown/markdownLinks.js";
import { MAX_IMAGE_BYTES } from "../../protocol/richMessages.js";
import type { RichClient } from "../richClient.js";
import {
  cachedImageDimensions,
  imageHeightRefresh,
  imageHeightSettled,
  imageSourceHeight,
  setImageDimensions,
  type ImageDimensions,
} from "./imageSourceHeight.js";
import {
  searchReveal,
  searchPresentation,
  revealSearchMatch,
  setSearchPresentation,
} from "./searchReveal.js";

export interface ImageActions {
  readonly client: RichClient;
  readonly isEditable: () => boolean;
  readonly synchronize: () => Promise<boolean>;
  readonly notify: (note: string) => void;
  /** Count lifecycle events in diagnostics/tests; never includes source or bytes. */
  readonly onImageEvent?: (event: string) => void;
  readonly prepareImport?: (
    fields: { readonly name?: string; readonly data?: string },
    anchor: number,
    head: number,
  ) => boolean;
}

export const refreshImages = imageHeightRefresh;
const IMAGE_MAX_HEIGHT_VH = 60;
const imageRevision = StateField.define<number>({
  create: () => 0,
  update: (value, transaction) =>
    transaction.effects.some((effect) => effect.is(refreshImages)) ? value + 1 : value,
});

function supportsImageFile(file: File, declaredType = file.type): boolean {
  return declaredType.startsWith("image/") || /\.(?:png|jpe?g|gif|webp)$/iu.test(file.name);
}

function imageFile(transfer: DataTransfer | null): File | undefined {
  if (transfer === null) return undefined;
  const fromFiles = [...transfer.files].find((file) => supportsImageFile(file));
  if (fromFiles !== undefined) return fromFiles;
  for (const item of transfer.items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file !== null && supportsImageFile(file, item.type)) return file;
  }
  return undefined;
}

function hasImageTransfer(transfer: DataTransfer | null): boolean {
  return (
    imageFile(transfer) !== undefined ||
    [...(transfer?.items ?? [])].some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    )
  );
}

export function imageEditing(actions: ImageActions): Extension {
  const images = StateField.define<DecorationSet>({
    create: build,
    update(value, transaction) {
      if (transaction.isUserEvent("input.type.compose")) return value.map(transaction.changes);
      if (
        !transaction.docChanged &&
        transaction.selection === undefined &&
        !transaction.isUserEvent("input.structural.settle") &&
        !transaction.effects.some(
          (effect) =>
            effect.is(refreshImages) ||
            effect.is(revealSearchMatch) ||
            effect.is(setSearchPresentation),
        )
      )
        return value;
      return build(transaction.state);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  function build(state: EditorState): DecorationSet {
    const ranges: Range<Decoration>[] = [];
    for (const link of findMarkdownLinks(state.doc.toString())) {
      if (!link.image || state.doc.lineAt(link.from).number !== state.doc.lineAt(link.to).number)
        continue;
      const match = state.field(searchReveal, false);
      if (
        (match !== undefined && match.from < link.to && match.to > link.from) ||
        (!state.field(searchPresentation, false) &&
          state.selection.ranges.some((range) => range.from <= link.to && range.to >= link.from))
      )
        continue;
      ranges.push(
        Decoration.replace({
          widget: new ImageWidget(
            link,
            actions,
            state.field(imageRevision),
            cachedImageDimensions(state, link.from, link.target),
          ),
          inclusive: false,
        }).range(link.from, link.to),
      );
    }
    return Decoration.set(ranges, true);
  }
  return [
    imageSourceHeight,
    imageRevision,
    images,
    EditorView.domEventHandlers({
      paste(event, view) {
        const file = imageFile(event.clipboardData);
        if (file === undefined) return false;
        event.preventDefault();
        void insertImage(view, actions, file);
        return true;
      },
      drop(event, view) {
        const file = imageFile(event.dataTransfer);
        if (file === undefined) return false;
        event.preventDefault();
        if (!actions.isEditable()) return true;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) {
          actions.notify("画像をドロップした位置を特定できなかったため挿入しませんでした。");
          return true;
        }
        view.dispatch({ selection: { anchor: position } });
        view.focus();
        void insertImage(view, actions, file);
        return true;
      },
      dragover(event) {
        if (hasImageTransfer(event.dataTransfer)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    }),
    EditorView.baseTheme({
      ".cm-image-preview": {
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "flex-start",
        boxSizing: "border-box",
        maxWidth: "100%",
        verticalAlign: "middle",
        padding: "4px",
        border: "1px solid var(--vscode-editorWidget-border, transparent)",
      },
      ".cm-image-preview img": {
        maxWidth: "100%",
        maxHeight: `${String(IMAGE_MAX_HEIGHT_VH)}vh`,
        objectFit: "contain",
      },
      ".cm-image-preview span": {
        font: "12px var(--vscode-font-family)",
        color: "var(--vscode-descriptionForeground)",
        background: "transparent",
        border: "0",
      },
      ".cm-image-preview .cm-image-status-sr-only": {
        position: "absolute",
        width: "1px",
        height: "1px",
        padding: "0",
        margin: "-1px",
        overflow: "hidden",
        clip: "rect(0, 0, 0, 0)",
        whiteSpace: "nowrap",
        border: "0",
      },
    }),
  ];
}

interface ImageBinding {
  link: MarkdownLink;
  readonly client: RichClient;
  readonly revision: number;
  readonly update: (link: MarkdownLink, dimensions?: ImageDimensions) => void;
  dispose(): void;
}
// DOM lifetime only: no URL cache shared by documents, sessions or duplicate images.
const imageBindings = new WeakMap<HTMLElement, ImageBinding>();

function setImagePosition(container: HTMLElement, link: MarkdownLink): void {
  container.dataset["imageSource"] = "markdown";
  container.dataset["imageFrom"] = String(link.from);
  container.dataset["imageTo"] = String(link.to);
  container.dataset["imageTarget"] = link.target;
}

class ImageWidget extends WidgetType {
  public constructor(
    private readonly link: MarkdownLink,
    private readonly actions: ImageActions,
    private readonly revision: number,
    private readonly dimensions?: ImageDimensions,
  ) {
    super();
  }
  public override eq(other: ImageWidget): boolean {
    return (
      this.actions.client === other.actions.client &&
      this.revision === other.revision &&
      // Returning false for source metadata changes makes CodeMirror call
      // updateDOM. That method can then keep the element for same-revision
      // source edits while a resource revision still gets a fresh element.
      this.link.from === other.link.from &&
      this.link.to === other.link.to &&
      this.link.target === other.link.target &&
      this.link.label === other.link.label &&
      this.link.title === other.link.title
    );
  }
  public override updateDOM(container: HTMLElement): boolean {
    const binding = imageBindings.get(container);
    if (binding?.client !== this.actions.client || binding.revision !== this.revision) return false;
    binding.update(this.link, this.dimensions);
    setImagePosition(container, this.link);
    this.actions.onImageEvent?.("dom-reused");
    return true;
  }
  public override toDOM(view: EditorView): HTMLElement {
    this.actions.onImageEvent?.("dom-created");
    const container = document.createElement("span");
    container.className = "cm-image-preview";
    // U1's context menu identifies the source range; selecting the preview
    // itself never changes Markdown merely to expose that context.
    setImagePosition(container, this.link);
    const image = document.createElement("img");
    image.alt = this.link.label;
    image.title = this.link.title ?? this.link.label;
    setImageSize(image, this.dimensions);
    const status = document.createElement("span");
    status.textContent = "画像を読み込み中…";
    status.setAttribute("role", "status");
    if (this.dimensions !== undefined) status.classList.add("cm-image-status-sr-only");
    container.dataset["imageState"] = "loading";
    this.actions.onImageEvent?.("loading");
    let abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let imageLoadGeneration: number | undefined;
    let imageLoadTarget: string | undefined;
    const active = (token: number): boolean => token === generation && !abort.signal.aborted;
    const clearRequest = (): void => {
      abort.abort();
      clearTimeout(timer);
      timer = undefined;
    };
    const binding: ImageBinding = {
      link: this.link,
      client: this.actions.client,
      revision: this.revision,
      update: (link, dimensions) => {
        const targetChanged = binding.link.target !== link.target;
        binding.link = link;
        image.alt = link.label;
        image.title = link.title ?? link.label;
        if (targetChanged) {
          setImageSize(image, dimensions);
          status.classList.toggle("cm-image-status-sr-only", dimensions !== undefined);
          startResolve(link);
        } else if (dimensions !== undefined) setImageSize(image, dimensions);
      },
      dispose: () => {
        clearRequest();
        image.removeEventListener("mousedown", reveal);
        image.removeEventListener("load", loaded);
        image.removeEventListener("error", failed);
      },
    };
    imageBindings.set(container, binding);
    const reveal = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      if (view.composing || view.compositionStarted || abort.signal.aborted) return;
      // Removing the widget during a bubbling mousedown would make CM treat
      // the old target as ordinary content and collapse the new selection.
      view.dispatch({
        selection: { anchor: binding.link.from, head: binding.link.to },
        scrollIntoView: true,
      });
      queueMicrotask(() => {
        if (view.dom.isConnected) view.focus();
      });
    };
    image.addEventListener("mousedown", reveal);
    const loaded = (): void => {
      if (
        container.dataset["imageState"] !== "loading" ||
        imageLoadGeneration === undefined ||
        imageLoadTarget === undefined ||
        !active(imageLoadGeneration) ||
        binding.link.target !== imageLoadTarget
      )
        return;
      clearTimeout(timer);
      const dimensions = decodedImageDimensions(image);
      const effects: StateEffect<unknown>[] = [imageHeightSettled.of([binding.link.from])];
      if (dimensions !== undefined) {
        setImageSize(image, dimensions);
        effects.push(setImageDimensions(binding.link.from, imageLoadTarget, dimensions));
      }
      status.textContent = "";
      container.dataset["imageState"] = "loaded";
      this.actions.onImageEvent?.("load");
      view.dispatch({ effects });
      view.requestMeasure();
    };
    const fail = (note: string): void => {
      if (!active(generation)) return;
      clearTimeout(timer);
      setImageSize(image);
      status.classList.remove("cm-image-status-sr-only");
      status.textContent = note;
      container.dataset["imageState"] = "error";
      image.hidden = true;
      this.actions.onImageEvent?.("error");
      view.dispatch({
        effects: [
          imageHeightSettled.of([binding.link.from]),
          setImageDimensions(binding.link.from, binding.link.target),
        ],
      });
      view.requestMeasure();
    };
    const failed = (): void => {
      if (
        container.dataset["imageState"] !== "loading" ||
        imageLoadGeneration === undefined ||
        imageLoadTarget === undefined ||
        !active(imageLoadGeneration) ||
        binding.link.target !== imageLoadTarget
      )
        return;
      fail("画像を読み込めません。Markdownのパスを確認してください。");
    };
    image.addEventListener("load", loaded);
    image.addEventListener("error", failed);
    container.append(image, status);
    const startResolve = (link: MarkdownLink): void => {
      clearRequest();
      generation += 1;
      const token = generation;
      abort = new AbortController();
      const wasLoaded = container.dataset["imageState"] === "loaded";
      container.dataset["imageState"] = "loading";
      // Keep a previously loaded image in place while the replacement source
      // resolves. This is a presentation cache only; Markdown remains the
      // authority and a failed replacement still clears the old image.
      if (!wasLoaded) {
        image.hidden = false;
        status.textContent = "画像を読み込み中…";
      }
      this.actions.onImageEvent?.("loading");
      this.actions.onImageEvent?.("resolve-requested");
      void this.actions.client
        .request("image-resolve", { target: link.target }, abort.signal)
        .then((response) => {
          if (!active(token)) return;
          this.actions.onImageEvent?.("resolve-settled");
          if (response?.ok === true && response.url !== undefined) {
            timer = setTimeout(() => {
              if (!active(token)) return;
              fail(
                "画像の読み込みが時間内に完了しませんでした。Markdownのパスを確認してください。",
              );
            }, 15000);
            imageLoadGeneration = token;
            imageLoadTarget = link.target;
            image.src = response.url;
          } else
            fail(
              response?.note ?? "画像を解決できませんでした。Markdownのパスを確認してください。",
            );
        });
    };
    startResolve(this.link);
    return container;
  }
  public override destroy(container: HTMLElement): void {
    imageBindings.get(container)?.dispose();
    imageBindings.delete(container);
    this.actions.onImageEvent?.("dom-destroyed");
  }
  public override ignoreEvent(): boolean {
    return true;
  }
}

function decodedImageDimensions(image: HTMLImageElement): ImageDimensions | undefined {
  const { naturalWidth: width, naturalHeight: height } = image;
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0
    ? { width, height }
    : undefined;
}

function setImageSize(image: HTMLImageElement, dimensions?: ImageDimensions): void {
  if (dimensions !== undefined) {
    image.width = dimensions.width;
    image.height = dimensions.height;
    image.style.height = "auto";
    image.style.maxWidth = `min(100%, ${String((dimensions.width / dimensions.height) * IMAGE_MAX_HEIGHT_VH)}vh)`;
  } else {
    image.removeAttribute("width");
    image.removeAttribute("height");
    image.style.removeProperty("height");
    image.style.removeProperty("max-width");
  }
}

export async function insertImage(
  view: EditorView,
  actions: ImageActions,
  file?: File,
): Promise<void> {
  if (!actions.isEditable()) {
    actions.notify("入力確定・同期後に画像を挿入してください。");
    return;
  }
  if (file !== undefined && (file.size === 0 || file.size > MAX_IMAGE_BYTES)) {
    actions.notify("画像は8 MiB以下にしてください。");
    return;
  }
  const snapshot = view.state.doc;
  const selection = view.state.selection.main;
  const connected = (): boolean => view.dom.isConnected;
  const focus = imageFocusLease(view);
  try {
    if (!(await actions.synchronize())) return;
    const data = file === undefined ? undefined : await fileBase64(file);
    if (
      view.state.doc !== snapshot ||
      !view.state.selection.main.eq(selection) ||
      !actions.isEditable() ||
      !connected()
    ) {
      actions.notify("文書または選択位置が変わったため画像挿入を取り消しました。");
      return;
    }
    if (
      actions.prepareImport?.(
        file === undefined ? {} : { name: file.name, ...(data === undefined ? {} : { data }) },
        selection.anchor,
        selection.head,
      ) === true
    )
      return;
    const response = await actions.client.request(
      file === undefined ? "image-pick" : "image-import",
      file === undefined ? {} : { name: file.name, ...(data === undefined ? {} : { data }) },
    );
    if (response?.ok !== true) {
      if (response?.note !== undefined) actions.notify(response.note);
      return;
    }
    if (response.markdown === undefined) return;
    if (
      view.state.doc !== snapshot ||
      !view.state.selection.main.eq(selection) ||
      !actions.isEditable() ||
      !connected()
    ) {
      actions.notify(
        "文書または選択位置が変わったため挿入を取り消しました。取り込んだ添付ファイルは保持しています。",
      );
      return;
    }
    const insertion = imageInsertion(
      snapshot.toString(),
      selection.from,
      selection.to,
      response.markdown,
    );
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: insertion.text },
      ...(focus.current() ? { selection: { anchor: insertion.caret } } : {}),
      userEvent: "input.image",
      scrollIntoView: focus.current(),
    });
    // Reconcile native selection after the input event/DOM update, only while the
    // original user focus intent is still current. Never wait for image load.
    await Promise.resolve();
    if (focus.current() && view.state.selection.main.head === insertion.caret) view.focus();
    actions.notify("画像を挿入しました。Undoでは添付ファイルを削除しません。");
  } catch {
    actions.notify("画像の取り込みに失敗しました。画像データまたは対応形式を確認してください。");
  } finally {
    focus.dispose();
  }
}

/** A standalone image leaves a real text line; existing blank lines are reused. */
export function imageInsertion(
  source: string,
  from: number,
  to: number,
  markdown: string,
): { text: string; caret: number } {
  const start = source.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const end = source.indexOf("\n", to);
  const lineEnd = end < 0 ? source.length : end;
  const standalone =
    source.slice(start, from).trim() === "" && source.slice(to, lineEnd).trim() === "";
  if (!standalone) return { text: markdown, caret: from + markdown.length };
  const following = end < 0 ? undefined : source.indexOf("\n", end + 1);
  const nextLine =
    end < 0 ? undefined : source.slice(end + 1, following === -1 ? source.length : following);
  if (nextLine?.trim() === "")
    return { text: markdown, caret: from + markdown.length + (lineEnd - to) + 1 };
  return { text: markdown + "\n", caret: from + markdown.length + 1 };
}

function imageFocusLease(view: EditorView): { current(): boolean; dispose(): void } {
  let retained = view.hasFocus;
  const moved = (event: Event): void => {
    if (event.target instanceof Node && !view.contentDOM.contains(event.target)) retained = false;
  };
  const left = (): void => {
    retained = false;
  };
  const hidden = (): void => {
    if (document.visibilityState === "hidden") left();
  };
  document.addEventListener("pointerdown", moved, true);
  document.addEventListener("focusin", moved, true);
  window.addEventListener("blur", left);
  document.addEventListener("visibilitychange", hidden);
  return {
    current: () =>
      retained && view.hasFocus && view.dom.isConnected && document.visibilityState !== "hidden",
    dispose: () => {
      document.removeEventListener("pointerdown", moved, true);
      document.removeEventListener("focusin", moved, true);
      window.removeEventListener("blur", left);
      document.removeEventListener("visibilitychange", hidden);
    },
  };
}
function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string")
        resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      else reject(new Error("invalid image"));
    });
    reader.addEventListener("error", () => {
      reject(new Error("image read failed"));
    });
    reader.readAsDataURL(file);
  });
}
