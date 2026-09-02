import * as vscode from "vscode";

import {
  decodeDiagnosticMode,
  recordsDiagnosticTrace,
} from "../core/diagnostics/diagnosticMode.js";
import {
  disabledDiagnosticLog,
  type DiagnosticLog,
  type DiagnosticLogValue,
} from "../core/diagnostics/diagnosticLog.js";
import { PROJECT_IDENTITY } from "../core/projectIdentity.js";
import { DocumentSyncCoordinator } from "../core/sync/documentSyncCoordinator.js";
import { MarkdownEditorProvider } from "./editor/MarkdownEditorProvider.js";
import { VscodeDocumentPort } from "./sync/VscodeDocumentPort.js";

const MARKDOWN_EDITOR_VIEW_TYPE = "vscodeMarkdownLiveEditor.editor";

export function activate(context: vscode.ExtensionContext): void {
  const diagnosticMode = decodeDiagnosticMode(
    vscode.workspace
      .getConfiguration("vscodeMarkdownLiveEditor")
      .get<unknown>("developmentDiagnosticMode"),
  );
  const diagnostics = createDiagnostics(diagnosticMode, context);
  const documentPort = new VscodeDocumentPort(diagnostics);
  const coordinator = new DocumentSyncCoordinator(documentPort, diagnostics);
  const editorProvider = new MarkdownEditorProvider(coordinator, {
    diagnosticMode,
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
    diagnostics.record("extension.document.changed", {
      dirty: event.document.isDirty,
      documentVersion: event.document.version,
      textLength: event.document.getText().length,
    });
    void coordinator.publishExternalChange(event.document.uri.toString());
  });

  const saveBarrierRegistration = vscode.workspace.onWillSaveTextDocument((event): void => {
    if (event.document.languageId !== "markdown") {
      return;
    }
    if (documentPort.isSaving(event.document.uri.toString())) {
      return;
    }
    diagnostics.record("extension.will-save", {
      dirty: event.document.isDirty,
      documentVersion: event.document.version,
    });
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

function createDiagnostics(
  mode: ReturnType<typeof decodeDiagnosticMode>,
  context: vscode.ExtensionContext,
): DiagnosticLog {
  if (!recordsDiagnosticTrace(mode)) {
    return disabledDiagnosticLog;
  }
  const output = vscode.window.createOutputChannel("Markdown Live Editor ATOK Diagnostics");
  context.subscriptions.push(output);
  return {
    record: (kind: string, details: Readonly<Record<string, DiagnosticLogValue>>): void => {
      const serialized = Object.entries(details)
        .map(([key, value]): string => `${key}=${JSON.stringify(value)}`)
        .join(" ");
      output.appendLine(
        `${String(Date.now())} ${kind}${serialized === "" ? "" : ` ${serialized}`}`,
      );
    },
  };
}
