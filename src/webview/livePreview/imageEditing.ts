import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { findMarkdownLinks, type MarkdownLink } from "../../core/markdown/markdownLinks.js";
import { MAX_IMAGE_BYTES } from "../../protocol/richMessages.js";
import type { RichClient } from "../richClient.js";

export interface ImageActions {
  readonly client: RichClient;
  readonly isEditable: () => boolean;
  readonly synchronize: () => Promise<boolean>;
  readonly notify: (note: string) => void;
}

export function imageEditing(actions: ImageActions): Extension {
  const images = StateField.define<DecorationSet>({
    create: build,
    update(value, transaction) {
      if (transaction.isUserEvent("input.type.compose")) return value.map(transaction.changes);
      if (!transaction.docChanged && transaction.selection === undefined) return value;
      return build(transaction.state);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  function build(state: EditorState): DecorationSet {
    const ranges: Range<Decoration>[] = [];
    for (const link of findMarkdownLinks(state.doc.toString())) {
      if (!link.image || state.doc.lineAt(link.from).number !== state.doc.lineAt(link.to).number)
        continue;
      if (state.selection.ranges.some((range) => range.from <= link.to && range.to >= link.from))
        continue;
      ranges.push(
        Decoration.replace({
          widget: new ImageWidget(link, actions.client),
          inclusive: false,
        }).range(link.from, link.to),
      );
    }
    return Decoration.set(ranges, true);
  }
  return [
    images,
    EditorView.domEventHandlers({
      paste(event, view) {
        const file = [...(event.clipboardData?.files ?? [])].find((candidate) =>
          candidate.type.startsWith("image/"),
        );
        if (file === undefined) return false;
        event.preventDefault();
        void insertImage(view, actions, file);
        return true;
      },
      drop(event, view) {
        const file = [...(event.dataTransfer?.files ?? [])].find((candidate) =>
          candidate.type.startsWith("image/"),
        );
        if (file === undefined) return false;
        event.preventDefault();
        if (!actions.isEditable()) return true;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position !== null) view.dispatch({ selection: { anchor: position } });
        void insertImage(view, actions, file);
        return true;
      },
      dragover(event) {
        if (
          [...(event.dataTransfer?.items ?? [])].some(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          )
        ) {
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
        maxWidth: "100%",
        verticalAlign: "middle",
        padding: "4px",
        border: "1px solid var(--vscode-editorWidget-border, transparent)",
      },
      ".cm-image-preview img": { maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" },
      ".cm-image-preview button, .cm-image-preview span": {
        font: "12px var(--vscode-font-family)",
        color: "var(--vscode-descriptionForeground)",
        background: "transparent",
        border: "0",
      },
      ".cm-image-preview button": { cursor: "pointer", textDecoration: "underline" },
    }),
  ];
}

class ImageWidget extends WidgetType {
  public constructor(
    private readonly link: MarkdownLink,
    private readonly client: RichClient,
  ) {
    super();
  }
  public override eq(other: ImageWidget): boolean {
    return (
      this.link.from === other.link.from &&
      this.link.to === other.link.to &&
      this.link.target === other.link.target &&
      this.link.label === other.link.label &&
      this.link.title === other.link.title
    );
  }
  public override toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("span");
    container.className = "cm-image-preview";
    const image = document.createElement("img");
    image.alt = this.link.label;
    image.title = this.link.title ?? this.link.label;
    const status = document.createElement("span");
    status.textContent = "画像を読み込み中…";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "画像のMarkdownを編集";
    const reveal = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      if (view.composing || view.compositionStarted) return;
      // Removing the widget during a bubbling mousedown would make CM treat
      // the old target as ordinary content and collapse the new selection.
      view.dispatch({
        selection: { anchor: this.link.from, head: this.link.to },
        scrollIntoView: true,
      });
      queueMicrotask(() => {
        if (view.dom.isConnected) view.focus();
      });
    };
    edit.addEventListener("mousedown", reveal);
    image.addEventListener("mousedown", reveal);
    edit.addEventListener("click", reveal);
    image.addEventListener("load", () => {
      status.textContent = "";
      view.requestMeasure();
    });
    image.addEventListener("error", () => {
      status.textContent = "画像を読み込めません。Markdownのパスを確認してください。";
      image.hidden = true;
      view.requestMeasure();
    });
    container.append(image, status, edit);
    void this.client.request("image-resolve", { target: this.link.target }).then((response) => {
      if (!container.isConnected) return;
      if (response?.ok === true && response.url !== undefined) image.src = response.url;
      else {
        image.hidden = true;
        status.textContent = response?.note ?? "画像を読み込めません。";
      }
      view.requestMeasure();
    });
    return container;
  }
  public override ignoreEvent(): boolean {
    return true;
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
  try {
    if (!(await actions.synchronize())) return;
    const data = file === undefined ? undefined : await fileBase64(file);
    if (
      view.state.doc !== snapshot ||
      !view.state.selection.main.eq(selection) ||
      !actions.isEditable()
    ) {
      actions.notify("文書または選択位置が変わったため画像挿入を取り消しました。");
      return;
    }
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
      !actions.isEditable()
    ) {
      actions.notify(
        "文書または選択位置が変わったため挿入を取り消しました。取り込んだ添付ファイルは保持しています。",
      );
      return;
    }
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: response.markdown },
      selection: { anchor: selection.from + response.markdown.length },
      userEvent: "input.image",
      scrollIntoView: true,
    });
    view.focus();
    actions.notify("画像を挿入しました。Undoでは添付ファイルを削除しません。");
  } catch {
    actions.notify("画像の取り込みに失敗しました。ファイル選択から再度試してください。");
  }
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
