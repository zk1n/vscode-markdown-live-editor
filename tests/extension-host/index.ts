import assert from "node:assert/strict";
import { TextDecoder, TextEncoder } from "node:util";
import * as vscode from "vscode";

const COMMAND_ID = "vscodeMarkdownLiveEditor.showProjectInfo";
const VIEW_TYPE = "vscodeMarkdownLiveEditor.editor";
const EXTENSION_ID = "local-dev.vscode-markdown-live-editor";
const SMOKE_FILE_NAME = "extension-host-smoke.md";

export async function run(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "The smoke-test fixture workspace was not opened.");

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension '${EXTENSION_ID}' was not found.`);
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes(COMMAND_ID), `Command '${COMMAND_ID}' was not registered.`);

  const documentUri = vscode.Uri.joinPath(workspaceFolder.uri, SMOKE_FILE_NAME);
  await removeSmokeFile(documentUri);

  try {
    const initialText = "# Extension Host smoke\n";
    const expectedText = "# Extension Host smoke\n\nWorkspaceEdit was saved.\n";
    await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode(initialText));

    const document = await vscode.workspace.openTextDocument(documentUri);
    const observedChanges: vscode.TextDocumentChangeEvent[] = [];
    const documentChangeSubscription = vscode.workspace.onDidChangeTextDocument((event): void => {
      if (event.document.uri.toString() === documentUri.toString()) {
        observedChanges.push(event);
      }
    });

    try {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(documentUri, fullDocumentRange(document), expectedText);
      assert.equal(await vscode.workspace.applyEdit(edit), true, "WorkspaceEdit was rejected.");
    } finally {
      documentChangeSubscription.dispose();
    }

    assert.ok(observedChanges.length > 0, "No TextDocument change event was observed.");
    assert.equal(
      document.getText(),
      expectedText,
      "WorkspaceEdit did not update the TextDocument.",
    );
    assert.equal(await document.save(), true, "TextDocument.save() did not complete.");

    const savedText = new TextDecoder().decode(await vscode.workspace.fs.readFile(documentUri));
    assert.equal(savedText, expectedText, "Saved fixture content differs from the TextDocument.");

    await vscode.commands.executeCommand("vscode.openWith", documentUri, VIEW_TYPE);
    assertCustomEditorOpened(documentUri);
  } finally {
    await removeSmokeFile(documentUri);
  }
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

function assertCustomEditorOpened(documentUri: vscode.Uri): void {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(activeTab, "No active tab was available after vscode.openWith.");
  assert.ok(
    activeTab.input instanceof vscode.TabInputCustom,
    "The active tab is not a custom editor.",
  );
  assert.equal(activeTab.input.viewType, VIEW_TYPE, "The custom editor view type is incorrect.");
  assert.equal(
    activeTab.input.uri.toString(),
    documentUri.toString(),
    "The custom editor opened another document.",
  );
}

async function removeSmokeFile(documentUri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(documentUri, { useTrash: false });
  } catch {
    // The fixture starts clean when no previous run left a smoke file behind.
  }
}
