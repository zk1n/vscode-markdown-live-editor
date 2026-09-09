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
import {
  decodeEditorReadyMessage,
  decodeWebviewToHostMessage,
  type OperationAcknowledgement,
} from "../../protocol/messages.js";
import { PROTOCOL_VERSION } from "../../protocol/messages.js";
import {
  decodeEditorStateMessage,
  isPreviewTypography,
  type HostPresentationMessage,
} from "../../protocol/presentationMessages.js";
import {
  CustomCssSession,
  type CustomCssHost,
  type CustomCssSnapshot,
} from "../styles/customCss.js";
import { VscodeCustomCssHost } from "../styles/vscodeCustomCssHost.js";
import type { MarkdownEditorSessionRegistry } from "./MarkdownEditorSessionRegistry.js";
import { allocatePresentationRevision } from "./presentationRevision.js";
import { DocumentIndentation } from "./DocumentIndentation.js";

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
  readonly customCssHost?: CustomCssHost;
  readonly viewType?: string;
  readonly webviewScriptPath: vscode.Uri;
}

/**
 * Bridges VS Code's custom-text-editor lifecycle to the project-owned sync
 * session. The session, rather than this provider, owns all TextDocument
 * mutations and ordering decisions.
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly indentation = new DocumentIndentation();
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
    const acknowledgements = new Map<number, OperationAcknowledgement>();
    diagnostics.record("provider.session.created", { documentUri, sessionId });
    const endpoint: WebviewEndpoint = {
      postMessage: (message): void => {
        if (
          message.kind === "operation-ack" &&
          (message.operation === "undo" || message.operation === "redo")
        ) {
          acknowledgements.set(message.sequence, message);
        }
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
        document,
        webview,
        documentUri,
        sessionId,
        endpoint,
        diagnostics,
        webviewPanel,
        cancellationToken,
        acknowledgements,
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
    document: vscode.TextDocument,
    webview: vscode.Webview,
    documentUri: string,
    sessionId: string,
    endpoint: WebviewEndpoint,
    diagnostics: DiagnosticLog,
    webviewPanel: vscode.WebviewPanel,
    cancellationToken: vscode.CancellationToken,
    acknowledgements: Map<number, OperationAcknowledgement>,
  ): Promise<void> {
    const lifecycle = { disposed: false };
    let receiveDisposable: vscode.Disposable = vscode.Disposable.from();
    let trackingDisposable: vscode.Disposable = vscode.Disposable.from();
    let trackingReady = false;
    let controllerActivationOrdinal = 0;
    let currentControllerId: string | undefined;
    let styleRevision = 1;
    let latestStyle: CustomCssSnapshot | undefined;
    let customCssSession: CustomCssSession | undefined;
    const customCssHost = this.options.customCssHost ?? new VscodeCustomCssHost();
    const postPresentation = (message: HostPresentationMessage): void => {
      void webview.postMessage(message);
    };
    const sendConfiguration = (): void => {
      if (currentControllerId === undefined || lifecycle.disposed) {
        return;
      }
      const configuration = this.indentation.resolve(
        document,
        resolveEditorConfiguration(document),
      );
      postPresentation({
        kind: "editor-configuration",
        protocolVersion: PROTOCOL_VERSION,
        documentUri,
        sessionId,
        controllerId: currentControllerId,
        revision: allocatePresentationRevision(),
        ...configuration,
      });
    };
    const sendLatestStyle = (): void => {
      if (currentControllerId === undefined || latestStyle === undefined || lifecycle.disposed) {
        return;
      }
      const preview = vscode.workspace.getConfiguration("markdown.preview", document.uri);
      const typography = {
        fontFamily: preview.get<unknown>("fontFamily"),
        fontSize: preview.get<unknown>("fontSize"),
        lineHeight: preview.get<unknown>("lineHeight"),
      };
      postPresentation({
        kind: "style-snapshot",
        protocolVersion: PROTOCOL_VERSION,
        documentUri,
        sessionId,
        controllerId: currentControllerId,
        revision: styleRevision,
        css: latestStyle.css,
        ...(isPreviewTypography(typography) ? { typography } : {}),
      });
      styleRevision += 1;
    };
    const recreateCustomCssSession = (): void => {
      customCssSession?.dispose();
      customCssSession = new CustomCssSession(customCssHost, {
        documentUri: document.uri,
        getUserCss: (): unknown =>
          vscode.workspace
            .getConfiguration("vscodeMarkdownLiveEditor", document.uri)
            .inspect<unknown>("customCss")?.globalValue,
        onDidUpdate: (snapshot): void => {
          if (lifecycle.disposed) {
            return;
          }
          latestStyle = snapshot;
          diagnostics.record("provider.style.updated", {
            sessionId,
            workspaceStatus: snapshot.workspace.status,
            userStatus: snapshot.user.status,
            customCssLength: snapshot.css.length,
          });
          sendLatestStyle();
        },
      });
      void customCssSession.start();
    };
    const indentationDisposable = this.indentation.subscribe(document, sendConfiguration);
    const configurationDisposable = vscode.workspace.onDidChangeConfiguration((event): void => {
      if (
        event.affectsConfiguration("editor.insertSpaces", document.uri) ||
        event.affectsConfiguration("editor.indentSize", document.uri) ||
        event.affectsConfiguration("editor.tabSize", document.uri)
      ) {
        sendConfiguration();
      }
      if (event.affectsConfiguration("vscodeMarkdownLiveEditor.customCss", document.uri)) {
        void customCssSession?.reload();
      }
      if (event.affectsConfiguration("markdown.preview", document.uri)) {
        sendLatestStyle();
      }
    });
    const workspaceFoldersDisposable = vscode.workspace.onDidChangeWorkspaceFolders((): void => {
      recreateCustomCssSession();
    });
    const trustDisposable = vscode.workspace.onDidGrantWorkspaceTrust((): void => {
      recreateCustomCssSession();
    });
    const disposeSession = (): void => {
      if (lifecycle.disposed) {
        return;
      }
      lifecycle.disposed = true;
      diagnostics.record("provider.session.disposed", { documentUri, sessionId });
      receiveDisposable.dispose();
      trackingDisposable.dispose();
      configurationDisposable.dispose();
      indentationDisposable.dispose();
      workspaceFoldersDisposable.dispose();
      trustDisposable.dispose();
      customCssSession?.dispose();
      acknowledgements.clear();
      this.coordinator.closeSession(documentUri, sessionId);
      panelDispose.dispose();
      cancellationDispose.dispose();
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
      disposeSession();
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
          lifecycle.disposed
        ) {
          diagnostics.record("provider.webview.ready-rejected", { documentUri, sessionId });
          return;
        }
        controllerActivationOrdinal += 1;
        const activationOrdinal = controllerActivationOrdinal;
        const controllerId = ready.value.controllerId;
        diagnostics.record("provider.webview.ready", { documentUri, sessionId, controllerId });
        void this.coordinator
          .activateController(documentUri, sessionId, endpoint, controllerId)
          .then((activated): void => {
            if (lifecycle.disposed || activationOrdinal !== controllerActivationOrdinal) {
              return;
            }
            if (!activated.ok) {
              endpoint.postMessage({ kind: "protocol-error", note: activated.error });
              return;
            }
            if (!trackingReady) {
              trackingReady = true;
              trackingDisposable = this.registerSession(document, sessionId, webviewPanel);
            }
            currentControllerId = controllerId;
            this.options.sessionRegistry?.replaceController(sessionId, controllerId);
            endpoint.postMessage({
              kind: "controller-ready",
              protocolVersion: PROTOCOL_VERSION,
              documentUri,
              documentVersion: activated.snapshot.documentVersion,
              sessionId,
              controllerId,
              nextSequence: activated.nextSequence,
              text: activated.snapshot.text,
            });
            sendConfiguration();
            if (customCssSession === undefined) {
              recreateCustomCssSession();
            } else {
              sendLatestStyle();
            }
            diagnostics.record("provider.controller.activated", {
              documentUri,
              sessionId,
              controllerId,
              nextSequence: activated.nextSequence,
              documentVersion: activated.snapshot.documentVersion,
            });
          });
        return;
      }
      if (isEditorStateCandidate(value)) {
        const report = decodeEditorStateMessage(value);
        if (
          report.ok &&
          report.value.documentUri === documentUri &&
          report.value.sessionId === sessionId &&
          report.value.controllerId === currentControllerId &&
          !lifecycle.disposed
        ) {
          this.options.sessionRegistry?.reportEditorState(
            sessionId,
            report.value.controllerId,
            report.value,
          );
        }
        return;
      }
      const operation = decodeWebviewToHostMessage(value);
      const historySequence =
        operation.ok && (operation.value.kind === "undo" || operation.value.kind === "redo")
          ? operation.value.sequence
          : undefined;
      const historyRequest =
        operation.ok &&
        (operation.value.kind === "undo" || operation.value.kind === "redo") &&
        operation.value.shortcutAttemptId?.startsWith("host-command:") === true
          ? {
              requestId: operation.value.shortcutAttemptId.slice("host-command:".length),
              operation: operation.value.kind,
              sequence: operation.value.sequence,
              controllerId: operation.value.controllerId,
            }
          : undefined;
      void this.coordinator.receive(value, endpoint).then((): void => {
        if (historySequence === undefined) {
          return;
        }
        const acknowledgement = acknowledgements.get(historySequence);
        acknowledgements.delete(historySequence);
        if (historyRequest === undefined) {
          return;
        }
        const active = this.options.sessionRegistry?.activeStatusSession;
        if (acknowledgement === undefined || active === undefined) {
          return;
        }
        if (
          acknowledgement.operation !== historyRequest.operation ||
          lifecycle.disposed ||
          !webviewPanel.active ||
          currentControllerId !== historyRequest.controllerId ||
          active.handle.sessionId !== sessionId ||
          active.controllerId !== historyRequest.controllerId
        ) {
          return;
        }
        postPresentation({
          kind: "restore-history-focus",
          protocolVersion: PROTOCOL_VERSION,
          documentUri,
          sessionId,
          controllerId: historyRequest.controllerId,
          requestId: historyRequest.requestId,
          documentVersion: acknowledgement.documentVersion,
          operation: historyRequest.operation,
        });
      });
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
      trackingDisposable = this.registerSession(document, sessionId, webviewPanel);
    });
    webview.html = createWebviewHtml(
      webview,
      webview.asWebviewUri(this.options.webviewScriptPath),
      bootstrap,
    );
    return Promise.resolve();
  }

  private registerSession(
    document: vscode.TextDocument,
    sessionId: string,
    webviewPanel: vscode.WebviewPanel,
  ): vscode.Disposable {
    const registry = this.options.sessionRegistry;
    if (registry === undefined) {
      return vscode.Disposable.from();
    }
    const registration = registry.register(
      {
        documentUri: document.uri.toString(),
        sessionId,
        reveal: (): void => {
          webviewPanel.reveal(undefined, false);
        },
        postMessage: (message) => webviewPanel.webview.postMessage(message),
        postPresentationMessage: (message) => {
          if (message.kind === "editor-configuration") {
            const delivered = this.indentation.set(document, {
              insertSpaces: message.insertSpaces,
              tabSize: message.tabSize,
              indentSize: message.indentSize ?? message.tabSize,
            });
            if (delivered) return true;
          }
          return webviewPanel.webview.postMessage(message);
        },
      },
      webviewPanel.active,
    );
    const viewStateRegistration = webviewPanel.onDidChangeViewState((event): void => {
      registry.markViewState(sessionId, event.webviewPanel.active);
    });
    return vscode.Disposable.from(registration, viewStateRegistration);
  }
}

function isEditorReadyCandidate(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, "kind") === "editor-ready"
  );
}

function isEditorStateCandidate(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, "kind") === "editor-state"
  );
}

function resolveEditorConfiguration(document: vscode.TextDocument): {
  readonly insertSpaces: boolean;
  readonly tabSize: number;
  readonly indentSize: number;
} {
  const configuration = vscode.workspace.getConfiguration("editor", {
    uri: document.uri,
    languageId: document.languageId,
  });
  const configuredInsertSpaces = configuration.get<unknown>("insertSpaces");
  const configuredTabSize = configuration.get<unknown>("tabSize");
  const configuredIndentSize = configuration.get<unknown>("indentSize");
  const tabSize =
    typeof configuredTabSize === "number" &&
    Number.isSafeInteger(configuredTabSize) &&
    configuredTabSize > 0 &&
    configuredTabSize <= 32
      ? configuredTabSize
      : 4;
  return {
    insertSpaces: typeof configuredInsertSpaces === "boolean" ? configuredInsertSpaces : true,
    tabSize,
    indentSize:
      typeof configuredIndentSize === "number" &&
      Number.isSafeInteger(configuredIndentSize) &&
      configuredIndentSize > 0 &&
      configuredIndentSize <= 32
        ? configuredIndentSize
        : tabSize,
  };
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
