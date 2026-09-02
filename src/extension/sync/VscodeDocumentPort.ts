import * as vscode from "vscode";
import { TextDecoder } from "node:util";

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
  private readonly replacementsInProgress = new Map<string, PendingReplacement>();

  public constructor(private readonly diagnostics: DiagnosticLog = disabledDiagnosticLog) {}

  public isSaving(documentUri: string): boolean {
    return this.savesInProgress.has(documentUri);
  }

  /**
   * Classifies only the exact TextDocument update currently expected from this
   * port's WorkspaceEdit.  All other changes, including a concurrent update,
   * remain external and must be broadcast to sessions.
   */
  public classifyDocumentChange(event: vscode.TextDocumentChangeEvent): "own" | "external" {
    const document = event.document;
    const pending = this.replacementsInProgress.get(document.uri.toString());
    const change = event.contentChanges.length === 1 ? event.contentChanges[0] : undefined;
    if (
      pending !== undefined &&
      document.version === pending.expectedVersion + 1 &&
      toProtocolText(document.getText()) === pending.targetText &&
      change !== undefined &&
      toProtocolText(change.text) === pending.targetText
    ) {
      return "own";
    }
    return "external";
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

    const pending: PendingReplacement = { expectedVersion, targetText: text };
    this.replacementsInProgress.set(documentUri, pending);
    let applied: boolean;
    let snapshot: DocumentSnapshot;
    try {
      applied = await vscode.workspace.applyEdit(workspaceEdit);
      snapshot = await this.readDocument(documentUri);
    } finally {
      if (this.replacementsInProgress.get(documentUri) === pending) {
        this.replacementsInProgress.delete(documentUri);
      }
    }
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
      const diskText = await this.readDiskText(document);
      const clean = !document.isDirty;
      const diskMatches = diskText === snapshot.text;
      this.diagnostics.record("port.save.result", {
        clean,
        diskMatches,
        dirty: document.isDirty,
        documentVersion: snapshot.documentVersion,
        saved,
        textLength: snapshot.text.length,
      });
      if (clean && diskMatches) {
        // `TextDocument.save()` can complete after another save has already
        // made the document clean. The persistent postcondition, rather than
        // its boolean alone, decides whether this FIFO Save barrier succeeded.
        return { kind: "applied", snapshot };
      }

      return {
        kind: "rejected",
        snapshot,
        note: saveFailureNote(saved, clean, diskMatches),
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

  private async readDiskText(document: vscode.TextDocument): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    return toProtocolText(new TextDecoder().decode(bytes));
  }

  private rejected(document: vscode.TextDocument, note: string): Promise<DocumentPortResult> {
    return Promise.resolve({
      kind: "rejected",
      snapshot: this.snapshot(document),
      note,
    });
  }
}

interface PendingReplacement {
  readonly expectedVersion: number;
  readonly targetText: string;
}

function saveFailureNote(saved: boolean, clean: boolean, diskMatches: boolean): string {
  if (!clean) {
    return saved
      ? "VS Code reported Save success, but the document is still dirty."
      : "VS Code did not save the dirty document.";
  }
  return diskMatches
    ? "VS Code save result was inconsistent with the verified disk state."
    : "The document is clean, but disk text differs from the authoritative TextDocument.";
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
