import { markdown } from "@codemirror/lang-markdown";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, closeHoverTooltips, hasHoverTooltips } from "@codemirror/view";
import { findMarkdownLinks, type MarkdownLink } from "../../core/markdown/markdownLinks.js";
import type { RichClient } from "../richClient.js";
import { createLivePreviewEngine } from "./LivePreviewEngine.js";

export interface LinkActions {
  readonly client: RichClient;
  readonly isEditable: () => boolean;
  readonly synchronize: () => Promise<boolean>;
  readonly notify: (note: string) => void;
}
export function linkPreview(actions: LinkActions): Extension {
  return [
    hoverTooltip(
      async (view, position) => {
        if (view.composing || view.compositionStarted) return null;
        const snapshot = view.state.doc;
        const link = findMarkdownLinks(snapshot.toString()).find(
          (candidate) => !candidate.image && candidate.from <= position && candidate.to >= position,
        );
        if (link === undefined) return null;
        const response = await actions.client.request("link-preview", { target: link.target });
        if (view.state.doc !== snapshot || response === undefined || !view.dom.isConnected)
          return null;
        return {
          pos: link.from,
          end: link.to,
          above: true,
          create() {
            const dom = document.createElement("div");
            dom.className = "cm-link-preview";
            const heading = document.createElement("div");
            heading.className = "cm-link-preview-title";
            heading.textContent = response.title ?? link.label;
            const hint = document.createElement("div");
            hint.className = "cm-link-preview-hint";
            hint.textContent = "Ctrl+クリックで開く · Escで閉じる";
            dom.append(heading, hint);
            if (!response.ok) {
              const error = document.createElement("p");
              error.textContent = response.note ?? "リンク先を確認できません。";
              dom.append(error);
              return { dom };
            }
            const preview = createLivePreviewEngine();
            const nested = new EditorView({
              parent: dom,
              state: EditorState.create({
                doc: response.text ?? "",
                extensions: [
                  markdown(),
                  preview.extension,
                  EditorState.readOnly.of(true),
                  EditorView.editable.of(false),
                ],
              }),
            });
            return {
              dom,
              destroy() {
                nested.destroy();
                preview.dispose();
              },
            };
          },
        };
      },
      { hoverTime: 450, hideOnChange: true },
    ),
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.key !== "Escape" || event.isComposing || !hasHoverTooltips(view.state))
          return false;
        view.dispatch({ effects: closeHoverTooltips });
        event.preventDefault();
        return true;
      },
      mousedown(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        const link = findMarkdownLinks(view.state.doc.toString()).find(
          (candidate) => !candidate.image && candidate.from <= position && candidate.to >= position,
        );
        if (link === undefined) return false;
        event.preventDefault();
        void openMarkdownLink(view, link, actions);
        return true;
      },
    }),
    EditorView.baseTheme({
      ".cm-link-preview": {
        width: "min(480px, 80vw)",
        maxHeight: "min(400px, 65vh)",
        overflow: "auto",
        color: "var(--vscode-editorHoverWidget-foreground)",
        background: "var(--vscode-editorHoverWidget-background)",
        border: "1px solid var(--vscode-editorHoverWidget-border)",
        font: "var(--vscode-font-size) var(--vscode-font-family)",
      },
      ".cm-link-preview-title": { fontWeight: "600", padding: "8px 10px 2px" },
      ".cm-link-preview-hint": {
        color: "var(--vscode-descriptionForeground)",
        fontSize: "11px",
        padding: "0 10px 4px",
      },
      ".cm-link-preview .cm-editor": { maxHeight: "320px" },
      ".cm-link-preview .cm-content": { padding: "8px 12px" },
    }),
  ];
}

export async function openMarkdownLink(
  view: EditorView,
  link: MarkdownLink,
  actions: LinkActions,
): Promise<void> {
  if (!actions.isEditable()) return;
  const snapshot = view.state.doc;
  if (!(await actions.synchronize()) || view.state.doc !== snapshot || !actions.isEditable())
    return;
  const response = await actions.client.request("link-open", { target: link.target });
  if (response?.ok !== true) {
    if (response?.note !== undefined) actions.notify(response.note);
    return;
  }
  if (response.offset !== undefined && view.state.doc === snapshot && actions.isEditable()) {
    const offset = Math.min(response.offset, view.state.doc.length);
    view.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
    view.focus();
  }
}
