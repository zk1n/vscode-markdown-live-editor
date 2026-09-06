import * as vscode from "vscode";

import { vscodeLocalizer, type Localizer } from "../localization.js";

import type {
  ActiveStatusSession,
  MarkdownEditorSessionRegistry,
  MarkdownEditorStateReport,
} from "../editor/MarkdownEditorSessionRegistry.js";

export type StatusBarEol = "lf" | "crlf";

/**
 * Identifies a particular live Webview generation, rather than merely a URI.
 * This keeps same-URI split editors and recreated controllers separate.
 */
export interface ActiveStatusSessionIdentity {
  readonly documentUri: string;
  readonly sessionId: string;
  readonly controllerId: string;
}

export interface StatusActionContext {
  readonly identity: ActiveStatusSessionIdentity;
  readonly documentVersion: number;
  readonly editorState: MarkdownEditorStateReport;
}

/** A presentation read from VS Code's authoritative open TextDocument/configuration. */
export interface StatusDocumentPresentation {
  /** Authoritative open TextDocument version used to reject stale Webview reports. */
  readonly documentVersion: number;
  readonly eol: StatusBarEol;
  /** The effective `files.encoding` setting, never a guess made from document bytes. */
  readonly encoding: string;
}

export interface StatusDocumentPresentationReader {
  read(identity: ActiveStatusSessionIdentity): StatusDocumentPresentation | undefined;
}

export interface StatusActionCallbacks {
  chooseNavigation?(context: StatusActionContext): Promise<StatusNavigation | undefined>;
  requestNavigation?(context: StatusActionContext, target: StatusNavigation): Promise<void> | void;
  chooseEol?(
    context: StatusActionContext,
    current: StatusBarEol,
  ): Promise<StatusBarEol | undefined>;
  requestEolChange?(context: StatusActionContext, target: StatusBarEol): Promise<void> | void;
  chooseIndentation?(context: StatusActionContext): Promise<StatusIndentation | undefined>;
  requestIndentationChange?(
    context: StatusActionContext,
    target: StatusIndentation,
  ): Promise<void> | void;
}

export interface StatusIndentation {
  readonly insertSpaces: boolean;
  readonly tabSize: number;
}

export interface StatusNavigation {
  readonly line: number;
  readonly column: number;
}

export interface StatusBarItemLike extends vscode.Disposable {
  text: string;
  tooltip: string | vscode.MarkdownString | undefined;
  command: string | vscode.Command | undefined;
  show(): void;
  hide(): void;
}

export interface StatusBarItemFactory {
  create(id: string, priority: number): StatusBarItemLike;
}

export interface StatusCommandRegistry {
  register(command: string, callback: () => Promise<void>): vscode.Disposable;
}

const COMMAND_EOL = "vscodeMarkdownLiveEditor.status.changeEol";
const COMMAND_INDENTATION = "vscodeMarkdownLiveEditor.status.changeIndentation";
const COMMAND_LINE_COLUMN = "vscodeMarkdownLiveEditor.status.navigate";

/**
 * Owns the five Custom Editor status items. It contains no document mutation:
 * EOL and indentation requests are callback seams owned by extension wiring.
 */
export class MarkdownEditorStatusBarManager implements vscode.Disposable {
  private readonly lineColumn: StatusBarItemLike;
  private readonly indentation: StatusBarItemLike;
  private readonly encoding: StatusBarItemLike;
  private readonly eol: StatusBarItemLike;
  private readonly language: StatusBarItemLike;
  private readonly subscriptions: readonly vscode.Disposable[];

  public constructor(
    private readonly sessions: MarkdownEditorSessionRegistry,
    private readonly presentation: StatusDocumentPresentationReader,
    private readonly actions: StatusActionCallbacks,
    items: StatusBarItemFactory = new VscodeStatusBarItemFactory(),
    commands: StatusCommandRegistry = new VscodeStatusCommandRegistry(),
    private readonly localizer: Localizer = vscodeLocalizer,
  ) {
    this.lineColumn = items.create("vscodeMarkdownLiveEditor.status.lineColumn", 105);
    this.indentation = items.create("vscodeMarkdownLiveEditor.status.indentation", 104);
    this.encoding = items.create("vscodeMarkdownLiveEditor.status.encoding", 103);
    this.eol = items.create("vscodeMarkdownLiveEditor.status.eol", 102);
    this.language = items.create("vscodeMarkdownLiveEditor.status.language", 101);
    this.subscriptions = [
      this.sessions.onDidChange((): void => {
        this.refresh();
      }),
      commands.register(COMMAND_EOL, async (): Promise<void> => this.changeEol()),
      commands.register(COMMAND_INDENTATION, async (): Promise<void> => this.changeIndentation()),
      commands.register(COMMAND_LINE_COLUMN, async (): Promise<void> => this.navigate()),
    ];
    this.refresh();
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.lineColumn.dispose();
    this.indentation.dispose();
    this.encoding.dispose();
    this.eol.dispose();
    this.language.dispose();
  }

  /** Renders only the currently active, controller-bound Custom Editor session. */
  public refresh(): void {
    const active = this.sessions.activeStatusSession;
    if (active === undefined) {
      this.hideAll();
      return;
    }
    const identity = toIdentity(active);
    const state = active.editorState;
    const documentPresentation = this.presentation.read(identity);
    if (documentPresentation?.documentVersion !== state.documentVersion) {
      // A panel can outlive a closed/replaced TextDocument briefly. Do not show
      // stale document chrome during that lifecycle window.
      this.hideAll();
      return;
    }

    this.lineColumn.text = formatLineColumn(state, this.localizer);
    this.lineColumn.tooltip = this.localizer.t("Markdown Live Editor cursor position");
    this.lineColumn.command =
      this.canRequestActions(state) &&
      this.actions.chooseNavigation !== undefined &&
      this.actions.requestNavigation !== undefined
        ? COMMAND_LINE_COLUMN
        : undefined;

    this.indentation.text = formatIndentation(state, this.localizer);
    this.indentation.tooltip = this.localizer.t("Change Markdown Live Editor indentation settings");
    this.indentation.command =
      this.canRequestActions(state) &&
      this.actions.chooseIndentation !== undefined &&
      this.actions.requestIndentationChange !== undefined
        ? COMMAND_INDENTATION
        : undefined;

    this.encoding.text = formatEncoding(documentPresentation.encoding);
    this.encoding.tooltip = this.localizer.t(
      "Effective files.encoding setting. Encoding is not inferred from document bytes and cannot be changed here.",
    );
    this.encoding.command = undefined;

    this.eol.text = documentPresentation.eol === "crlf" ? "CRLF" : "LF";
    this.eol.tooltip = this.localizer.t(
      "Change line ending through the Markdown Live Editor document-action boundary",
    );
    this.eol.command =
      this.canRequestActions(state) &&
      this.actions.chooseEol !== undefined &&
      this.actions.requestEolChange !== undefined
        ? COMMAND_EOL
        : undefined;

    this.language.text = "Markdown";
    this.language.tooltip = this.localizer.t("Markdown Live Editor");
    this.language.command = undefined;
    this.showAll();
  }

  /**
   * Exposed to callback wiring that must revalidate after its own await. The
   * report sequence may advance on blur, so identity and document version—not
   * a frozen caret report—are the mutation admission boundary.
   */
  public isCurrent(context: StatusActionContext): boolean {
    const active = this.sessions.activeStatusSession;
    if (active === undefined) {
      return false;
    }
    return (
      active.handle.documentUri === context.identity.documentUri &&
      active.handle.sessionId === context.identity.sessionId &&
      active.controllerId === context.identity.controllerId &&
      active.editorState.documentVersion === context.documentVersion &&
      this.presentation.read(context.identity)?.documentVersion === context.documentVersion
    );
  }

  private async changeEol(): Promise<void> {
    const context = this.currentActionContext();
    if (
      context === undefined ||
      this.actions.chooseEol === undefined ||
      this.actions.requestEolChange === undefined
    ) {
      return;
    }
    const current = this.presentation.read(context.identity)?.eol;
    if (current === undefined) {
      return;
    }
    const target = await this.actions.chooseEol(context, current);
    if (target === undefined || !this.isCurrent(context)) {
      return;
    }
    await this.actions.requestEolChange(context, target);
  }

  private async navigate(): Promise<void> {
    const context = this.currentActionContext();
    if (
      context === undefined ||
      this.actions.chooseNavigation === undefined ||
      this.actions.requestNavigation === undefined
    ) {
      return;
    }
    const target = await this.actions.chooseNavigation(context);
    if (target === undefined || !isValidNavigation(target) || !this.isCurrent(context)) {
      return;
    }
    await this.actions.requestNavigation(context, target);
  }

  private async changeIndentation(): Promise<void> {
    const context = this.currentActionContext();
    if (
      context === undefined ||
      this.actions.chooseIndentation === undefined ||
      this.actions.requestIndentationChange === undefined
    ) {
      return;
    }
    const target = await this.actions.chooseIndentation(context);
    if (target === undefined || !isValidIndentation(target) || !this.isCurrent(context)) {
      return;
    }
    await this.actions.requestIndentationChange(context, target);
  }

  private currentActionContext(): StatusActionContext | undefined {
    const active = this.sessions.activeStatusSession;
    if (active === undefined || !this.canRequestActions(active.editorState)) {
      return undefined;
    }
    return {
      identity: toIdentity(active),
      documentVersion: active.editorState.documentVersion,
      editorState: active.editorState,
    };
  }

  private canRequestActions(state: MarkdownEditorStateReport): boolean {
    return !state.recoveryActive && !state.composing && !state.barrierActive;
  }

  private showAll(): void {
    this.lineColumn.show();
    this.indentation.show();
    this.encoding.show();
    this.eol.show();
    this.language.show();
  }

  private hideAll(): void {
    this.lineColumn.hide();
    this.indentation.hide();
    this.encoding.hide();
    this.eol.hide();
    this.language.hide();
  }
}

/** Reads public document/configuration state only; it never inspects raw bytes. */
export class VscodeStatusDocumentPresentationReader implements StatusDocumentPresentationReader {
  public constructor(private readonly viewType = "vscodeMarkdownLiveEditor.editor") {}

  public read(identity: ActiveStatusSessionIdentity): StatusDocumentPresentation | undefined {
    const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (
      !(activeInput instanceof vscode.TabInputCustom) ||
      activeInput.viewType !== this.viewType ||
      activeInput.uri.toString() !== identity.documentUri
    ) {
      return undefined;
    }
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === identity.documentUri && !candidate.isClosed,
    );
    if (document === undefined) {
      return undefined;
    }
    const configuredEncoding = vscode.workspace
      .getConfiguration("files", { uri: document.uri, languageId: document.languageId })
      .get<unknown>("encoding");
    return {
      documentVersion: document.version,
      eol: document.eol === vscode.EndOfLine.CRLF ? "crlf" : "lf",
      encoding:
        typeof configuredEncoding === "string" && configuredEncoding.length > 0
          ? configuredEncoding
          : "utf8",
    };
  }
}

export class VscodeStatusBarItemFactory implements StatusBarItemFactory {
  public create(id: string, priority: number): StatusBarItemLike {
    return vscode.window.createStatusBarItem(id, vscode.StatusBarAlignment.Right, priority);
  }
}

export class VscodeStatusCommandRegistry implements StatusCommandRegistry {
  public register(command: string, callback: () => Promise<void>): vscode.Disposable {
    return vscode.commands.registerCommand(command, callback);
  }
}

function toIdentity(active: ActiveStatusSession): ActiveStatusSessionIdentity {
  return {
    documentUri: active.handle.documentUri,
    sessionId: active.handle.sessionId,
    controllerId: active.controllerId,
  };
}

function formatLineColumn(state: MarkdownEditorStateReport, localizer: Localizer): string {
  const selected = Math.abs(state.selectionHead - state.selectionAnchor);
  const suffix = selected === 0 ? "" : localizer.t(" ({0} selected)", selected);
  return localizer.t("Ln {0}, Col {1}{2}", state.line, state.column, suffix);
}

function formatIndentation(state: MarkdownEditorStateReport, localizer: Localizer): string {
  return state.insertSpaces
    ? localizer.t("Spaces: {0}", state.tabSize)
    : localizer.t("Tab Size: {0}", state.tabSize);
}

function formatEncoding(encoding: string): string {
  switch (encoding) {
    case "utf8":
      return "UTF-8";
    case "utf8bom":
      return "UTF-8 with BOM";
    case "utf16le":
      return "UTF-16 LE";
    case "utf16be":
      return "UTF-16 BE";
    default:
      return encoding;
  }
}

function isValidIndentation(value: StatusIndentation): boolean {
  return (
    typeof value.insertSpaces === "boolean" &&
    Number.isSafeInteger(value.tabSize) &&
    value.tabSize > 0
  );
}

function isValidNavigation(value: StatusNavigation): boolean {
  return (
    Number.isSafeInteger(value.line) &&
    value.line > 0 &&
    Number.isSafeInteger(value.column) &&
    value.column > 0
  );
}
