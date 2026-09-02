import assert from "node:assert/strict";
import { TextDecoder, TextEncoder } from "node:util";
import * as vscode from "vscode";

import {
  DocumentSyncCoordinator,
  type DocumentPortResult,
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
const COMPOSITION_GROUPING_FILE_NAME = "extension-host-composition-grouping.md";
const SAVE_PROBE_FILE_NAME = "extension-host-save-probe.md";
const OWN_CHANGE_FILE_NAME = "extension-host-own-change.md";

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
  await verifyWorkspaceEditUndoGrouping(workspaceFolder.uri);
  await verifySaveSemantics(workspaceFolder.uri);
  await verifyOwnChangeClassification(workspaceFolder.uri);
}

async function verifyOwnChangeClassification(workspaceUri: vscode.Uri): Promise<void> {
  const documentUri = vscode.Uri.joinPath(workspaceUri, OWN_CHANGE_FILE_NAME);
  await removeSmokeFile(documentUri);

  try {
    await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode("before"));
    const document = await vscode.workspace.openTextDocument(documentUri);
    const port = new VscodeDocumentPort();
    const classifications: ("own" | "external")[] = [];
    const subscription = vscode.workspace.onDidChangeTextDocument((event): void => {
      if (event.document.uri.toString() === documentUri.toString()) {
        classifications.push(port.classifyDocumentChange(event));
      }
    });

    try {
      assertPortApplied(
        await port.replaceDocument(documentUri.toString(), document.version, "owned"),
        "Port-owned WorkspaceEdit was rejected.",
      );
      await replaceWholeDocument(document, documentUri, "external");
    } finally {
      subscription.dispose();
    }

    assert.equal(
      classifications.filter((classification) => classification === "own").length,
      1,
      "Only the exact port replacement may be classified as own.",
    );
    assert.equal(
      classifications.at(-1),
      "external",
      "A later external WorkspaceEdit was incorrectly suppressed as own.",
    );
  } finally {
    await removeSmokeFile(documentUri);
  }
}

async function verifyWorkspaceEditUndoGrouping(workspaceUri: vscode.Uri): Promise<void> {
  const variants: readonly UndoGroupingVariant[] = [
    { name: "consecutive", betweenEdits: (): Promise<void> => Promise.resolve() },
    {
      name: "acknowledged-change",
      betweenEdits: async (changeAfterFirstEdit): Promise<void> => {
        assert.ok(changeAfterFirstEdit, "The change acknowledgement probe was not prepared.");
        await changeAfterFirstEdit;
      },
    },
    { name: "microtask", betweenEdits: async (): Promise<void> => Promise.resolve() },
  ];

  for (const variant of variants) {
    const documentUri = vscode.Uri.joinPath(
      workspaceUri,
      `extension-host-workspace-edit-undo-${variant.name}.md`,
    );
    await removeSmokeFile(documentUri);

    try {
      await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode("X"));
      const document = await vscode.workspace.openTextDocument(documentUri);
      const changeAfterFirstEdit =
        variant.name === "acknowledged-change"
          ? waitForDocumentChange(documentUri, document.version)
          : undefined;
      await replaceWholeDocument(document, documentUri, "XA");
      await variant.betweenEdits(changeAfterFirstEdit);
      await replaceWholeDocument(document, documentUri, "XAB");

      await vscode.commands.executeCommand("vscode.openWith", documentUri, VIEW_TYPE);
      assertCustomEditorOpened(documentUri);
      assert.equal(
        vscode.window.visibleTextEditors.some(
          (editor) => editor.document.uri.toString() === documentUri.toString(),
        ),
        false,
        "A custom editor must not depend on a visible TextEditor for undo stops.",
      );

      const port = new VscodeDocumentPort();
      assertPortApplied(
        await port.undoDocument(documentUri.toString()),
        "WorkspaceEdit Undo was rejected.",
      );
      assert.equal(
        document.getText(),
        "XA",
        `WorkspaceEdit variant '${variant.name}' did not keep adjacent authoritative edits as separate Undo units.`,
      );
      assertPortApplied(
        await port.redoDocument(documentUri.toString()),
        "WorkspaceEdit Redo was rejected.",
      );
      assert.equal(document.getText(), "XAB", "Redo did not restore both authoritative edits.");
    } finally {
      await removeSmokeFile(documentUri);
    }
  }

  await verifySeparateCompositionCommitsFollowHostGrouping(workspaceUri);
}

interface UndoGroupingVariant {
  readonly name: string;
  readonly betweenEdits: (changeAfterFirstEdit: Promise<void> | undefined) => Promise<void>;
}

async function verifySeparateCompositionCommitsFollowHostGrouping(
  workspaceUri: vscode.Uri,
): Promise<void> {
  const documentUri = vscode.Uri.joinPath(workspaceUri, COMPOSITION_GROUPING_FILE_NAME);
  await removeSmokeFile(documentUri);

  try {
    await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode("X"));
    const document = await vscode.workspace.openTextDocument(documentUri);
    const coordinator = new DocumentSyncCoordinator(new VscodeDocumentPort());
    const endpoint = new RecordingEndpoint();
    const opened = await coordinator.openSession(
      documentUri.toString(),
      "composition-grouping",
      endpoint,
    );
    assert.ok(opened.ok, "Composition grouping session did not open.");

    await coordinator.receive(
      fullReplacementMessage(
        documentUri.toString(),
        "composition-grouping",
        1,
        opened.snapshot.documentVersion,
        opened.snapshot.text,
        "Xあいう",
      ),
      endpoint,
    );
    const firstCommit = endpoint.messages.find(isEditAcknowledgement);
    assert.ok(firstCommit, "The first composition-equivalent commit was not acknowledged.");

    await coordinator.receive(
      fullReplacementMessage(
        documentUri.toString(),
        "composition-grouping",
        2,
        firstCommit.documentVersion,
        firstCommit.text,
        "Xあいうかきく",
      ),
      endpoint,
    );
    assert.equal(
      document.getText(),
      "Xあいうかきく",
      "The second composition-equivalent edit failed.",
    );

    await vscode.commands.executeCommand("vscode.openWith", documentUri, VIEW_TYPE);
    assertCustomEditorOpened(documentUri);
    await coordinator.receive(
      barrierMessage(documentUri.toString(), "composition-grouping", "undo", 3),
      endpoint,
    );
    assert.equal(
      document.getText(),
      "Xあいう",
      "Separate composition-equivalent WorkspaceEdits did not remain separate Undo units.",
    );
    await coordinator.receive(
      barrierMessage(documentUri.toString(), "composition-grouping", "redo", 4),
      endpoint,
    );
    assert.equal(
      document.getText(),
      "Xあいうかきく",
      "Redo did not restore both composition commits.",
    );
  } finally {
    await removeSmokeFile(documentUri);
  }
}

async function verifySaveSemantics(workspaceUri: vscode.Uri): Promise<void> {
  const documentUri = vscode.Uri.joinPath(workspaceUri, SAVE_PROBE_FILE_NAME);
  await removeSmokeFile(documentUri);

  try {
    await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode("base"));
    const document = await vscode.workspace.openTextDocument(documentUri);
    await vscode.commands.executeCommand("vscode.openWith", documentUri, VIEW_TYPE);
    assertCustomEditorOpened(documentUri);
    const port = new VscodeDocumentPort();

    assert.equal(
      document.isDirty,
      false,
      "The clean Save probe fixture unexpectedly started dirty.",
    );
    assertPortApplied(await port.saveDocument(documentUri.toString()), "Clean Save was rejected.");
    await replaceWholeDocument(document, documentUri, "dirty");
    assert.equal(document.isDirty, true, "WorkspaceEdit did not make the Save probe dirty.");
    assertPortApplied(await port.saveDocument(documentUri.toString()), "Dirty Save was rejected.");
    assert.equal(document.isDirty, false, "Dirty Save did not make the document clean.");
    assert.equal(
      await readDiskText(documentUri),
      "dirty",
      "Dirty Save did not persist the document.",
    );

    assertPortApplied(
      await port.saveDocument(documentUri.toString()),
      "Repeated Save after the document became clean was rejected.",
    );
    assert.equal(document.isDirty, false, "Repeated Save changed the clean document state.");
    assert.equal(await readDiskText(documentUri), "dirty", "Repeated Save changed persisted text.");

    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    const opened = await coordinator.openSession(
      documentUri.toString(),
      "save-after-commit",
      endpoint,
    );
    assert.ok(opened.ok, "Immediate Save session did not open.");
    await coordinator.receive(
      fullReplacementMessage(
        documentUri.toString(),
        "save-after-commit",
        1,
        opened.snapshot.documentVersion,
        opened.snapshot.text,
        "dirtyかきく",
      ),
      endpoint,
    );
    await coordinator.receive(
      barrierMessage(documentUri.toString(), "save-after-commit", "save", 2),
      endpoint,
    );
    assert.equal(
      endpoint.messages.some((message) => message.kind === "resync"),
      false,
      "Immediate Save after a composition-equivalent final edit entered recovery.",
    );
    assert.equal(document.isDirty, false, "Immediate Save left the document dirty.");
    assert.equal(
      await readDiskText(documentUri),
      "dirtyかきく",
      "Immediate Save did not persist the final authoritative composition text.",
    );
  } finally {
    await removeSmokeFile(documentUri);
  }
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
  kind: "save" | "undo" | "redo",
  sequence: number,
): {
  readonly kind: "save" | "undo" | "redo";
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

async function replaceWholeDocument(
  document: vscode.TextDocument,
  documentUri: vscode.Uri,
  text: string,
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(documentUri, fullDocumentRange(document), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true, "WorkspaceEdit was rejected.");
}

function waitForDocumentChange(documentUri: vscode.Uri, priorVersion: number): Promise<void> {
  return new Promise((resolve): void => {
    const subscription = vscode.workspace.onDidChangeTextDocument((event): void => {
      if (
        event.document.uri.toString() === documentUri.toString() &&
        event.document.version > priorVersion
      ) {
        subscription.dispose();
        resolve();
      }
    });
  });
}

function assertPortApplied(result: DocumentPortResult, message: string): void {
  assert.equal(
    result.kind,
    "applied",
    result.kind === "rejected" ? `${message} ${result.note}` : message,
  );
}

function isEditAcknowledgement(
  message: HostToWebviewMessage,
): message is Extract<HostToWebviewMessage, { readonly kind: "operation-ack" }> {
  return message.kind === "operation-ack" && message.operation === "edit";
}

async function readDiskText(documentUri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(documentUri));
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
