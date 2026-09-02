import assert from "node:assert/strict";
import { TextDecoder, TextEncoder } from "node:util";
import * as vscode from "vscode";

import {
  DocumentSyncCoordinator,
  type WebviewEndpoint,
} from "../../src/core/sync/documentSyncCoordinator.js";
import { PROTOCOL_VERSION, type HostToWebviewMessage } from "../../src/protocol/messages.js";
import { VscodeDocumentPort } from "../../src/extension/sync/VscodeDocumentPort.js";

const COMMAND_ID = "vscodeMarkdownLiveEditor.showProjectInfo";
const VIEW_TYPE = "vscodeMarkdownLiveEditor.editor";
const EXTENSION_ID = "local-dev.vscode-markdown-live-editor";
const SMOKE_FILE_NAME = "extension-host-smoke.md";
const FIRST_EDIT_FILE_NAME = "extension-host-first-edit.md";
const FIRST_EDIT_LF_FILE_NAME = "extension-host-first-edit-lf.md";
const COMPOSITION_HISTORY_FILE_NAME = "extension-host-composition-history.md";

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

  await verifyFirstEditProtocolPath(workspaceFolder.uri);
  await verifyCompositionHistoryPath(workspaceFolder.uri);
}

async function verifyCompositionHistoryPath(workspaceUri: vscode.Uri): Promise<void> {
  const documentUri = vscode.Uri.joinPath(workspaceUri, COMPOSITION_HISTORY_FILE_NAME);
  await removeSmokeFile(documentUri);

  try {
    await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode("abc"));
    const document = await vscode.workspace.openTextDocument(documentUri);
    const coordinator = new DocumentSyncCoordinator(new VscodeDocumentPort());
    const endpoint = new RecordingEndpoint();
    const opened = await coordinator.openSession(
      documentUri.toString(),
      "composition-history",
      endpoint,
    );
    assert.ok(opened.ok, "Composition history session did not open.");

    await coordinator.receive(
      fullReplacementMessage(
        documentUri.toString(),
        "composition-history",
        1,
        opened.snapshot.documentVersion,
        opened.snapshot.text,
        "abcかきく",
      ),
      endpoint,
    );
    assert.equal(document.getText(), "abcかきく", "Final composition commit did not apply.");

    await vscode.commands.executeCommand("vscode.openWith", documentUri, VIEW_TYPE);
    assertCustomEditorOpened(documentUri);

    await coordinator.receive(
      barrierMessage(documentUri.toString(), "composition-history", "undo", 2),
      endpoint,
    );
    assert.equal(
      document.getText(),
      "abc",
      "Undo did not revert the composition final commit as one unit.",
    );

    await coordinator.receive(
      barrierMessage(documentUri.toString(), "composition-history", "redo", 3),
      endpoint,
    );
    assert.equal(
      document.getText(),
      "abcかきく",
      "Redo did not restore the composition final commit.",
    );
    assert.equal(
      endpoint.messages.some((message) => message.kind === "resync"),
      false,
      "Composition history path unexpectedly entered recovery.",
    );
  } finally {
    await removeSmokeFile(documentUri);
  }
}

async function verifyFirstEditProtocolPath(workspaceUri: vscode.Uri): Promise<void> {
  await verifyProtocolFirstEdit(workspaceUri, {
    fileName: FIRST_EDIT_FILE_NAME,
    initialDocumentText: "abc\r\n",
    requestedProtocolText: "aXbc\n",
    expectedDocumentText: "aXbc\r\n",
  });
  await verifyProtocolFirstEdit(workspaceUri, {
    fileName: FIRST_EDIT_LF_FILE_NAME,
    initialDocumentText: "abc",
    requestedProtocolText: "aXbc",
    expectedDocumentText: "aXbc",
  });
}

interface FirstEditScenario {
  readonly fileName: string;
  readonly initialDocumentText: string;
  readonly requestedProtocolText: string;
  readonly expectedDocumentText: string;
}

async function verifyProtocolFirstEdit(
  workspaceUri: vscode.Uri,
  scenario: FirstEditScenario,
): Promise<void> {
  const documentUri = vscode.Uri.joinPath(workspaceUri, scenario.fileName);
  await removeSmokeFile(documentUri);

  try {
    await vscode.workspace.fs.writeFile(
      documentUri,
      new TextEncoder().encode(scenario.initialDocumentText),
    );
    const document = await vscode.workspace.openTextDocument(documentUri);
    const coordinator = new DocumentSyncCoordinator(new VscodeDocumentPort());
    const endpoint = new RecordingEndpoint();
    const observedChanges: vscode.TextDocumentChangeEvent[] = [];
    const changeSubscription = vscode.workspace.onDidChangeTextDocument((event): void => {
      if (event.document.uri.toString() === documentUri.toString()) {
        observedChanges.push(event);
        void coordinator.publishExternalChange(documentUri.toString());
      }
    });

    try {
      const opened = await coordinator.openSession(documentUri.toString(), "first-edit", endpoint);
      assert.ok(opened.ok, "Initial document session did not open.");

      await coordinator.receive(
        {
          kind: "edit",
          protocolVersion: PROTOCOL_VERSION,
          documentUri: documentUri.toString(),
          sessionId: "first-edit",
          sequence: 1,
          documentVersion: opened.snapshot.documentVersion,
          changes: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: positionAt(opened.snapshot.text, opened.snapshot.text.length),
              },
              expectedText: opened.snapshot.text,
              text: scenario.requestedProtocolText,
            },
          ],
        },
        endpoint,
      );
      await coordinator.flush(documentUri.toString());
    } finally {
      changeSubscription.dispose();
    }

    const resync = endpoint.messages.find((message) => message.kind === "resync");
    assert.equal(
      resync,
      undefined,
      diagnostic(
        "First edit unexpectedly entered recovery.",
        document,
        scenario.requestedProtocolText,
      ),
    );
    assert.ok(
      endpoint.messages.some(
        (message) =>
          message.kind === "operation-ack" &&
          message.operation === "edit" &&
          message.text === scenario.requestedProtocolText,
      ),
      "The protocol acknowledgement did not use canonical LF text.",
    );
    assert.ok(
      observedChanges.length > 0,
      "The first edit did not emit a TextDocument change event.",
    );
    assert.equal(
      document.getText(),
      scenario.expectedDocumentText,
      diagnostic(
        "First edit did not preserve the document EOL projection.",
        document,
        scenario.expectedDocumentText,
      ),
    );
    assert.equal(await document.save(), true, "The first edit did not save.");
    assert.equal(
      new TextDecoder().decode(await vscode.workspace.fs.readFile(documentUri)),
      scenario.expectedDocumentText,
      "Disk text differs from the authoritative TextDocument after the first edit.",
    );
  } finally {
    await removeSmokeFile(documentUri);
  }
}

class RecordingEndpoint implements WebviewEndpoint {
  public readonly messages: HostToWebviewMessage[] = [];

  public postMessage(message: HostToWebviewMessage): void {
    this.messages.push(message);
  }
}

function positionAt(
  text: string,
  offset: number,
): { readonly line: number; readonly character: number } {
  const prefix = text.slice(0, offset);
  const lastNewline = prefix.lastIndexOf("\n");
  return {
    line: lastNewline === -1 ? 0 : prefix.split("\n").length - 1,
    character: offset - lastNewline - 1,
  };
}

function fullReplacementMessage(
  documentUri: string,
  sessionId: string,
  sequence: number,
  documentVersion: number,
  expectedText: string,
  text: string,
): {
  readonly kind: "edit";
  readonly protocolVersion: 1;
  readonly documentUri: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly documentVersion: number;
  readonly changes: readonly [
    {
      readonly range: {
        readonly start: { readonly line: number; readonly character: number };
        readonly end: { readonly line: number; readonly character: number };
      };
      readonly expectedText: string;
      readonly text: string;
    },
  ];
} {
  return {
    kind: "edit",
    protocolVersion: PROTOCOL_VERSION,
    documentUri,
    sessionId,
    sequence,
    documentVersion,
    changes: [
      {
        range: {
          start: { line: 0, character: 0 },
          end: positionAt(expectedText, expectedText.length),
        },
        expectedText,
        text,
      },
    ],
  };
}

function barrierMessage(
  documentUri: string,
  sessionId: string,
  kind: "undo" | "redo",
  sequence: number,
): {
  readonly kind: "undo" | "redo";
  readonly protocolVersion: 1;
  readonly documentUri: string;
  readonly sessionId: string;
  readonly sequence: number;
} {
  return { kind, protocolVersion: PROTOCOL_VERSION, documentUri, sessionId, sequence };
}

function diagnostic(label: string, document: vscode.TextDocument, expectedText: string): string {
  const actualText = document.getText();
  return `${label} expected=${JSON.stringify(expectedText)} actual=${JSON.stringify(actualText)} eol=${document.eol === vscode.EndOfLine.CRLF ? "CRLF" : "LF"}`;
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
