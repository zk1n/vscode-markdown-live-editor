import * as vscode from "vscode";

import type {
  CustomCssHost,
  CustomCssUri,
  CustomCssWatcher,
  CustomCssWorkspaceFolder,
} from "./customCss.js";

/** Public VS Code API adapter for the fixed trusted-workspace CSS boundary. */
export class VscodeCustomCssHost implements CustomCssHost {
  public isWorkspaceTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  public getWorkspaceFolder(documentUri: CustomCssUri): CustomCssWorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(asVscodeUri(documentUri));
  }

  public joinPath(base: CustomCssUri, ...pathSegments: readonly string[]): CustomCssUri {
    return vscode.Uri.joinPath(asVscodeUri(base), ...pathSegments);
  }

  public readFile(uri: CustomCssUri): Promise<Uint8Array> {
    return Promise.resolve(vscode.workspace.fs.readFile(asVscodeUri(uri)));
  }

  public createWatcher(uri: CustomCssUri): CustomCssWatcher {
    const vscodeUri = asVscodeUri(uri);
    const folder = vscode.workspace.getWorkspaceFolder(vscodeUri);
    if (folder === undefined) {
      const register = (): vscode.Disposable => vscode.Disposable.from();
      return {
        onDidChange: register,
        onDidCreate: register,
        onDidDelete: register,
        dispose: (): void => undefined,
      };
    }
    return vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, ".vscode/markdown-live-editor.css"),
    );
  }

  public isFileNotFound(error: unknown): boolean {
    return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
  }
}

function asVscodeUri(uri: CustomCssUri): vscode.Uri {
  return vscode.Uri.parse(uri.toString(), true);
}
