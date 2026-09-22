import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  hoverTooltip,
  closeHoverTooltips,
  hasHoverTooltips,
  repositionTooltips,
  ViewPlugin,
} from "@codemirror/view";
import { findMarkdownLinks, type MarkdownLink } from "../../core/markdown/markdownLinks.js";
import type { RichClient } from "../richClient.js";
import type { RichResponse } from "../../protocol/richMessages.js";
import { createLivePreviewEngine } from "./LivePreviewEngine.js";
import { editorPreferences } from "../editorPreferences.js";

const TRANSIT_PX = 10;

/** Local presentation measurements. No target or preview content is included. */
export type LinkPreviewEvent =
  "hover" | "request" | "response" | "timer" | "parseStart" | "parseEnd" | "display";

export interface LinkActions {
  readonly client: RichClient;
  readonly isEditable: () => boolean;
  readonly synchronize: () => Promise<boolean>;
  readonly notify: (note: string) => void;
  readonly previewOptions?: () => Readonly<LinkPreviewOptions> | undefined;
  readonly onPreviewEvent?: (event: LinkPreviewEvent) => void;
}

export interface LinkPreviewOptions {
  readonly hoverDelayMs?: number;
  readonly maxWidthPx?: number;
  readonly maxHeightPx?: number;
}
export function linkPreview(actions: LinkActions): Extension {
  let cachedDocument: EditorState["doc"] | undefined;
  const cache = new Map<
    string,
    { readonly response: RichResponse; readonly targetVersion: string }
  >();
  return [
    ViewPlugin.define(() => ({
      update(update) {
        if (update.docChanged) {
          cache.clear();
          cachedDocument = update.state.doc;
        }
      },
      destroy() {
        cache.clear();
        cachedDocument = undefined;
      },
    })),
    hoverTooltip(
      async (view, position) => {
        if (view.composing || view.compositionStarted) return null;
        const snapshot = view.state.doc;
        const link = findMarkdownLinks(snapshot.toString()).find(
          (candidate) => !candidate.image && candidate.from <= position && candidate.to >= position,
        );
        if (link === undefined) return null;
        if (cachedDocument !== snapshot) {
          cachedDocument = snapshot;
          cache.clear();
        }
        actions.onPreviewEvent?.("hover");
        const cached = cache.get(link.target);
        actions.onPreviewEvent?.("request");
        const request = actions.client
          .request("link-preview", {
            target: link.target,
            ...(cached === undefined ? {} : { targetVersion: cached.targetVersion }),
          })
          .catch(() => undefined)
          .then((value) => {
            actions.onPreviewEvent?.("response");
            if (value?.unchanged === true) return cached?.response;
            if (
              value?.targetVersion !== undefined &&
              value.ok &&
              cachedDocument === snapshot &&
              view.dom.isConnected
            ) {
              cache.set(link.target, { response: value, targetVersion: value.targetVersion });
              if (cache.size > 32) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) cache.delete(oldest);
              }
            }
            return value;
          });
        const configured = actions.previewOptions?.();
        await new Promise<void>((resolve) =>
          window.setTimeout(
            resolve,
            Math.max(
              0,
              configured?.hoverDelayMs ?? view.state.facet(editorPreferences).linkHoverDelay,
            ),
          ),
        );
        actions.onPreviewEvent?.("timer");
        if (view.state.doc !== snapshot || !view.dom.isConnected) return null;
        const response = await Promise.race([
          request,
          new Promise<undefined>((resolve) => window.setTimeout(resolve, 0)),
        ]);
        // Resolve the first size before CM chooses a side. Its chosen side is
        // retained until it no longer fits, even when content later shrinks.
        const heightFor = (anchor: { top: number; bottom: number }): number => {
          const above = anchor.top - 14 - 8;
          const below = window.innerHeight - anchor.bottom - 14 - 8;
          return Math.max(
            0,
            Math.min(
              configured?.maxHeightPx ?? 400,
              window.innerHeight * 0.65,
              above >= 64 ? above : below,
            ),
          );
        };
        const initialAnchor = view.coordsAtPos(link.from);
        if (!initialAnchor) return null;
        const initialHeight = heightFor(initialAnchor);
        return {
          pos: link.from,
          end: link.to,
          above: true,
          create() {
            const dom = document.createElement("div");
            // This transparent box makes the pointer's 14px path to the card
            // part of CodeMirror's hover rectangle without covering the text.
            dom.className = "cm-link-preview-transit";
            dom.style.maxHeight = `${String(initialHeight + TRANSIT_PX * 2)}px`;
            const card = document.createElement("div");
            card.className = "cm-link-preview";
            if (configured?.maxWidthPx !== undefined)
              card.style.maxWidth = `${String(configured.maxWidthPx)}px`;
            card.style.maxHeight = `${String(initialHeight)}px`;
            const heading = document.createElement("div");
            heading.className = "cm-link-preview-title";
            heading.textContent = response?.title ?? link.label;
            const hint = document.createElement("div");
            hint.className = "cm-link-preview-hint";
            hint.textContent = "Ctrl+クリックで開く · Escで閉じる";
            card.append(heading, hint);
            dom.append(card);
            let destroyed = false;
            let tooltipOwner: HTMLElement | undefined;
            const fit = (): void => {
              if (destroyed) return;
              view.requestMeasure({
                key: dom,
                read() {
                  const anchor = view.coordsAtPos(link.from);
                  if (!anchor) return undefined;
                  return heightFor(anchor);
                },
                write(height) {
                  if (destroyed || height === undefined) return;
                  const value = `${String(height + TRANSIT_PX * 2)}px`;
                  if (dom.style.maxHeight !== value) {
                    dom.style.maxHeight = value;
                    card.style.maxHeight = `${String(height)}px`;
                    repositionTooltips(view);
                  }
                },
              });
            };
            const cleanupPlacement = (): void => {
              destroyed = true;
              tooltipOwner?.classList.remove("cm-link-preview-tooltip");
              view.scrollDOM.removeEventListener("scroll", fit);
              window.removeEventListener("resize", fit);
            };
            const placement = {
              // Padding bridges both above/below placements while this offset
              // preserves the card's visible 14px separation from its link.
              offset: { x: 0, y: 14 - TRANSIT_PX },
              mount() {
                tooltipOwner = dom.closest<HTMLElement>(".cm-tooltip") ?? undefined;
                tooltipOwner?.classList.add("cm-link-preview-tooltip");
                fit();
                view.scrollDOM.addEventListener("scroll", fit);
                window.addEventListener("resize", fit);
              },
              update: fit,
              destroy: cleanupPlacement,
            };
            const renderResponse = (value: Awaited<typeof request>): void => {
              if (destroyed || value === undefined || view.state.doc !== snapshot) return;
              card.querySelector(".cm-link-preview-body")?.remove();
              if (!value.ok) {
                const error = document.createElement("p");
                error.textContent = value.note ?? "リンク先を確認できません。";
                error.className = "cm-link-preview-body";
                card.append(error);
                repositionTooltips(view);
                return;
              }
              actions.onPreviewEvent?.("parseStart");
              const preview = createLivePreviewEngine();
              const nested = new EditorView({
                parent: card,
                state: EditorState.create({
                  doc: value.text ?? "",
                  extensions: [
                    markdown(),
                    preview.extension,
                    EditorState.readOnly.of(true),
                    EditorView.editable.of(false),
                  ],
                }),
              });
              nested.dom.classList.add("cm-link-preview-body");
              placement.destroy = () => {
                cleanupPlacement();
                nested.destroy();
                preview.dispose();
              };
              actions.onPreviewEvent?.("parseEnd");
              repositionTooltips(view);
            };
            if (response !== undefined) {
              renderResponse(response);
            } else {
              const loading = document.createElement("div");
              loading.className = "cm-link-preview-body cm-link-preview-loading";
              loading.setAttribute("role", "status");
              loading.textContent = "読み込み中…";
              card.append(loading);
              void request.then((value) => {
                renderResponse(value);
              });
            }
            actions.onPreviewEvent?.("display");
            return {
              dom,
              ...placement,
              // Keep the preview clear of an enlarged pointer while preserving
              // CodeMirror's viewport-aware side selection and resize behavior.
              destroy() {
                placement.destroy();
              },
            };
          },
        };
      },
      { hoverTime: 0, hideOnChange: true },
    ),
    Prec.highest(
      EditorView.domEventHandlers({
        keydown(event, view) {
          if (
            event.key !== "Escape" ||
            event.isComposing ||
            view.composing ||
            view.compositionStarted ||
            !hasHoverTooltips(view.state)
          )
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
            (candidate) =>
              !candidate.image && candidate.from <= position && candidate.to >= position,
          );
          if (link === undefined) return false;
          event.preventDefault();
          void openMarkdownLink(view, link, actions);
          return true;
        },
      }),
    ),
    EditorView.baseTheme({
      ".cm-link-preview-transit": {
        boxSizing: "border-box",
        padding: `${String(TRANSIT_PX)}px 0`,
        maxWidth: "calc(100vw - 16px)",
        pointerEvents: "auto",
      },
      // CodeMirror adds the generic tooltip border to the transit wrapper.
      // The card owns the themed preview border; keeping the wrapper border
      // would render an unbalanced double/white line around the preview.
      ".cm-tooltip.cm-link-preview-tooltip": { border: "0", backgroundColor: "transparent" },
      ".cm-link-preview": {
        boxSizing: "border-box",
        width: "fit-content",
        maxWidth: "min(560px, calc(100vw - 16px))",
        minWidth: "0",
        maxHeight: "min(400px, 65vh)",
        overflow: "auto",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        color: "var(--vscode-editorHoverWidget-foreground)",
        background: "var(--vscode-editorHoverWidget-background)",
        border: "1px solid var(--vscode-editorHoverWidget-border)",
        font: "var(--vscode-font-size) var(--vscode-font-family)",
      },
      ".cm-link-preview-title": {
        fontWeight: "600",
        padding: "8px 10px 2px",
        minWidth: "0",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      },
      ".cm-link-preview-hint": {
        color: "var(--vscode-descriptionForeground)",
        fontSize: "11px",
        padding: "0 10px 4px",
      },
      ".cm-link-preview .cm-editor": { maxHeight: "320px", minWidth: "0", maxWidth: "100%" },
      ".cm-link-preview .cm-content": {
        padding: "8px 12px",
        minWidth: "0",
        maxWidth: "100%",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      },
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
