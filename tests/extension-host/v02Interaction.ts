import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { DocumentSyncCoordinator } from "../../src/core/sync/documentSyncCoordinator.js";
import { MarkdownEditorProvider } from "../../src/extension/editor/MarkdownEditorProvider.js";
import { VscodeDocumentPort } from "../../src/extension/sync/VscodeDocumentPort.js";
import { decodeWebviewToHostMessage } from "../../src/protocol/messages.js";

const viewType = "vscodeMarkdownLiveEditor.v02Interaction";
export async function verifyV02Interaction(workspace: vscode.Uri): Promise<void> {
  const extension = vscode.extensions.getExtension("zcw.vscode-markdown-live-editor");
  assert.ok(extension);
  const source =
    "before\n\n| h | v |\n| --- | --- |\n| a | needle |\n||  |\n\n[link](needle.md)\n\nend needle";
  for (const eol of ["\n", "\r\n"]) {
    const directory = vscode.Uri.joinPath(workspace, `v02-interaction-${randomUUID()}`);
    await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(directory, `review-${eol.length === 1 ? "lf" : "crlf"}.md`);
    await vscode.workspace.fs.writeFile(
      uri,
      new TextEncoder().encode(source.replaceAll("\n", eol)),
    );
    const document = await vscode.workspace.openTextDocument(uri);
    const port = new VscodeDocumentPort({
      record: (kind, details) => {
        console.log("INTERACTION_PORT", kind, JSON.stringify(details));
      },
    });
    const coordinator = new DocumentSyncCoordinator(port);
    const provider = new MarkdownEditorProvider(coordinator, {
      diagnosticMode: "preview",
      diagnostics: {
        record: (kind, details) => {
          if (kind.includes("controller") || kind.includes("ready"))
            console.log("INTERACTION_HOST", kind, JSON.stringify(details));
        },
      },
      viewType,
      webviewScriptPath: vscode.Uri.joinPath(
        extension.extensionUri,
        "dist",
        "interaction-probe.js",
      ),
    });
    let outcome: unknown;
    let readyCount = 0;
    let panel: vscode.WebviewPanel | undefined;
    const registration = vscode.window.registerCustomEditorProvider(viewType, {
      resolveCustomTextEditor: (doc, webviewPanel, token) => {
        panel = webviewPanel;
        webviewPanel.webview.onDidReceiveMessage((message: unknown) => {
          if (message && typeof message === "object" && "kind" in message) {
            const decoded = decodeWebviewToHostMessage(message);
            if (decoded.ok && decoded.value.kind === "diagnostic") {
              if (decoded.value.event === "interaction-stage")
                console.log("INTERACTION_STAGE", JSON.stringify(decoded.value.details));
              if (decoded.value.event === "interaction-result")
                outcome = JSON.parse(
                  Object.entries(decoded.value.details)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([, value]) => String(value))
                    .join(""),
                );
            }
            if (message.kind === "editor-ready") readyCount++;
          }
        });
        return provider.resolveCustomTextEditor(doc, webviewPanel, token);
      },
    });
    const changes = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === uri.toString())
        void coordinator.publishExternalChange(uri.toString()).catch(() => undefined);
    });
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, viewType);
      const deadline = Date.now() + 90000;
      while (outcome === undefined && Date.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.ok(
        outcome && typeof outcome === "object" && "ok" in outcome && outcome.ok === true,
        `Interaction probe ${String(eol.length)}: ${JSON.stringify(outcome)}`,
      );
      assert.ok("text" in outcome && typeof outcome.text === "string");
      await document.save();
      assert.equal(document.getText().replaceAll("\r\n", "\n"), outcome.text);
      assert.equal(document.eol, eol.length === 1 ? vscode.EndOfLine.LF : vscode.EndOfLine.CRLF);
      const disk = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      assert.equal(disk, outcome.text.replaceAll("\n", eol));
      assert.equal(readyCount, 1, "image resource invalidation restarted the controller");
      console.log(
        `V02_INTERACTION_PASS ${eol.length === 1 ? "LF" : "CRLF"}: real webview, synthetic click/Tab/Paste, worker, Save/Undo/Redo, caret`,
      );
    } finally {
      panel?.dispose();
      registration.dispose();
      changes.dispose();
      await vscode.workspace.fs.delete(directory, { recursive: true });
    }
  }
}
