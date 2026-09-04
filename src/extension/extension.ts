import * as vscode from "vscode";

import {
  decodeDiagnosticMode,
  recordsDiagnosticTrace,
} from "../core/diagnostics/diagnosticMode.js";
import { BoundedDiagnosticLog } from "../core/diagnostics/diagnosticLog.js";
import { textFingerprint } from "../core/diagnostics/textFingerprint.js";
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
    diagnostics,
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
  const copyDiagnostics = vscode.commands.registerCommand(
    "vscodeMarkdownLiveEditor.copyDiagnostics",
    async (): Promise<void> => {
      await vscode.env.clipboard.writeText(diagnostics.copyText());
      await vscode.window.showInformationMessage(
        "Markdown Live Editor diagnostic metadata copied.",
      );
    },
  );

  const customEditorRegistration = vscode.window.registerCustomEditorProvider(
    MARKDOWN_EDITOR_VIEW_TYPE,
    editorProvider,
    { supportsMultipleEditorsPerDocument: true },
  );

  const handleDocumentChange = createDocumentChangeHandler(documentPort, coordinator, diagnostics);
  const documentChangeRegistration = vscode.workspace.onDidChangeTextDocument(handleDocumentChange);

  const saveBarrierRegistration = vscode.workspace.onWillSaveTextDocument((event): void => {
    if (event.document.languageId !== "markdown") {
      return;
    }
    if (documentPort.isSaving(event.document.uri.toString())) {
      diagnostics.record("extension.will-save", {
        documentVersion: event.document.version,
        skippedBecausePortSave: true,
      });
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
    copyDiagnostics,
    customEditorRegistration,
    documentChangeRegistration,
    saveBarrierRegistration,
  );
}

function toProtocolText(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

export function deactivate(): void {
  // No global resources are retained by the scaffold.
}

/** The production listener body is exported solely for Extension Host regression coverage. */
export function createDocumentChangeHandler(
  documentPort: VscodeDocumentPort,
  coordinator: DocumentSyncCoordinator,
  diagnostics: BoundedDiagnosticLog,
): (event: vscode.TextDocumentChangeEvent) => void {
  let nextDocumentChangeEventId = 1;
  return (event: vscode.TextDocumentChangeEvent): void => {
    if (event.document.languageId !== "markdown") {
      return;
    }
    const changeClassification = documentPort.classifyDocumentChange(event);
    const eventId = `document-change-${String(nextDocumentChangeEventId)}`;
    nextDocumentChangeEventId += 1;
    const eventText = toProtocolText(event.document.getText());
    const firstChange = event.contentChanges[0];
    diagnostics.record("extension.document.changed", {
      eventId,
      classification: changeClassification,
      contentChangeCount: event.contentChanges.length,
      dirty: event.document.isDirty,
      documentVersion: event.document.version,
      eventTextFingerprint: textFingerprint(eventText),
      textLength: eventText.length,
      firstChangeTextFingerprint:
        firstChange === undefined ? "none" : textFingerprint(toProtocolText(firstChange.text)),
      firstChangeRange:
        firstChange === undefined
          ? "none"
          : `${String(firstChange.range.start.line)}:${String(firstChange.range.start.character)}-${String(firstChange.range.end.line)}:${String(firstChange.range.end.character)}`,
    });
    if (changeClassification === "own") {
      return;
    }
    void coordinator.publishExternalChange(event.document.uri.toString(), {
      eventId,
      eventDocumentVersion: event.document.version,
      eventTextFingerprint: textFingerprint(eventText),
      eventTextLength: eventText.length,
      contentChangeCount: event.contentChanges.length,
      classification: changeClassification,
    });
  };
}

function createDiagnostics(
  mode: ReturnType<typeof decodeDiagnosticMode>,
  context: vscode.ExtensionContext,
): BoundedDiagnosticLog {
  const output = recordsDiagnosticTrace(mode)
    ? vscode.window.createOutputChannel("Markdown Live Editor ATOK Diagnostics")
    : undefined;
  if (output !== undefined) {
    context.subscriptions.push(output);
  }
  return new BoundedDiagnosticLog(250, (line): void => output?.appendLine(line));
}
