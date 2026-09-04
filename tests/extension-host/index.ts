import assert from "node:assert/strict";
import { TextDecoder, TextEncoder } from "node:util";
import * as prettier from "prettier";
import * as vscode from "vscode";

import {
  DocumentSyncCoordinator,
  type DocumentPortResult,
  type WebviewEndpoint,
} from "../../src/core/sync/documentSyncCoordinator.js";
import { BoundedDiagnosticLog } from "../../src/core/diagnostics/diagnosticLog.js";
import { textFingerprint } from "../../src/core/diagnostics/textFingerprint.js";
import { createDocumentChangeHandler } from "../../src/extension/extension.js";
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
const MIXED_LIST_SAVE_PROBE_FILE_NAME = "extension-host-mixed-list-save-probe.md";
const OWN_CHANGE_FILE_NAME = "extension-host-own-change.md";
const PRODUCTION_LISTENER_FILE_NAME = "extension-host-production-listener.md";

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
  await verifyMixedListSaveParticipantSemantics(workspaceFolder.uri);
  await verifyOwnChangeClassification(workspaceFolder.uri);
  await verifyProductionDocumentChangeListener(workspaceFolder.uri);
}

async function verifyProductionDocumentChangeListener(workspaceUri: vscode.Uri): Promise<void> {
  const documentUri = vscode.Uri.joinPath(workspaceUri, PRODUCTION_LISTENER_FILE_NAME);
  await removeSmokeFile(documentUri);

  try {
    await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode("- \r\n"));
    const document = await vscode.workspace.openTextDocument(documentUri);
    const diagnostics = new BoundedDiagnosticLog();
    const port = new VscodeDocumentPort(diagnostics);
    const coordinator = new DocumentSyncCoordinator(port, diagnostics);
    const endpoint = new RecordingEndpoint();
    const opened = await coordinator.openSession(
      documentUri.toString(),
      "production-listener",
      endpoint,
    );
    assert.ok(opened.ok, "Production-listener session did not open.");
    const listener = createDocumentChangeHandler(port, coordinator, diagnostics);
    const subscription = vscode.workspace.onDidChangeTextDocument(listener);
    try {
      await coordinator.receive(
        fullReplacementMessage(
          documentUri.toString(),
          "production-listener",
          1,
          opened.snapshot.documentVersion,
          opened.snapshot.text,
          "- 日本\n",
        ),
        endpoint,
      );
      await coordinator.flush(documentUri.toString());
    } finally {
      subscription.dispose();
    }

    assert.equal(document.getText(), "- 日本\r\n", "Production listener changed source text.");
    const acknowledgement = endpoint.messages.find(
      (message): message is Extract<HostToWebviewMessage, { readonly kind: "operation-ack" }> =>
        message.kind === "operation-ack" && message.sequence === 1,
    );
    assert.ok(acknowledgement, "Origin did not receive its exact edit acknowledgement.");
    assert.match(
      String(acknowledgement.correlation?.causalId),
      /^operation:production-listener:1$/,
      "ACK lacks operation correlation.",
    );
    const trace = diagnostics.copyText();
    assert.match(trace, /extension\.document\.changed/, "Production listener was not invoked.");
    assert.match(trace, /eventId="document-change-/, "Listener event ID was not recorded.");
    assert.match(trace, /coordinator\.queue\.enqueued/, "Queue correlation was not recorded.");
    assert.equal(
      trace.includes("日本"),
      false,
      "Diagnostic metadata must not contain source text.",
    );
  } finally {
    await removeSmokeFile(documentUri);
  }
}

async function verifyOwnChangeClassification(workspaceUri: vscode.Uri): Promise<void> {
  const documentUri = vscode.Uri.joinPath(workspaceUri, OWN_CHANGE_FILE_NAME);
  await removeSmokeFile(documentUri);

  try {
    // Use a CRLF fixture to prove that the classifier compares protocol LF
    // with the native event's CRLF replacement at the adapter boundary.
    await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode("before\r\n"));
    const document = await vscode.workspace.openTextDocument(documentUri);
    const classificationDiagnostics: Readonly<
      Record<string, boolean | number | string | undefined>
    >[] = [];
    const port = new VscodeDocumentPort({
      record: (kind, details): void => {
        if (kind === "port.document-change.classified") {
          classificationDiagnostics.push(details);
        }
      },
    });
    const observations: {
      readonly classification: "own" | "external";
      readonly contentChangeCount: number;
      readonly documentText: string;
      readonly documentVersion: number;
      readonly replacementText: string | undefined;
      readonly replacePromiseSettled: boolean;
    }[] = [];
    let replacePromiseSettled = false;
    const subscription = vscode.workspace.onDidChangeTextDocument((event): void => {
      if (event.document.uri.toString() === documentUri.toString()) {
        observations.push({
          classification: port.classifyDocumentChange(event),
          contentChangeCount: event.contentChanges.length,
          documentText: event.document.getText(),
          documentVersion: event.document.version,
          replacementText: event.contentChanges[0]?.text,
          // The event is delivered before replaceDocument's promise settles;
          // this is the timing window in which the pending target is valid.
          replacePromiseSettled,
        });
      }
    });

    try {
      const expectedVersion = document.version;
      const replacement = port.replaceDocument(documentUri.toString(), expectedVersion, "owned\n");
      assertPortApplied(await replacement, "Port-owned WorkspaceEdit was rejected.");
      replacePromiseSettled = true;
      await replaceWholeDocument(document, documentUri, "external\n");
    } finally {
      subscription.dispose();
    }

    assert.equal(
      observations.filter(({ classification }) => classification === "own").length,
      1,
      "Only the exact port replacement may be classified as own.",
    );
    assert.deepEqual(
      observations[0],
      {
        classification: "own",
        contentChangeCount: 1,
        documentText: "owned\r\n",
        documentVersion: 2,
        replacementText: "owned\r\n",
        replacePromiseSettled: false,
      },
      "The port-owned event did not match the exact version, target, replacement, and timing contract.",
    );
    assert.deepEqual(
      classificationDiagnostics.map(
        ({
          classification,
          contentChangeCount,
          pendingExpectedVersion,
          replacementMatches,
          targetMatches,
          versionMatches,
        }) => ({
          classification,
          contentChangeCount,
          pendingExpectedVersion,
          replacementMatches,
          targetMatches,
          versionMatches,
        }),
      ),
      [
        {
          classification: "own",
          contentChangeCount: 1,
          pendingExpectedVersion: 1,
          replacementMatches: true,
          targetMatches: true,
          versionMatches: true,
        },
        {
          classification: "external",
          contentChangeCount: 0,
          pendingExpectedVersion: 1,
          replacementMatches: false,
          targetMatches: true,
          versionMatches: true,
        },
        {
          classification: "external",
          contentChangeCount: 1,
          pendingExpectedVersion: -1,
          replacementMatches: false,
          targetMatches: false,
          versionMatches: false,
        },
      ],
      "Classification diagnostics did not expose the expected pending/version/target/replacement checks.",
    );
    assert.equal(
      observations.at(-1)?.classification,
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
    const historyClassificationDiagnostics: Readonly<
      Record<string, boolean | number | string | undefined>
    >[] = [];
    const port = new VscodeDocumentPort({
      record: (kind, details): void => {
        if (kind === "port.document-change.classified") {
          historyClassificationDiagnostics.push(details);
        }
      },
    });
    const coordinator = new DocumentSyncCoordinator(port);
    const endpoint = new RecordingEndpoint();
    const opened = await coordinator.openSession(
      documentUri.toString(),
      "composition-grouping",
      endpoint,
    );
    assert.ok(opened.ok, "Composition grouping session did not open.");
    // Mirror the extension integration listener so this probe can observe
    // whether a history event is classified external and queued as a second
    // snapshot on the same coordinator/session.
    const classificationTrace: {
      readonly classification: "own" | "external";
      readonly contentChangeCount: number;
      readonly documentVersion: number;
      readonly text: string;
      readonly replacementText: string | undefined;
    }[] = [];
    const documentChangeSubscription = vscode.workspace.onDidChangeTextDocument((event): void => {
      if (event.document.uri.toString() === documentUri.toString()) {
        const classification = port.classifyDocumentChange(event);
        classificationTrace.push({
          classification,
          contentChangeCount: event.contentChanges.length,
          documentVersion: event.document.version,
          replacementText: event.contentChanges[0]?.text,
          text: event.document.getText(),
        });
        if (classification === "external") {
          void coordinator.publishExternalChange(documentUri.toString());
        }
      }
    });

    try {
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
      assert.deepEqual(
        classificationTrace
          .filter(({ classification }) => classification === "own")
          .map(({ text }) => text),
        ["Xあいう", "Xあいうかきく"],
        "The two port-owned WorkspaceEdits were not both classified own.",
      );

      await vscode.commands.executeCommand("vscode.openWith", documentUri, VIEW_TYPE);
      assertCustomEditorOpened(documentUri);
      const beforeUndoMessages = endpoint.messages.length;
      await coordinator.receive(
        barrierMessage(documentUri.toString(), "composition-grouping", "undo", 3),
        endpoint,
      );
      // The history command itself emits a TextDocument change while
      // historyInProgress is set. The current classifier intentionally keeps
      // that event external, so the extension listener queues a second
      // external snapshot after the barrier's own acknowledgement/broadcast.
      await coordinator.flush(documentUri.toString());
      const undoTrace = classificationTrace.at(-1);
      assert.deepEqual(
        undoTrace,
        {
          classification: "external",
          contentChangeCount: 1,
          documentVersion: document.version,
          replacementText: "Xあいう",
          text: "Xあいう",
        },
        "Undo was not observed as a single external history change while history was in progress.",
      );
      assert.match(
        String(historyClassificationDiagnostics.at(-1)?.["historyInvocationId"]),
        /^history-/,
        "Undo classification did not observe the active history invocation.",
      );
      const undoMessages = endpoint.messages.slice(beforeUndoMessages);
      assert.equal(
        undoMessages.some(
          (message) => message.kind === "document-update" && message.reason === "external",
        ),
        true,
        "The external history event was not queued as an external snapshot.",
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
      await coordinator.flush(documentUri.toString());
      assert.equal(
        document.getText(),
        "Xあいうかきく",
        "Redo did not restore both composition commits.",
      );
      assert.match(
        String(historyClassificationDiagnostics.at(-1)?.["historyInvocationId"]),
        /^history-/,
        "Redo classification did not observe the active history invocation.",
      );
    } finally {
      documentChangeSubscription.dispose();
    }
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

    for (const [name, text] of [
      ["plain-text", "plain text"],
      ["atx-heading", "# ATX heading"],
      ["strong", "**strong**"],
      ["emphasis", "*emphasis*"],
    ] as const) {
      const syntaxEndpoint = new RecordingEndpoint();
      const syntaxSessionId = `save-syntax-${name}`;
      const syntaxOpened = await coordinator.openSession(
        documentUri.toString(),
        syntaxSessionId,
        syntaxEndpoint,
      );
      assert.ok(syntaxOpened.ok, `Save syntax session '${name}' did not open.`);
      await coordinator.receive(
        fullReplacementMessage(
          documentUri.toString(),
          syntaxSessionId,
          1,
          syntaxOpened.snapshot.documentVersion,
          syntaxOpened.snapshot.text,
          text,
        ),
        syntaxEndpoint,
      );
      await coordinator.receive(
        barrierMessage(documentUri.toString(), syntaxSessionId, "save", 2),
        syntaxEndpoint,
      );

      assert.equal(
        syntaxEndpoint.messages.some((message) => message.kind === "resync"),
        false,
        `Immediate Save for '${name}' entered recovery.`,
      );
      assert.equal(
        document.isDirty,
        false,
        `Immediate Save for '${name}' left the document dirty.`,
      );
      assert.equal(
        await readDiskText(documentUri),
        text,
        `Immediate Save for '${name}' did not persist the authoritative text.`,
      );
    }
  } finally {
    await removeSmokeFile(documentUri);
  }
}

async function verifyMixedListSaveParticipantSemantics(workspaceUri: vscode.Uri): Promise<void> {
  const documentUri = vscode.Uri.joinPath(workspaceUri, MIXED_LIST_SAVE_PROBE_FILE_NAME);
  const source = "probe\n\n- unordered\n1. ordered\n";
  const editedSource = "probex\n\n- unordered\n1. ordered\n";
  const prettierSource = "probex\n\n- unordered\n\n1. ordered\n";
  await removeSmokeFile(documentUri);

  const formatter = vscode.languages.registerDocumentFormattingEditProvider(
    { language: "markdown" },
    {
      provideDocumentFormattingEdits: async (document): Promise<vscode.TextEdit[]> => {
        const formatted = await prettier.format(document.getText(), { parser: "markdown" });
        return formatted === document.getText()
          ? []
          : [vscode.TextEdit.replace(fullDocumentRange(document), formatted)];
      },
    },
  );

  try {
    await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode(source));
    const document = await vscode.workspace.openTextDocument(documentUri);
    assertCleanFormatterOffConfiguration(documentUri);

    const formatterOffObservations = observeDocument(documentUri);
    try {
      await replaceWholeDocument(document, documentUri, editedSource);
      formatterOffObservations.record("normal-editor-before-save");
      assert.equal(
        await document.save(),
        true,
        "Formatter-off normal-editor Save did not complete.",
      );
      formatterOffObservations.record("normal-editor-after-save");
      assert.equal(
        document.getText(),
        editedSource,
        "Formatter-off normal-editor Save inserted a blank line.",
      );
      assert.equal(
        await readDiskText(documentUri),
        editedSource,
        "Formatter-off normal-editor disk differs.",
      );

      await replaceWholeDocument(document, documentUri, source);
      assert.equal(
        await document.save(),
        true,
        "Formatter-off Live Editor fixture reset did not save.",
      );
      const port = new VscodeDocumentPort();
      const coordinator = new DocumentSyncCoordinator(port);
      const endpoint = new RecordingEndpoint();
      const opened = await coordinator.openSession(
        documentUri.toString(),
        "mixed-list-formatter-off",
        endpoint,
      );
      assert.ok(opened.ok, "Formatter-off Live Editor session did not open.");
      await coordinator.receive(
        fullReplacementMessage(
          documentUri.toString(),
          "mixed-list-formatter-off",
          1,
          opened.snapshot.documentVersion,
          opened.snapshot.text,
          editedSource,
        ),
        endpoint,
      );
      formatterOffObservations.record("live-editor-host-acknowledged");
      await coordinator.receive(
        barrierMessage(documentUri.toString(), "mixed-list-formatter-off", "save", 2),
        endpoint,
      );
      formatterOffObservations.record("live-editor-after-immediate-save");
      assert.equal(
        endpoint.messages.some((message) => message.kind === "resync"),
        false,
        "Formatter-off Live Editor immediate Save entered recovery.",
      );
      assert.equal(
        document.getText(),
        editedSource,
        "Formatter-off Live Editor Save inserted a blank line.",
      );
      assert.equal(
        await readDiskText(documentUri),
        editedSource,
        "Formatter-off Live Editor disk differs.",
      );
      assertNoMixedListBlank(formatterOffObservations.entries, "Formatter-off Save");
    } finally {
      formatterOffObservations.dispose();
    }

    await vscode.workspace
      .getConfiguration("editor", documentUri)
      .update("formatOnSave", true, vscode.ConfigurationTarget.Global);
    assert.equal(
      vscode.workspace.getConfiguration("editor", documentUri).get<boolean>("formatOnSave"),
      true,
      "The isolated test profile did not enable formatOnSave.",
    );

    const formatterOnObservations = observeDocument(documentUri);
    try {
      await replaceWholeDocument(document, documentUri, editedSource);
      formatterOnObservations.record("normal-editor-before-save");
      assert.equal(await document.save(), true, "Prettier normal-editor Save did not complete.");
      formatterOnObservations.record("normal-editor-after-save");
      assert.equal(
        document.getText(),
        prettierSource,
        "Prettier normal-editor Save did not add its blank line.",
      );

      await replaceWholeDocument(document, documentUri, source);
      assert.equal(await document.save(), true, "Prettier Live Editor fixture reset did not save.");
      const port = new VscodeDocumentPort();
      const coordinator = new DocumentSyncCoordinator(port);
      const endpoint = new RecordingEndpoint();
      const opened = await coordinator.openSession(
        documentUri.toString(),
        "mixed-list-prettier",
        endpoint,
      );
      assert.ok(opened.ok, "Prettier Live Editor session did not open.");
      await coordinator.receive(
        fullReplacementMessage(
          documentUri.toString(),
          "mixed-list-prettier",
          1,
          opened.snapshot.documentVersion,
          opened.snapshot.text,
          editedSource,
        ),
        endpoint,
      );
      formatterOnObservations.record("live-editor-host-acknowledged");
      await coordinator.receive(
        barrierMessage(documentUri.toString(), "mixed-list-prettier", "save", 2),
        endpoint,
      );
      formatterOnObservations.record("live-editor-after-immediate-save");
      assert.equal(
        document.getText(),
        prettierSource,
        "Prettier Live Editor Save did not add its blank line.",
      );
      assert.equal(
        await readDiskText(documentUri),
        prettierSource,
        "Prettier Live Editor disk differs.",
      );

      await replaceWholeDocument(document, documentUri, editedSource);
      await vscode.window.showTextDocument(document, { preview: false });
      await vscode.commands.executeCommand("editor.action.formatDocument");
      formatterOnObservations.record("normal-editor-after-manual-format");
      assert.equal(
        document.getText(),
        prettierSource,
        "Manual Format Document did not add Prettier's blank line.",
      );
      assertFirstMixedListBlankAfterSaveParticipant(formatterOnObservations.entries, editedSource);
    } finally {
      formatterOnObservations.dispose();
    }
  } finally {
    await vscode.workspace
      .getConfiguration("editor", documentUri)
      .update("formatOnSave", undefined, vscode.ConfigurationTarget.Global);
    formatter.dispose();
    await removeSmokeFile(documentUri);
  }
}

interface SaveObservation {
  readonly phase: string;
  readonly timestamp: number;
  readonly documentVersion: number;
  readonly dirty: boolean;
  readonly textLength: number;
  readonly lineCount: number;
  readonly sourceHash: string;
  readonly hasMixedListBlank: boolean;
  readonly text: string;
}

function observeDocument(documentUri: vscode.Uri): {
  readonly entries: readonly SaveObservation[];
  record(phase: string): void;
  dispose(): void;
} {
  const entries: SaveObservation[] = [];
  const record = (phase: string, document: vscode.TextDocument): void => {
    const text = document.getText();
    entries.push({
      phase,
      timestamp: Date.now(),
      documentVersion: document.version,
      dirty: document.isDirty,
      textLength: text.length,
      lineCount: document.lineCount,
      sourceHash: textFingerprint(text),
      hasMixedListBlank: text.includes("- unordered\n\n1. ordered"),
      text,
    });
  };
  const subscription = vscode.workspace.onDidChangeTextDocument((event): void => {
    if (event.document.uri.toString() === documentUri.toString()) {
      record("onDidChangeTextDocument", event.document);
    }
  });
  const document = vscode.workspace.textDocuments.find(
    (candidate) => candidate.uri.toString() === documentUri.toString(),
  );
  if (document === undefined) {
    throw new Error("The mixed-list Save probe document is not open.");
  }
  record("fixture-opened", document);
  return {
    entries,
    record: (phase): void => {
      record(phase, document);
    },
    dispose: (): void => {
      subscription.dispose();
    },
  };
}

function assertCleanFormatterOffConfiguration(documentUri: vscode.Uri): void {
  const editor = vscode.workspace.getConfiguration("editor", documentUri);
  const files = vscode.workspace.getConfiguration("files", documentUri);
  const formatOnSave = editor.inspect<boolean>("formatOnSave");
  const defaultFormatter = editor.inspect<string>("defaultFormatter");
  const codeActions = editor.inspect<Readonly<Record<string, unknown>>>("codeActionsOnSave");
  const autoSave = files.inspect<string>("autoSave");
  assert.equal(
    editor.get<boolean>("formatOnSave"),
    false,
    `Unexpected formatOnSave: ${JSON.stringify(formatOnSave)}`,
  );
  const effectiveDefaultFormatter = editor.get<unknown>("defaultFormatter");
  assert.ok(
    effectiveDefaultFormatter === undefined || effectiveDefaultFormatter === null,
    `Unexpected defaultFormatter: ${JSON.stringify(defaultFormatter)}`,
  );
  const effectiveCodeActions = editor.get<Readonly<Record<string, unknown>>>("codeActionsOnSave");
  assert.ok(
    effectiveCodeActions === undefined ||
      Object.values(effectiveCodeActions).every((value) => value !== true && value !== "always"),
    `Unexpected save code action: ${JSON.stringify(codeActions)}`,
  );
  assert.equal(
    files.get<string>("autoSave"),
    "off",
    `Unexpected autoSave: ${JSON.stringify(autoSave)}`,
  );
}

function assertNoMixedListBlank(entries: readonly SaveObservation[], label: string): void {
  assert.equal(
    entries.some(({ hasMixedListBlank }) => hasMixedListBlank),
    false,
    `${label} inserted a blank line: ${JSON.stringify(entries)}`,
  );
}

function assertFirstMixedListBlankAfterSaveParticipant(
  entries: readonly SaveObservation[],
  editedSource: string,
): void {
  const firstBlank = entries.find(({ hasMixedListBlank }) => hasMixedListBlank);
  assert.ok(
    firstBlank,
    `No participant inserted the expected blank line: ${JSON.stringify(entries)}`,
  );
  const prior = entries.slice(0, entries.indexOf(firstBlank)).at(-1);
  assert.ok(prior, "The formatter observation has no pre-change state.");
  assert.equal(
    prior.text,
    editedSource,
    `The source changed before Save participant formatting: ${JSON.stringify(entries)}`,
  );
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
