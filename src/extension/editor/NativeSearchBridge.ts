import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "../../protocol/messages.js";
import type { NativeSearchRequest } from "../../protocol/nativeSearchMessages.js";
import type { MarkdownEditorStateReport } from "./MarkdownEditorSessionRegistry.js";

/** Converts canonical LF offsets without mistaking CRLF bytes for editor columns. */
export function protocolPosition(document: vscode.TextDocument, offset: number): vscode.Position {
  const lines = document.getText().replace(/\r\n/gu, "\n").split("\n");
  let remaining = offset;
  for (const [index, line] of lines.entries()) {
    if (remaining <= line.length) return new vscode.Position(index, remaining);
    remaining -= line.length + 1;
  }
  throw new Error("検索対象の選択位置が文書の範囲外です。");
}
export function protocolOffset(document: vscode.TextDocument, position: vscode.Position): number {
  let offset = position.character;
  for (let line = 0; line < position.line; line += 1)
    offset += document.lineAt(line).text.length + 1;
  return offset;
}

interface Session {
  readonly document: vscode.TextDocument;
  readonly panel: vscode.WebviewPanel;
  readonly sessionId: string;
  controllerId: string | undefined;
  pendingSelection: vscode.Selection | undefined;
  busy: boolean;
}
export class NativeSearchBridge implements vscode.Disposable {
  private readonly sessions = new Set<Session>();
  public register(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    sessionId: string,
  ): {
    ready(controllerId: string): void;
    report(report: MarkdownEditorStateReport): void;
    search(request: NativeSearchRequest): Promise<void>;
    dispose(): void;
  } {
    const session: Session = {
      document,
      panel,
      sessionId,
      controllerId: undefined,
      pendingSelection: undefined,
      busy: false,
    };
    this.sessions.add(session);
    return {
      ready: (controllerId) => {
        session.controllerId = controllerId;
      },
      report: (report) => {
        if (
          session.pendingSelection === undefined ||
          !panel.active ||
          report.documentVersion !== document.version ||
          report.composing ||
          report.recoveryActive ||
          report.barrierActive ||
          session.controllerId === undefined
        )
          return;
        const selection = session.pendingSelection;
        session.pendingSelection = undefined;
        void panel.webview.postMessage({
          kind: "native-search-return",
          protocolVersion: PROTOCOL_VERSION,
          documentUri: document.uri.toString(),
          sessionId,
          controllerId: session.controllerId,
          documentVersion: document.version,
          anchor: protocolOffset(document, selection.anchor),
          head: protocolOffset(document, selection.active),
        });
      },
      search: async (request) => {
        if (session.busy) return;
        session.busy = true;
        let note: string | undefined;
        try {
          if (
            !this.sessions.has(session) ||
            !panel.active ||
            document.isClosed ||
            request.documentUri !== document.uri.toString() ||
            request.sessionId !== sessionId ||
            request.controllerId !== session.controllerId ||
            request.documentVersion !== document.version
          )
            throw new Error("文書の状態が変わったため検索への移動を取り消しました。");
          const selection = new vscode.Selection(
            protocolPosition(document, request.anchor),
            protocolPosition(document, request.head),
          );
          const editor = await vscode.window.showTextDocument(document, {
            viewColumn: panel.viewColumn ?? vscode.ViewColumn.Active,
            preview: false,
            preserveFocus: false,
            selection,
          });
          if (
            !this.sessions.has(session) ||
            document.version !== request.documentVersion ||
            vscode.window.activeTextEditor !== editor ||
            editor.document !== document
          )
            throw new Error("文書または表示先が変わったため検索の起動を取り消しました。");
          await vscode.commands.executeCommand(
            request.mode === "find" ? "actions.find" : "editor.action.startFindReplaceAction",
          );
          vscode.window.setStatusBarMessage(
            "Markdown Live Editor: 検索・置換後は「Live Editorへ戻る」から戻れます。",
            4000,
          );
        } catch (error) {
          note = error instanceof Error ? error.message : "標準検索を開けませんでした。";
          vscode.window.setStatusBarMessage(note, 4000);
        } finally {
          session.busy = false;
          if (this.sessions.has(session))
            await panel.webview.postMessage({
              kind: "native-search-finished",
              protocolVersion: PROTOCOL_VERSION,
              documentUri: document.uri.toString(),
              sessionId,
              controllerId: request.controllerId,
              ...(note === undefined ? {} : { note }),
            });
        }
      },
      dispose: () => {
        this.sessions.delete(session);
      },
    };
  }
  public async returnToLive(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== "markdown") return;
    const session = [...this.sessions]
      .reverse()
      .find(
        (candidate) =>
          candidate.document === editor.document &&
          candidate.panel.viewColumn === editor.viewColumn,
      );
    if (session !== undefined) {
      session.pendingSelection = editor.selection;
      session.panel.reveal(editor.viewColumn, false);
    } else {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        editor.document.uri,
        "vscodeMarkdownLiveEditor.editor",
        editor.viewColumn,
      );
    }
  }
  public dispose(): void {
    this.sessions.clear();
  }
}
