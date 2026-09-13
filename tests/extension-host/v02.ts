import assert from "node:assert/strict";
import { TextDecoder, TextEncoder } from "node:util";
import * as vscode from "vscode";

import {
  changeTableColumn,
  findTables,
  type SourceEdit,
} from "../../src/core/markdown/tableSource.js";
import {
  DocumentSyncCoordinator,
  type WebviewEndpoint,
} from "../../src/core/sync/documentSyncCoordinator.js";
import { PROTOCOL_VERSION, type HostToWebviewMessage } from "../../src/protocol/messages.js";
import { VscodeDocumentPort } from "../../src/extension/sync/VscodeDocumentPort.js";
import { verifyV02Interaction } from "./v02Interaction.js";
import { verifyV02ImageLifecycle } from "./v02ImageLifecycle.js";

const VIEW_TYPE = "vscodeMarkdownLiveEditor.editor";
const EXTENSION_ID = "zcw.vscode-markdown-live-editor";
const SESSION_ID = "v02-text-document";
const CONTROLLER_ID = "v02-text-document-controller";

/**
 * Automated TextDocument boundary evidence only. It exercises the source
 * transformations through the normal host queue, not webview or Human UI.
 */
export async function run(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "The v0.2 fixture workspace was not opened.");
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension '${EXTENSION_ID}' was not found.`);
  await extension.activate();
  if (process.env["V02_INTERACTION_ONLY"] === "1") {
    await verifyV02Interaction(workspaceFolder.uri);
    return;
  }
  await verifyV02TextDocumentBoundary(workspaceFolder.uri);
  await verifyV02Interaction(workspaceFolder.uri);
  await verifyV02ImageLifecycle(workspaceFolder.uri);
}

export async function verifyV02TextDocumentBoundary(workspaceUri: vscode.Uri): Promise<void> {
  const initial = [
    "# Heading",
    "| Name | Value |",
    "| --- | --- |",
    "| alpha | needle |",
    "",
    "[guide](other.md)",
    "",
  ].join("\n");
  const table = findTables(initial)[0];
  assert.ok(table, "The v0.2 fixture did not contain a parser-recognized table.");
  const tableExpanded = applyEdits(initial, changeTableColumn(initial, table, 1, false));
  const imageInserted = `${tableExpanded}![diagram](attachments/diagram.png)\n`;
  const replacementsApplied = imageInserted.replaceAll("needle", "match");
  const linkFragmentApplied = replacementsApplied.replace("other.md", "other.md#target");
  const headingParagraphApplied = linkFragmentApplied.replace("# Heading\n", "# Heading\n\n");
  const states = [
    initial,
    tableExpanded,
    imageInserted,
    replacementsApplied,
    linkFragmentApplied,
    headingParagraphApplied,
  ] as const;

  for (const lineEnding of ["lf", "crlf"] as const) {
    const documentUri = vscode.Uri.joinPath(
      workspaceUri,
      `extension-host-v02-text-document-${lineEnding}.md`,
    );
    await verifyLineEnding(documentUri, lineEnding, states);
  }
}

async function verifyLineEnding(
  documentUri: vscode.Uri,
  lineEnding: "lf" | "crlf",
  states: readonly [string, string, string, string, string, string],
): Promise<void> {
  const initial = states[0];
  await vscode.workspace.fs.writeFile(
    documentUri,
    new TextEncoder().encode(nativeText(initial, lineEnding)),
  );
  const document = await vscode.workspace.openTextDocument(documentUri);
  assert.equal(
    document.eol,
    lineEnding === "crlf" ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF,
    `The ${lineEnding} fixture opened with an unexpected EOL.`,
  );

  const endpoint = new RecordingEndpoint();
  const coordinator = new DocumentSyncCoordinator(new VscodeDocumentPort());
  const opened = await coordinator.openSession(documentUri.toString(), SESSION_ID, endpoint);
  assert.ok(opened.ok, `The ${lineEnding} v0.2 session did not open.`);
  assert.equal(
    opened.snapshot.text,
    initial,
    `The ${lineEnding} initial snapshot was not canonical LF.`,
  );

  try {
    let expectedProtocolText = opened.snapshot.text;
    for (const [index, next] of states.slice(1).entries()) {
      const sequence = index + 1;
      await coordinator.receive(
        fullReplacementMessage(
          documentUri.toString(),
          sequence,
          document.version,
          expectedProtocolText,
          next,
        ),
        endpoint,
      );
      await coordinator.flush(documentUri.toString());
      const acknowledgement = acknowledgementFor(endpoint, sequence, "edit");
      assert.equal(
        acknowledgement.text,
        next,
        `F${String(sequence)} did not acknowledge canonical source.`,
      );
      assert.equal(
        document.getText(),
        nativeText(next, lineEnding),
        `F${String(sequence)} did not preserve the ${lineEnding} TextDocument projection.`,
      );
      expectedProtocolText = next;
    }

    await coordinator.receive(barrierMessage(documentUri.toString(), "save", 6), endpoint);
    await coordinator.flush(documentUri.toString());
    assert.equal(acknowledgementFor(endpoint, 6, "save").text, expectedProtocolText);
    assert.equal(await document.save(), true, `The ${lineEnding} fixture did not save.`);
    assert.equal(
      new TextDecoder().decode(await vscode.workspace.fs.readFile(documentUri)),
      nativeText(expectedProtocolText, lineEnding),
      `Save did not persist the ${lineEnding} source projection.`,
    );

    await vscode.commands.executeCommand("vscode.openWith", documentUri, VIEW_TYPE);
    assertActiveCustomEditor(documentUri);
    for (let index = states.length - 2; index >= 0; index -= 1) {
      const sequence = 7 + (states.length - 2 - index);
      await coordinator.receive(barrierMessage(documentUri.toString(), "undo", sequence), endpoint);
      await coordinator.flush(documentUri.toString());
      const expected = states[index];
      assert.ok(expected !== undefined, "The expected Undo source is missing.");
      assert.equal(acknowledgementFor(endpoint, sequence, "undo").text, expected);
      assert.equal(
        document.getText(),
        nativeText(expected, lineEnding),
        "Undo changed the EOL projection.",
      );
    }
    for (let index = 1; index < states.length; index += 1) {
      const sequence = 11 + index;
      await coordinator.receive(barrierMessage(documentUri.toString(), "redo", sequence), endpoint);
      await coordinator.flush(documentUri.toString());
      const expected = states[index];
      assert.ok(expected !== undefined, "The expected Redo source is missing.");
      assert.equal(acknowledgementFor(endpoint, sequence, "redo").text, expected);
      assert.equal(
        document.getText(),
        nativeText(expected, lineEnding),
        "Redo changed the EOL projection.",
      );
    }
  } finally {
    coordinator.closeSession(documentUri.toString(), SESSION_ID);
    await closeCustomEditor(documentUri);
    await vscode.workspace.fs.delete(documentUri, { useTrash: false });
  }
}

function applyEdits(source: string, edits: readonly SourceEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((left, right) => right.from - left.from)) {
    result = `${result.slice(0, edit.from)}${edit.insert}${result.slice(edit.to ?? edit.from)}`;
  }
  return result;
}

function nativeText(text: string, lineEnding: "lf" | "crlf"): string {
  return lineEnding === "crlf" ? text.replaceAll("\n", "\r\n") : text;
}

function fullReplacementMessage(
  documentUri: string,
  sequence: number,
  documentVersion: number,
  expectedText: string,
  text: string,
): {
  readonly kind: "edit";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly documentUri: string;
  readonly sessionId: string;
  readonly controllerId: string;
  readonly sequence: number;
  readonly documentVersion: number;
  readonly changes: readonly [
    {
      readonly range: { readonly start: vscode.Position; readonly end: vscode.Position };
      readonly expectedText: string;
      readonly text: string;
    },
  ];
} {
  return {
    kind: "edit",
    protocolVersion: PROTOCOL_VERSION,
    documentUri,
    sessionId: SESSION_ID,
    controllerId: CONTROLLER_ID,
    sequence,
    documentVersion,
    changes: [
      {
        range: {
          start: new vscode.Position(0, 0),
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
  kind: "save" | "undo" | "redo",
  sequence: number,
): {
  readonly kind: "save" | "undo" | "redo";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly documentUri: string;
  readonly sessionId: string;
  readonly controllerId: string;
  readonly sequence: number;
} {
  return {
    kind,
    protocolVersion: PROTOCOL_VERSION,
    documentUri,
    sessionId: SESSION_ID,
    controllerId: CONTROLLER_ID,
    sequence,
  };
}

function positionAt(text: string, offset: number): vscode.Position {
  const prefix = text.slice(0, offset);
  const lastNewline = prefix.lastIndexOf("\n");
  return new vscode.Position(
    lastNewline === -1 ? 0 : prefix.split("\n").length - 1,
    offset - lastNewline - 1,
  );
}

function acknowledgementFor(
  endpoint: RecordingEndpoint,
  sequence: number,
  operation: "edit" | "save" | "undo" | "redo",
): Extract<HostToWebviewMessage, { readonly kind: "operation-ack" }> {
  const acknowledgement = endpoint.messages.find(
    (message): message is Extract<HostToWebviewMessage, { readonly kind: "operation-ack" }> =>
      message.kind === "operation-ack" &&
      message.sequence === sequence &&
      message.operation === operation,
  );
  assert.ok(
    acknowledgement,
    `No ${operation} acknowledgement was recorded for sequence ${String(sequence)}.`,
  );
  return acknowledgement;
}

class RecordingEndpoint implements WebviewEndpoint {
  public readonly messages: HostToWebviewMessage[] = [];
  public postMessage(message: HostToWebviewMessage): void {
    this.messages.push(message);
  }
}

function assertActiveCustomEditor(documentUri: vscode.Uri): void {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(
    input instanceof vscode.TabInputCustom,
    "The v0.2 fixture did not open in the custom editor.",
  );
  assert.equal(
    input.uri.toString(),
    documentUri.toString(),
    "The active custom editor opened another document.",
  );
}

async function closeCustomEditor(documentUri: vscode.Uri): Promise<void> {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.uri.toString() === documentUri.toString()) {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }
}
