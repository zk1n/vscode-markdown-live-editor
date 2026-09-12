import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "../../protocol/messages.js";
import type { SaveAsImageRequest } from "../../protocol/saveAsImageMessages.js";
import type { MarkdownEditorStateReport } from "./MarkdownEditorSessionRegistry.js";

interface Session {
  readonly document: vscode.TextDocument;
  readonly panel: vscode.WebviewPanel;
  readonly id: string;
  controller: string | undefined;
  report: MarkdownEditorStateReport | undefined;
}
interface Pending {
  readonly target: Session;
  readonly text: string;
  readonly request: SaveAsImageRequest;
}
/** Carries only the explicit image action across VS Code's Save As identity change. */
export class SaveAsImageBridge {
  private readonly sessions = new Set<Session>();
  private pending: Pending | undefined;
  private busy = false;
  public register(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    id: string,
  ): {
    ready(controller: string): void;
    report(report: MarkdownEditorStateReport): void;
    receive(request: SaveAsImageRequest): Promise<void>;
    dispose(): void;
  } {
    const session: Session = { document, panel, id, controller: undefined, report: undefined };
    this.sessions.add(session);
    const viewState = panel.onDidChangeViewState(() => {
      if (this.pending?.target === session && !panel.active) this.cancelPending();
    });
    return {
      ready: (controller) => {
        session.controller = controller;
      },
      report: (report) => {
        session.report = report;
        this.deliver(session);
      },
      receive: (request) => this.save(session, request),
      dispose: () => {
        if (this.pending?.target === session) this.cancelPending();
        viewState.dispose();
        this.sessions.delete(session);
      },
    };
  }
  private async save(session: Session, request: SaveAsImageRequest): Promise<void> {
    const { document, panel } = session;
    if (this.busy) {
      await panel.webview.postMessage({
        kind: "image-save-as-finished",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: request.documentUri,
        sessionId: request.sessionId,
        controllerId: request.controllerId,
        note: "別の画像の保存先を指定中です。その操作が終わってからもう一度貼り付けてください。",
      });
      return;
    }
    this.busy = true;
    let note = "保存を取り消しました。画像は挿入していません。";
    try {
      if (
        !panel.active ||
        !document.isUntitled ||
        document.isClosed ||
        request.documentUri !== document.uri.toString() ||
        request.sessionId !== session.id ||
        request.controllerId !== session.controller ||
        request.documentVersion !== document.version
      )
        throw new Error("文書の状態が変わったため画像挿入を取り消しました。");
      if (!vscode.workspace.isTrusted)
        throw new Error("画像の取り込みにはワークスペースの信頼が必要です。");
      const text = document.getText().replace(/\r\n/gu, "\n");
      if (request.anchor > text.length || request.head > text.length)
        throw new Error("挿入位置が文書の範囲外です。");
      const uri = await vscode.workspace.saveAs(document.uri);
      if (uri === undefined) return;
      if (uri.scheme !== "file")
        throw new Error("画像添付にはローカルのMarkdownへ保存してください。");
      const saved = await vscode.workspace.openTextDocument(uri);
      if (saved.getText().replace(/\r\n/gu, "\n") !== text)
        throw new Error("保存中に本文が変わったため画像挿入を取り消しました。");
      if (
        ![...this.sessions].some(
          (candidate) => candidate.document === saved && candidate.panel.active,
        ) &&
        vscode.window.activeTextEditor?.document !== saved
      )
        throw new Error("表示する文書が変わったため画像挿入を取り消しました。");
      note = "保存しました。元の挿入位置で画像の取り込みを続けます。";
      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        "vscodeMarkdownLiveEditor.editor",
        panel.viewColumn ?? vscode.ViewColumn.Active,
      );
      const target = [...this.sessions].find(
        (candidate) => candidate.document === saved && candidate.panel.active,
      );
      if (target === undefined || saved.isClosed)
        throw new Error("保存後の文書が閉じられたため画像挿入を取り消しました。");
      this.pending = { target, text, request };
      this.deliver(target);
    } catch (error) {
      this.pending = undefined;
      note = error instanceof Error ? error.message : "画像挿入のための保存に失敗しました。";
    } finally {
      this.busy = false;
      vscode.window.setStatusBarMessage(note, 4000);
      if (this.sessions.has(session))
        await panel.webview.postMessage({
          kind: "image-save-as-finished",
          protocolVersion: PROTOCOL_VERSION,
          documentUri: request.documentUri,
          sessionId: request.sessionId,
          controllerId: request.controllerId,
          note,
        });
    }
  }
  private deliver(session: Session): void {
    const pending = this.pending;
    if (
      pending?.target !== session ||
      !this.sessions.has(session) ||
      session.document.isClosed ||
      !session.panel.active ||
      session.controller === undefined ||
      session.report?.documentVersion !== session.document.version ||
      session.report.composing ||
      session.report.recoveryActive ||
      session.report.barrierActive
    )
      return;
    this.pending = undefined;
    if (session.document.getText().replace(/\r\n/gu, "\n") !== pending.text) {
      vscode.window.setStatusBarMessage("本文が変わったため画像挿入を取り消しました。", 4000);
      return;
    }
    void session.panel.webview.postMessage({
      ...pending.request,
      kind: "saved-image-continuation",
      documentUri: session.document.uri.toString(),
      sessionId: session.id,
      controllerId: session.controller,
      documentVersion: session.document.version,
    });
  }
  private cancelPending(): void {
    this.pending = undefined;
    vscode.window.setStatusBarMessage(
      "文書を閉じるか表示先が変わったため画像挿入を取り消しました。",
      4000,
    );
  }
}
