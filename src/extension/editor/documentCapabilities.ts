import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import * as vscode from "vscode";

export interface DocumentWriteCapability {
  readonly writable: boolean;
  readonly reason?: string;
}

/**
 * Checks only stable write signals for the current TextDocument.  Resource
 * operations call this again immediately before creating an attachment.
 */
export async function getDocumentWriteCapability(
  document: vscode.TextDocument,
): Promise<DocumentWriteCapability> {
  if (document.isUntitled) return { writable: true };

  const providerWritable = vscode.workspace.fs.isWritableFileSystem(document.uri.scheme);
  if (providerWritable === false)
    return { writable: false, reason: "この文書のファイルシステムは読み取り専用です。" };

  let metadata: vscode.FileStat;
  try {
    metadata = await vscode.workspace.fs.stat(document.uri);
  } catch {
    return { writable: false, reason: "この文書の書き込み可否を確認できませんでした。" };
  }
  if ((metadata.permissions ?? 0) & vscode.FilePermission.Readonly)
    return { writable: false, reason: "この文書は読み取り専用です。" };

  if (document.uri.scheme !== "file") {
    if (providerWritable === true) return { writable: true };
    return { writable: false, reason: "この文書の書き込み可否を確認できませんでした。" };
  }

  try {
    const nodeStat = await stat(document.uri.fsPath);
    if ((nodeStat.mode & 0o222) === 0)
      return { writable: false, reason: "この文書は読み取り専用です。" };
    await access(document.uri.fsPath, constants.W_OK);
  } catch {
    return { writable: false, reason: "この文書へ書き込めません。" };
  }
  return { writable: true };
}
