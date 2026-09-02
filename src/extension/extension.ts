import * as vscode from "vscode";

import { PROJECT_IDENTITY } from "../core/projectIdentity.js";
import { DocumentSyncCoordinator } from "../core/sync/documentSyncCoordinator.js";
import { MarkdownEditorProvider } from "./editor/MarkdownEditorProvider.js";
import { VscodeDocumentPort } from "./sync/VscodeDocumentPort.js";

const MARKDOWN_EDITOR_VIEW_TYPE = "vscodeMarkdownLiveEditor.editor";

export function activate(context: vscode.ExtensionContext): void {
  const documentPort = new VscodeDocumentPort();
  const coordinator = new DocumentSyncCoordinator(documentPort);
  const editorProvider = new MarkdownEditorProvider(coordinator, {
    webviewScriptPath: vscode.Uri.joinPath(context.extensionUri, "dist", "webview.js"),
  });

  const disposable = vscode.commands.registerCommand(
    "vscodeMarkdownLiveEditor.showProjectInfo",
    async (): Promise<void> => {
      await vscode.window.showInformationMessage(
        `${PROJECT_IDENTITY.displayName}: project scaffold is ready.`,
      );
    },
  );

  const customEditorRegistration = vscode.window.registerCustomEditorProvider(
    MARKDOWN_EDITOR_VIEW_TYPE,
    editorProvider,
    { supportsMultipleEditorsPerDocument: true },
  );

  const documentChangeRegistration = vscode.workspace.onDidChangeTextDocument((event): void => {
    if (event.document.languageId !== "markdown") {
      return;
    }
    void coordinator.publishExternalChange(event.document.uri.toString());
  });

  const saveBarrierRegistration = vscode.workspace.onWillSaveTextDocument((event): void => {
    if (event.document.languageId !== "markdown") {
      return;
    }
    if (documentPort.isSaving(event.document.uri.toString())) {
      return;
    }
    event.waitUntil(coordinator.flush(event.document.uri.toString()).then(() => []));
  });

  context.subscriptions.push(
    disposable,
    customEditorRegistration,
    documentChangeRegistration,
    saveBarrierRegistration,
  );
}

export function deactivate(): void {
  // No global resources are retained by the scaffold.
}
