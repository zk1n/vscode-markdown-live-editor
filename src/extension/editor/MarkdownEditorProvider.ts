import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import {
  type DiagnosticMode,
  recordsDiagnosticTrace,
  usesDocumentSync,
} from "../../core/diagnostics/diagnosticMode.js";
import { disabledDiagnosticLog, type DiagnosticLog } from "../../core/diagnostics/diagnosticLog.js";
import type {
  DocumentSyncCoordinator,
  WebviewEndpoint,
} from "../../core/sync/documentSyncCoordinator.js";
import { decodeEditorReadyMessage } from "../../protocol/messages.js";
import type { MarkdownEditorSessionRegistry } from "./MarkdownEditorSessionRegistry.js";

interface MarkdownEditorBootstrap {
  readonly diagnosticMode: DiagnosticMode;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly sessionId: string;
  readonly nextSequence: number;
  readonly text: string;
}

export interface MarkdownEditorProviderOptions {
  readonly diagnosticMode: DiagnosticMode;
  readonly diagnostics?: DiagnosticLog;
  readonly onCustomEditorOpened?: (document: vscode.TextDocument) => void;
  readonly sessionRegistry?: MarkdownEditorSessionRegistry;
  readonly webviewScriptPath: vscode.Uri;
}

/**
 * Bridges VS Code's custom-text-editor lifecycle to the project-owned sync
 * session. The session, rather than this provider, owns all TextDocument
 * mutations and ordering decisions.
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public constructor(
    private readonly coordinator: DocumentSyncCoordinator,
    private readonly options: MarkdownEditorProviderOptions,
  ) {}

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    cancellationToken: vscode.CancellationToken,
  ): Promise<void> {
    this.options.onCustomEditorOpened?.(document);
    const { webview } = webviewPanel;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.options.webviewScriptPath, "..")],
    };

    const documentUri = document.uri.toString();
    const sessionId = randomUUID();
    const diagnostics = this.options.diagnostics ?? disabledDiagnosticLog;
    diagnostics.record("provider.session.created", { documentUri, sessionId });
    const endpoint: WebviewEndpoint = {
      postMessage: (message): void => {
        void webview.postMessage(message).then(
          (delivered): void => {
            diagnostics.record("provider.webview.post", {
              sessionId,
              messageKind: message.kind,
              delivered,
            });
          },
          (): void => {
            diagnostics.record("provider.webview.post", {
              sessionId,
              messageKind: message.kind,
              delivered: false,
            });
          },
        );
      },
    };

    if (usesDocumentSync(this.options.diagnosticMode)) {
      return this.openSyncedSession(
        webview,
        documentUri,
        sessionId,
        endpoint,
        diagnostics,
        webviewPanel,
        cancellationToken,
      );
    }

    return this.openStandaloneDiagnosticSession(
      document,
      webview,
      webviewPanel,
      cancellationToken,
      sessionId,
    );
  }

  private async openSyncedSession(
    webview: vscode.Webview,
    documentUri: string,
    sessionId: string,
    endpoint: WebviewEndpoint,
    diagnostics: DiagnosticLog,
    webviewPanel: vscode.WebviewPanel,
    cancellationToken: vscode.CancellationToken,
  ): Promise<void> {
    const lifecycle = { disposed: false };
    let receiveDisposable: vscode.Disposable = vscode.Disposable.from();
    let trackingDisposable: vscode.Disposable = vscode.Disposable.from();
    let trackingReady = false;
    const disposeSession = (): void => {
      if (lifecycle.disposed) {
        return;
      }
      lifecycle.disposed = true;
      diagnostics.record("provider.session.disposed", { documentUri, sessionId });
      receiveDisposable.dispose();
      trackingDisposable.dispose();
      this.coordinator.closeSession(documentUri, sessionId);
    };
    const panelDispose = webviewPanel.onDidDispose(disposeSession);
    const cancellationDispose = cancellationToken.onCancellationRequested(disposeSession);

    diagnostics.record("provider.session.opening", { documentUri, sessionId });
    const opened = await this.coordinator.openSession(documentUri, sessionId, endpoint);
    if (lifecycle.disposed) {
      this.coordinator.closeSession(documentUri, sessionId);
      panelDispose.dispose();
      cancellationDispose.dispose();
      return;
    }
    if (!opened.ok) {
      webview.html = createFailureHtml(webview, opened.error);
      panelDispose.dispose();
      cancellationDispose.dispose();
      return;
    }

    const bootstrap: MarkdownEditorBootstrap = {
      diagnosticMode: this.options.diagnosticMode,
      documentUri,
      documentVersion: opened.snapshot.documentVersion,
      sessionId,
      nextSequence: 1,
      text: opened.snapshot.text,
    };
    receiveDisposable = webview.onDidReceiveMessage((value: unknown) => {
      if (isEditorReadyCandidate(value)) {
        const ready = decodeEditorReadyMessage(value);
        if (
          !ready.ok ||
          ready.value.documentUri !== documentUri ||
          ready.value.sessionId !== sessionId ||
          trackingReady ||
          lifecycle.disposed
        ) {
          diagnostics.record("provider.webview.ready-rejected", { documentUri, sessionId });
          return;
        }
        trackingReady = true;
        trackingDisposable = this.registerSession(documentUri, sessionId, webviewPanel);
        diagnostics.record("provider.webview.ready", { documentUri, sessionId });
        return;
      }
      void this.coordinator.receive(value, endpoint);
    });
    webview.html = createWebviewHtml(
      webview,
      webview.asWebviewUri(this.options.webviewScriptPath),
      bootstrap,
    );
    diagnostics.record("provider.session.webview-ready", {
      documentUri,
      sessionId,
      documentVersion: opened.snapshot.documentVersion,
    });
  }

  /**
   * A1/A2 deliberately do not open a coordinator session or a webview message
   * receiver. They cannot mutate the VS Code TextDocument authority.
   */
  private openStandaloneDiagnosticSession(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    webviewPanel: vscode.WebviewPanel,
    cancellationToken: vscode.CancellationToken,
    sessionId: string,
  ): Promise<void> {
    const bootstrap: MarkdownEditorBootstrap = {
      diagnosticMode: this.options.diagnosticMode,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      sessionId,
      nextSequence: 1,
      text: toProtocolText(document.getText()),
    };
    let trackingDisposable = vscode.Disposable.from();
    let receiveDisposable = vscode.Disposable.from();
    let disposed = false;
    let trackingReady = false;
    let panelDispose = vscode.Disposable.from();
    let cancellationDispose = vscode.Disposable.from();
    const disposeSession = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      trackingDisposable.dispose();
      receiveDisposable.dispose();
      panelDispose.dispose();
      cancellationDispose.dispose();
    };
    panelDispose = webviewPanel.onDidDispose(disposeSession);
    cancellationDispose = cancellationToken.onCancellationRequested(disposeSession);
    receiveDisposable = webview.onDidReceiveMessage((value: unknown): void => {
      if (!isEditorReadyCandidate(value)) {
        return;
      }
      const ready = decodeEditorReadyMessage(value);
      if (
        !ready.ok ||
        ready.value.documentUri !== document.uri.toString() ||
        ready.value.sessionId !== sessionId ||
        trackingReady ||
        disposed
      ) {
        return;
      }
      trackingReady = true;
      trackingDisposable = this.registerSession(document.uri.toString(), sessionId, webviewPanel);
    });
    webview.html = createWebviewHtml(
      webview,
      webview.asWebviewUri(this.options.webviewScriptPath),
      bootstrap,
    );
    return Promise.resolve();
  }

  private registerSession(
    documentUri: string,
    sessionId: string,
    webviewPanel: vscode.WebviewPanel,
  ): vscode.Disposable {
    const registry = this.options.sessionRegistry;
    if (registry === undefined) {
      return vscode.Disposable.from();
    }
    const registration = registry.register(
      {
        documentUri,
        sessionId,
        reveal: (): void => {
          webviewPanel.reveal(undefined, false);
        },
        postMessage: (message) => webviewPanel.webview.postMessage(message),
      },
      webviewPanel.active,
    );
    const viewStateRegistration = webviewPanel.onDidChangeViewState((event): void => {
      if (event.webviewPanel.active) {
        registry.markActive(sessionId);
      }
    });
    return vscode.Disposable.from(registration, viewStateRegistration);
  }
}

function isEditorReadyCandidate(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, "kind") === "editor-ready"
  );
}

function createWebviewHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  bootstrap: MarkdownEditorBootstrap,
): string {
  const nonce = randomUUID().replaceAll("-", "");
  const contentSecurityPolicy = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    "connect-src 'none'",
  ].join("; ");
  const bootstrapJson = JSON.stringify(bootstrap).replaceAll("<", "\\u003c");
  const diagnosticPanel = recordsDiagnosticTrace(bootstrap.diagnosticMode)
    ? '<pre id="editor-diagnostics" aria-label="Development diagnostic trace"></pre>'
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(contentSecurityPolicy)}">
  <title>Markdown Live Editor</title>
  <style>
    html, body, #editor-root { height: 100%; margin: 0; }
    body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
    #editor-root { min-height: 0; }
     #editor-status { position: fixed; right: 0.75rem; bottom: 0.5rem; max-width: min(34rem, 90vw); color: var(--vscode-editorWarning-foreground); background: var(--vscode-editorWarning-background); padding: 0.35rem 0.5rem; border-radius: 3px; font: 12px var(--vscode-font-family); }
     #editor-status[hidden] { display: none; }
     #editor-diagnostics { position: fixed; left: 0.75rem; bottom: 0.5rem; width: min(64rem, calc(100vw - 1.5rem)); max-height: 35vh; overflow: auto; margin: 0; padding: 0.5rem; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); font: 11px var(--vscode-editor-font-family); white-space: pre-wrap; user-select: text; }
  </style>
</head>
<body>
   <main id="editor-root" aria-label="Markdown editor"></main>
   <div id="editor-status" role="status" aria-live="polite" hidden></div>
   ${diagnosticPanel}
  <script id="markdown-live-editor-bootstrap" type="application/json">${bootstrapJson}</script>
  <script nonce="${nonce}" src="${escapeHtmlAttribute(scriptUri.toString())}"></script>
</body>
</html>`;
}

function toProtocolText(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function createFailureHtml(webview: vscode.Webview, note: string): string {
  const contentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(contentSecurityPolicy)}">
  <title>Markdown Live Editor</title>
</head>
<body>
  <p>${escapeHtmlText(`Unable to open the Markdown editor: ${note}`)}</p>
</body>
</html>`;
}

function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
