import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

import { findMarkdownLinks } from "../core/markdown/markdownLinks.js";
import { findTables, tableCellAt } from "../core/markdown/tableSource.js";
import type { RichCommand, RichIdentity } from "../protocol/richMessages.js";
import { editTable, type TableAction } from "./livePreview/tableEditing.js";

export interface ContextActionIdentity extends RichIdentity {
  readonly documentVersion: number;
}

export interface ContextActionsOptions {
  /** Captured at each menu invocation so document versions cannot go stale. */
  readonly identity: () => ContextActionIdentity;
  readonly isEditable: () => boolean;
  readonly isReady?: () => boolean;
}

interface TableTarget {
  readonly kind: "table";
  readonly source: string;
  readonly from: number;
  readonly to: number;
  readonly position: number;
  readonly row: number;
  readonly column: number;
  readonly canDeleteRow: boolean;
  readonly canDeleteColumn: boolean;
}

interface ImageTarget {
  readonly kind: "image";
  readonly source: string;
  readonly from: number;
  readonly to: number;
  readonly target: string;
}

type ContextTarget = TableTarget | ImageTarget;

interface CapturedContext {
  readonly token: string;
  readonly identity: ContextActionIdentity;
  readonly target: ContextTarget;
}

export interface ContextActions {
  readonly extension: Extension;
  /** Commands without a token use the current caret for Command Palette access. */
  run(command: RichCommand, contextToken?: string, documentVersion?: number): boolean;
}

const tableCommands: Readonly<Partial<Record<RichCommand, TableAction>>> = {
  "table-row-add": "row-add",
  "table-row-delete": "row-delete",
  "table-column-add": "column-add",
  "table-column-delete": "column-delete",
  "table-align-left": "align-left",
  "table-align-center": "align-center",
  "table-align-right": "align-right",
  "table-source": "source",
};

function integer(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function elementFromTarget(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined;
  const element = target.closest<HTMLElement>("[data-table-cell], .cm-image-preview");
  return element ?? undefined;
}

function tableTarget(source: string, position: number): TableTarget | undefined {
  for (const table of findTables(source)) {
    const address = tableCellAt(table, position);
    if (address === undefined) continue;
    return {
      kind: "table",
      source,
      from: table.from,
      to: table.to,
      position: address.cell.contentFrom,
      row: address.row,
      column: address.column,
      canDeleteRow: address.row > 0,
      canDeleteColumn: table.columns > 1,
    };
  }
  return undefined;
}

function imageTarget(
  source: string,
  from: number,
  to: number,
  target: string,
): ImageTarget | undefined {
  const image = findMarkdownLinks(source).find(
    (link) => link.image && link.from === from && link.to === to && link.target === target,
  );
  return image === undefined ? undefined : { kind: "image", source, from, to, target };
}

function targetFromElement(
  source: string,
  element: HTMLElement | undefined,
): ContextTarget | undefined {
  if (element === undefined) return undefined;
  const cell = integer(element.dataset["tableCell"]);
  if (cell !== undefined) return tableTarget(source, cell);
  const from = integer(element.dataset["imageFrom"]);
  const to = integer(element.dataset["imageTo"]);
  const target = element.dataset["imageTarget"];
  if (from === undefined || to === undefined || target === undefined) return undefined;
  return imageTarget(source, from, to, target);
}

function targetAtCaret(view: EditorView): ContextTarget | undefined {
  const source = view.state.doc.toString();
  const position = view.state.selection.main.head;
  return (
    tableTarget(source, position) ??
    findMarkdownLinks(source)
      .filter((link) => link.image && link.from <= position && position <= link.to)
      .map((link) => imageTarget(source, link.from, link.to, link.target))
      .find((target): target is ImageTarget => target !== undefined)
  );
}

function sameIdentity(left: ContextActionIdentity, right: ContextActionIdentity): boolean {
  return (
    left.documentUri === right.documentUri &&
    left.sessionId === right.sessionId &&
    left.controllerId === right.controllerId &&
    left.documentVersion === right.documentVersion
  );
}

function validTarget(view: EditorView, target: ContextTarget): ContextTarget | undefined {
  const source = view.state.doc.toString();
  if (source !== target.source) return undefined;
  if (target.kind === "table") {
    const current = tableTarget(source, target.position);
    return current?.from === target.from &&
      current.to === target.to &&
      current.row === target.row &&
      current.column === target.column
      ? current
      : undefined;
  }
  return imageTarget(source, target.from, target.to, target.target);
}

function nativeContext(
  identity: ContextActionIdentity,
  token: string,
  target: ContextTarget,
  editable: boolean,
): string {
  return JSON.stringify({
    webviewSection: target.kind === "table" ? "markdown-table" : "markdown-image",
    markdownContextToken: token,
    markdownDocumentUri: identity.documentUri,
    markdownSessionId: identity.sessionId,
    markdownControllerId: identity.controllerId,
    markdownDocumentVersion: identity.documentVersion,
    markdownContextEditable: editable,
    ...(target.kind === "table"
      ? {
          markdownCanDeleteRow: target.canDeleteRow,
          markdownCanDeleteColumn: target.canDeleteColumn,
        }
      : {}),
  });
}

class ContextActionPlugin {
  private nextToken = 0;
  private captured: CapturedContext | undefined;
  private contextElement: HTMLElement | undefined;
  private keyboardMenu = false;
  private readonly onContextMenu = (event: MouseEvent): void => {
    this.contextElement?.removeAttribute("data-vscode-context");
    this.contextElement = undefined;
    this.captured = undefined;
    const element = elementFromTarget(event.target);
    // Keyboard context menus have no pointer coordinates. Pointer menus use
    // only their actual DOM target so a caret in another table cannot hijack
    // ordinary Copy/Cut/Paste on surrounding prose.
    const target =
      targetFromElement(this.view.state.doc.toString(), element) ??
      (this.keyboardMenu || (event.clientX === 0 && event.clientY === 0)
        ? targetAtCaret(this.view)
        : undefined);
    if (target === undefined) return;
    const identity = this.options.identity();
    const token = `context-${String(++this.nextToken)}`;
    this.captured = { token, identity, target };
    this.contextElement = element ?? this.view.contentDOM;
    this.contextElement.dataset["vscodeContext"] = nativeContext(
      identity,
      token,
      target,
      this.options.isEditable(),
    );
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if ((event.key !== "F10" || !event.shiftKey) && event.key !== "ContextMenu") return;
    if (this.view.composing || this.view.compositionStarted) return;
    event.preventDefault();
    event.stopPropagation();
    // VS Code documents synthetic contextmenu as the public native-menu entry.
    const coordinates = this.view.coordsAtPos(this.view.state.selection.main.head);
    this.keyboardMenu = true;
    try {
      this.view.contentDOM.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: coordinates?.left ?? 0,
          clientY: coordinates?.bottom ?? 0,
        }),
      );
    } finally {
      this.keyboardMenu = false;
    }
  };

  public constructor(
    private readonly view: EditorView,
    private readonly options: ContextActionsOptions,
  ) {
    this.view.dom.addEventListener("contextmenu", this.onContextMenu, true);
    this.view.dom.addEventListener("keydown", this.onKeyDown, true);
  }

  public update(update: ViewUpdate): void {
    if (update.docChanged) this.captured = undefined;
  }

  public destroy(): void {
    this.view.dom.removeEventListener("contextmenu", this.onContextMenu, true);
    this.view.dom.removeEventListener("keydown", this.onKeyDown, true);
    this.contextElement?.removeAttribute("data-vscode-context");
    this.captured = undefined;
  }

  public run(command: RichCommand, token?: string, version?: number): boolean {
    const fromToken = token === undefined ? undefined : this.captured;
    if (
      token !== undefined &&
      (fromToken?.token !== token ||
        version !== fromToken.identity.documentVersion ||
        !sameIdentity(fromToken.identity, this.options.identity()))
    )
      return false;
    const candidate = fromToken?.target ?? targetAtCaret(this.view);
    if (candidate === undefined) return false;
    const target = validTarget(this.view, candidate);
    const sourceOnly = command === "table-source" || command === "image-source";
    if (
      target === undefined ||
      !(sourceOnly
        ? (this.options.isReady?.() ?? this.options.isEditable())
        : this.options.isEditable())
    )
      return false;
    const tableAction = tableCommands[command];
    if (tableAction !== undefined && target.kind === "table")
      return editTable(this.view, tableAction, target.position);
    if (command === "image-source" && target.kind === "image") {
      this.view.dispatch({
        selection: { anchor: target.from, head: target.to },
        scrollIntoView: true,
      });
      this.view.focus();
      return true;
    }
    return false;
  }
}

export function createContextActions(options: ContextActionsOptions): ContextActions {
  let plugin: ContextActionPlugin | undefined;
  return {
    extension: ViewPlugin.define((view) => {
      const current = new ContextActionPlugin(view, options);
      plugin = current;
      return current;
    }),
    run(command, token, documentVersion): boolean {
      return plugin?.run(command, token, documentVersion) ?? false;
    },
  };
}
