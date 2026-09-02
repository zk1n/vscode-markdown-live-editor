import * as vscode from "vscode";

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
    if (document.version !== expectedVersion) {
      return this.rejected(
        document,
        "The document version changed before the edit could be applied.",
      );
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(document.uri, fullDocumentRange(document), text);

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
    return applied
      ? { kind: "applied", snapshot }
      : { kind: "rejected", snapshot, note: "VS Code rejected the document edit." };
  }

  public async saveDocument(documentUri: string): Promise<DocumentPortResult> {
    const document = this.requireDocument(documentUri);
    this.savesInProgress.add(documentUri);
    try {
      const saved = await document.save();
      const snapshot = await this.readDocument(documentUri);
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
    await vscode.commands.executeCommand(command);
    return { kind: "applied", snapshot: await this.readDocument(documentUri) };
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
      text: document.getText(),
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

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = document.lineAt(document.lineCount - 1);
  return new vscode.Range(0, 0, lastLine.lineNumber, lastLine.text.length);
}
