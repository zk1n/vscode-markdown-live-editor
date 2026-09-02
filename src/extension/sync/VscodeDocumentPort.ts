import * as vscode from "vscode";

import { disabledDiagnosticLog, type DiagnosticLog } from "../../core/diagnostics/diagnosticLog.js";
import type {
  DocumentPort,
  DocumentPortResult,
  DocumentSnapshot,
} from "../../core/sync/documentSyncCoordinator.js";

/**
 * The VS Code boundary for the pure coordinator. It deliberately retains no
 * document text: every result is reread from VS Code's TextDocument.
 */
export class VscodeDocumentPort implements DocumentPort {
  private readonly savesInProgress = new Set<string>();

  public constructor(private readonly diagnostics: DiagnosticLog = disabledDiagnosticLog) {}

  public isSaving(documentUri: string): boolean {
    return this.savesInProgress.has(documentUri);
  }

  public readDocument(documentUri: string): Promise<DocumentSnapshot> {
    return Promise.resolve(this.snapshot(this.requireDocument(documentUri)));
  }

  public async replaceDocument(
    documentUri: string,
    expectedVersion: number,
    text: string,
  ): Promise<DocumentPortResult> {
    const document = this.requireDocument(documentUri);
    this.diagnostics.record("port.replace.requested", {
      dirty: document.isDirty,
      expectedVersion,
      textLength: text.length,
      version: document.version,
    });
    if (document.version !== expectedVersion) {
      return this.rejected(
        document,
        "The document version changed before the edit could be applied.",
      );
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(
      document.uri,
      fullDocumentRange(document),
      toDocumentText(text, document.eol),
    );

    // WorkspaceEdit has no compare-and-swap version API. Checking immediately
    // before apply is the strongest public guard available; the coordinator
    // always verifies the resulting authoritative snapshot afterwards.
    if (document.version !== expectedVersion) {
      return this.rejected(
        document,
        "The document version changed before the edit could be applied.",
      );
    }

    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    const snapshot = await this.readDocument(documentUri);
    this.diagnostics.record("port.replace.result", {
      applied,
      dirty: document.isDirty,
      documentVersion: snapshot.documentVersion,
      textLength: snapshot.text.length,
    });
    return applied
      ? { kind: "applied", snapshot }
      : { kind: "rejected", snapshot, note: "VS Code rejected the document edit." };
  }

  public async saveDocument(documentUri: string): Promise<DocumentPortResult> {
    const document = this.requireDocument(documentUri);
    this.diagnostics.record("port.save.requested", {
      dirty: document.isDirty,
      documentVersion: document.version,
    });
    this.savesInProgress.add(documentUri);
    try {
      const saved = await document.save();
      const snapshot = await this.readDocument(documentUri);
      this.diagnostics.record("port.save.result", {
        dirty: document.isDirty,
        documentVersion: snapshot.documentVersion,
        saved,
        textLength: snapshot.text.length,
      });
      return saved
        ? { kind: "applied", snapshot }
        : {
            kind: "rejected",
            snapshot,
            note: "VS Code did not save the document.",
          };
    } finally {
      this.savesInProgress.delete(documentUri);
    }
  }

  public async undoDocument(documentUri: string): Promise<DocumentPortResult> {
    return this.executeHistoryCommand(documentUri, "undo");
  }

  public async redoDocument(documentUri: string): Promise<DocumentPortResult> {
    return this.executeHistoryCommand(documentUri, "redo");
  }

  private async executeHistoryCommand(
    documentUri: string,
    command: "undo" | "redo",
  ): Promise<DocumentPortResult> {
    const document = this.requireDocument(documentUri);
    this.diagnostics.record("port.history.requested", {
      command,
      dirty: document.isDirty,
      documentVersion: document.version,
    });
    if (!isActiveCustomEditorDocument(documentUri)) {
      return this.rejected(
        document,
        "Undo/Redo was not executed because this custom editor document is not active.",
      );
    }
    await vscode.commands.executeCommand(command);
    const snapshot = await this.readDocument(documentUri);
    this.diagnostics.record("port.history.result", {
      command,
      documentVersion: snapshot.documentVersion,
      textLength: snapshot.text.length,
    });
    return { kind: "applied", snapshot };
  }

  private requireDocument(documentUri: string): vscode.TextDocument {
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === documentUri,
    );
    if (document === undefined || document.isClosed) {
      throw new Error("The authoritative TextDocument is no longer open.");
    }
    return document;
  }

  private snapshot(document: vscode.TextDocument): DocumentSnapshot {
    return {
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      text: toProtocolText(document.getText()),
    };
  }

  private rejected(document: vscode.TextDocument, note: string): Promise<DocumentPortResult> {
    return Promise.resolve({
      kind: "rejected",
      snapshot: this.snapshot(document),
      note,
    });
  }
}

function isActiveCustomEditorDocument(documentUri: string): boolean {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom && input.uri.toString() === documentUri;
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = document.lineAt(document.lineCount - 1);
  return new vscode.Range(0, 0, lastLine.lineNumber, lastLine.text.length);
}

/**
 * CodeMirror's document model uses LF line separators. The synchronization
 * protocol deliberately uses that same canonical representation so exact
 * expected-result checks do not compare a CodeMirror LF string with VS Code's
 * CRLF projection of the same edit.
 */
function toProtocolText(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function toDocumentText(text: string, eol: vscode.EndOfLine): string {
  return eol === vscode.EndOfLine.CRLF ? text.replaceAll("\n", "\r\n") : text;
}
