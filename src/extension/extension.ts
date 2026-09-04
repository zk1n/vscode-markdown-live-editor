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
import { MarkdownEditorSessionRegistry } from "./editor/MarkdownEditorSessionRegistry.js";
import { shouldWarnForMarkdownTrailingWhitespace } from "./markdownTrailingWhitespace.js";
import {
  MARKDOWN_OUTLINE_VIEW_ID,
  NAVIGATE_TO_OUTLINE_HEADING_COMMAND,
  MarkdownOutlineTreeItem,
  MarkdownOutlineTreeProvider,
} from "./outline/MarkdownOutlineTreeProvider.js";
import { VscodeDocumentPort } from "./sync/VscodeDocumentPort.js";

const MARKDOWN_EDITOR_VIEW_TYPE = "vscodeMarkdownLiveEditor.editor";
const OPEN_MARKDOWN_SETTINGS = "Open Markdown Settings";

export function activate(context: vscode.ExtensionContext): void {
  const diagnosticMode = decodeDiagnosticMode(
    vscode.workspace
      .getConfiguration("vscodeMarkdownLiveEditor")
      .get<unknown>("developmentDiagnosticMode"),
  );
  const diagnostics = createDiagnostics(diagnosticMode, context);
  const documentPort = new VscodeDocumentPort(diagnostics);
  const coordinator = new DocumentSyncCoordinator(documentPort, diagnostics);
  const warnedTrailingWhitespaceDocuments = new Set<string>();
  const editorSessions = new MarkdownEditorSessionRegistry();
  const outlineProvider = new MarkdownOutlineTreeProvider(editorSessions);
  const editorProvider = new MarkdownEditorProvider(coordinator, {
    diagnosticMode,
    diagnostics,
    onCustomEditorOpened: (document): void => {
      warnForMarkdownTrailingWhitespace(document, warnedTrailingWhitespaceDocuments);
    },
    sessionRegistry: editorSessions,
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
  const navigateToOutlineHeading = vscode.commands.registerCommand(
    NAVIGATE_TO_OUTLINE_HEADING_COMMAND,
    async (value: unknown): Promise<boolean> =>
      value instanceof MarkdownOutlineTreeItem ? await outlineProvider.navigateTo(value) : false,
  );

  const outlineView = vscode.window.createTreeView(MARKDOWN_OUTLINE_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: outlineProvider,
  });

  const customEditorRegistration = vscode.window.registerCustomEditorProvider(
    MARKDOWN_EDITOR_VIEW_TYPE,
    editorProvider,
    { supportsMultipleEditorsPerDocument: true },
  );

  const handleDocumentChange = createDocumentChangeHandler(documentPort, coordinator, diagnostics);
  const documentChangeRegistration = vscode.workspace.onDidChangeTextDocument(handleDocumentChange);
  const outlineDocumentChangeRegistration = vscode.workspace.onDidChangeTextDocument(
    (event): void => {
      outlineProvider.handleDocumentChange(event.document);
    },
  );

  const saveBarrierRegistration = vscode.workspace.onWillSaveTextDocument(
    createWillSaveTextDocumentHandler(documentPort, coordinator, diagnostics),
  );

  context.subscriptions.push(
    disposable,
    copyDiagnostics,
    navigateToOutlineHeading,
    customEditorRegistration,
    outlineView,
    outlineProvider,
    documentChangeRegistration,
    outlineDocumentChangeRegistration,
    saveBarrierRegistration,
  );
}

/** The production save listener is exported solely for Extension Host regression coverage. */
export function createWillSaveTextDocumentHandler(
  documentPort: VscodeDocumentPort,
  coordinator: DocumentSyncCoordinator,
  diagnostics: BoundedDiagnosticLog,
): (event: vscode.TextDocumentWillSaveEvent) => void {
  return (event: vscode.TextDocumentWillSaveEvent): void => {
    if (event.document.languageId !== "markdown") {
      return;
    }
    const skippedBecausePortSave = documentPort.isSaving(event.document.uri.toString());
    diagnostics.record("extension.will-save", {
      ...willSaveMetadata(event),
      skippedBecausePortSave,
    });
    if (skippedBecausePortSave) {
      return;
    }
    event.waitUntil(coordinator.flush(event.document.uri.toString()).then(() => []));
  };
}

function willSaveMetadata(
  event: vscode.TextDocumentWillSaveEvent,
): Readonly<Record<string, boolean | number | string | undefined>> {
  const scope = { uri: event.document.uri, languageId: event.document.languageId };
  const files = vscode.workspace.getConfiguration("files", scope);
  const editor = vscode.workspace.getConfiguration("editor", scope);
  return {
    documentVersion: event.document.version,
    dirty: event.document.isDirty,
    saveReason: saveReasonName(event.reason),
    "files.autoSave": diagnosticString(files.get<unknown>("autoSave")),
    "files.autoSaveDelay": diagnosticNumber(files.get<unknown>("autoSaveDelay")),
    "files.trimTrailingWhitespace": diagnosticBoolean(files.get<unknown>("trimTrailingWhitespace")),
    "editor.formatOnSave": diagnosticBoolean(editor.get<unknown>("formatOnSave")),
    hasVisibleTextEditor: vscode.window.visibleTextEditors.some(
      (candidate) => candidate.document.uri.toString() === event.document.uri.toString(),
    ),
  };
}

function saveReasonName(reason: vscode.TextDocumentSaveReason): string {
  switch (reason) {
    case vscode.TextDocumentSaveReason.Manual:
      return "manual";
    case vscode.TextDocumentSaveReason.AfterDelay:
      return "after-delay";
    case vscode.TextDocumentSaveReason.FocusOut:
      return "focus-out";
    default:
      return "unknown";
  }
}

function diagnosticBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function diagnosticNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function diagnosticString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function warnForMarkdownTrailingWhitespace(
  document: vscode.TextDocument,
  warnedDocuments: Set<string>,
): void {
  const documentUri = document.uri.toString();
  if (warnedDocuments.has(documentUri)) {
    return;
  }
  const files = vscode.workspace.getConfiguration("files", {
    uri: document.uri,
    languageId: document.languageId,
  });
  if (!shouldWarnForMarkdownTrailingWhitespace(files.get<boolean>("trimTrailingWhitespace"))) {
    return;
  }
  warnedDocuments.add(documentUri);
  void vscode.window
    .showWarningMessage(
      "Markdown Live Editor: files.trimTrailingWhitespace is enabled for Markdown. Auto Save or Save can remove an in-progress trailing space such as '- ' and conflict with Japanese IME composition. Disable it for Markdown.",
      OPEN_MARKDOWN_SETTINGS,
    )
    .then(
      async (selection): Promise<void> => {
        if (selection === OPEN_MARKDOWN_SETTINGS) {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "@lang:markdown files.trimTrailingWhitespace",
          );
        }
      },
      (): void => undefined,
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
