import * as vscode from "vscode";

import { PROJECT_IDENTITY } from "../core/projectIdentity.js";

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    "vscodeMarkdownLiveEditor.showProjectInfo",
    async (): Promise<void> => {
      await vscode.window.showInformationMessage(
        `${PROJECT_IDENTITY.displayName}: project scaffold is ready.`,
      );
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // No global resources are retained by the scaffold.
}
