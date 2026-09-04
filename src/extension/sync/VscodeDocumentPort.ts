import * as vscode from "vscode";
import { TextDecoder } from "node:util";

import { disabledDiagnosticLog, type DiagnosticLog } from "../../core/diagnostics/diagnosticLog.js";
import { textFingerprint } from "../../core/diagnostics/textFingerprint.js";
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
  private readonly historyInProgress = new Map<string, string>();
  private nextHistoryInvocation = 1;

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
    const historyInvocationId = this.historyInProgress.get(document.uri.toString());
    const change = event.contentChanges.length === 1 ? event.contentChanges[0] : undefined;
    const versionMatches =
      pending !== undefined && document.version === pending.expectedVersion + 1;
    const targetMatches = pending?.targetText === toProtocolText(document.getText());
    const replacementMatches =
      change !== undefined && toProtocolText(change.text) === pending?.targetText;
    const classification =
      pending !== undefined && versionMatches && targetMatches && replacementMatches
        ? "own"
        : "external";
    this.diagnostics.record("port.document-change.classified", {
      classification,
      contentChangeCount: event.contentChanges.length,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      historyInvocationId: historyInvocationId ?? "",
      pendingCausalId: pending?.causalId ?? "",
      pendingMarkerPresent: pending !== undefined,
      applyEditSettled: pending?.applyEditSettled ?? false,
      pendingExpectedVersion: pending?.expectedVersion ?? -1,
      replacementMatches,
      targetMatches,
      versionMatches,
    });
    return classification;
  }

  public readDocument(documentUri: string): Promise<DocumentSnapshot> {
    return Promise.resolve(this.snapshot(this.requireDocument(documentUri)));
  }

  public async replaceDocument(
    documentUri: string,
    expectedVersion: number,
    text: string,
    causalId?: string,
  ): Promise<DocumentPortResult> {
    const document = this.requireDocument(documentUri);
    this.diagnostics.record("port.replace.requested", {
      dirty: document.isDirty,
      expectedVersion,
      textLength: text.length,
      version: document.version,
      causalId: causalId ?? "untraced",
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

    const pending: PendingReplacement = {
      expectedVersion,
      targetText: text,
      causalId: causalId ?? "untraced",
      applyEditSettled: false,
    };
    this.replacementsInProgress.set(documentUri, pending);
    let applied: boolean;
    let snapshot: DocumentSnapshot;
    try {
      applied = await vscode.workspace.applyEdit(workspaceEdit);
      pending.applyEditSettled = true;
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
      causalId: pending.causalId,
      textLength: snapshot.text.length,
    });
    return applied
      ? { kind: "applied", snapshot }
      : { kind: "rejected", snapshot, note: "VS Code rejected the document edit." };
  }

  public async saveDocument(
    documentUri: string,
    shortcutAttemptId = "untraced",
  ): Promise<DocumentPortResult> {
    const document = this.requireDocument(documentUri);
    this.diagnostics.record("port.save.requested", {
      documentUri,
      dirty: document.isDirty,
      documentVersion: document.version,
      shortcutAttemptId,
    });
    this.savesInProgress.add(documentUri);
    try {
      const saved = await document.save();
      const snapshot = await this.readDocument(documentUri);
      const diskText = await this.readDiskText(document);
      const clean = !document.isDirty;
      const diskMatches = diskText === snapshot.text;
      this.diagnostics.record("port.save.result", {
        authorityTextLength: snapshot.text.length,
        authorityTextFingerprint: textFingerprint(snapshot.text),
        clean,
        diskTextLength: diskText.length,
        diskTextFingerprint: textFingerprint(diskText),
        diskMatches,
        dirty: document.isDirty,
        documentUri,
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

  public async undoDocument(
    documentUri: string,
    shortcutAttemptId?: string,
  ): Promise<DocumentPortResult> {
    return this.executeHistoryCommand(documentUri, "undo", shortcutAttemptId);
  }

  public async redoDocument(
    documentUri: string,
    shortcutAttemptId?: string,
  ): Promise<DocumentPortResult> {
    return this.executeHistoryCommand(documentUri, "redo", shortcutAttemptId);
  }

  private async executeHistoryCommand(
    documentUri: string,
    command: "undo" | "redo",
    shortcutAttemptId = "untraced",
  ): Promise<DocumentPortResult> {
    const document = this.requireDocument(documentUri);
    const commandInvocationId = `history-${String(this.nextHistoryInvocation)}`;
    this.nextHistoryInvocation += 1;
    const before = this.snapshot(document);
    const activeBefore = isActiveCustomEditorDocument(documentUri);
    this.diagnostics.record("port.history.requested", {
      activeCustomEditor: activeBefore,
      command,
      commandInvocationId,
      dirty: document.isDirty,
      documentUri,
      beforeDocumentVersion: before.documentVersion,
      textFingerprint: textFingerprint(before.text),
      textLength: before.text.length,
      shortcutAttemptId,
    });
    if (!activeBefore) {
      return this.rejected(
        document,
        "Undo/Redo was not executed because this custom editor document is not active.",
      );
    }
    this.historyInProgress.set(documentUri, commandInvocationId);
    let snapshot: DocumentSnapshot;
    try {
      await vscode.commands.executeCommand(command);
      snapshot = await this.readDocument(documentUri);
    } finally {
      this.historyInProgress.delete(documentUri);
    }
    this.diagnostics.record("port.history.result", {
      activeCustomEditor: isActiveCustomEditorDocument(documentUri),
      command,
      commandInvocationId,
      dirty: document.isDirty,
      documentUri,
      afterDocumentVersion: snapshot.documentVersion,
      textFingerprint: textFingerprint(snapshot.text),
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
  readonly causalId: string;
  applyEditSettled: boolean;
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
