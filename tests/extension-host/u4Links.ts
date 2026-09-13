import assert from "node:assert/strict";
import { TextEncoder } from "node:util";
import * as vscode from "vscode";
import { MarkdownResourceSession } from "../../src/extension/editor/markdownResources.js";
import { MarkdownEditorProvider } from "../../src/extension/editor/MarkdownEditorProvider.js";
import { MarkdownEditorSessionRegistry } from "../../src/extension/editor/MarkdownEditorSessionRegistry.js";
import { DocumentSyncCoordinator } from "../../src/core/sync/documentSyncCoordinator.js";
import { VscodeDocumentPort } from "../../src/extension/sync/VscodeDocumentPort.js";
import type { RichRequest, RichResponse } from "../../src/protocol/richMessages.js";

const LIVE_VIEW_TYPE = "vscodeMarkdownLiveEditor.editor";

export async function run(): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, "The U4 link test workspace was not opened.");
  const extension = vscode.extensions.getExtension("zcw.vscode-markdown-live-editor");
  assert.ok(extension, "The Markdown Live Editor extension was not found.");
  await extension.activate();
  await verifyLiveAnchor(workspace, extension.extensionUri);

  const folder = vscode.Uri.joinPath(workspace, "u4-link-host");
  const sourceUri = vscode.Uri.joinPath(folder, "source.md");
  const targetUri = vscode.Uri.joinPath(folder, "日本語 target.md");
  const textUri = vscode.Uri.joinPath(folder, "日本語 target.txt");
  await vscode.workspace.fs.createDirectory(folder);
  await vscode.workspace.fs.writeFile(
    sourceUri,
    new TextEncoder().encode("# Source\n[heading](日本語%20target.md#見出し-日本語)\n"),
  );
  await vscode.workspace.fs.writeFile(
    targetUri,
    new TextEncoder().encode("# 見出し 日本語\n本文\n## 次\n"),
  );
  await vscode.workspace.fs.writeFile(textUri, new TextEncoder().encode("text target\n"));

  const associations = vscode.workspace
    .getConfiguration("workbench")
    .inspect<unknown>("editorAssociations");
  const originalAssociation = associations?.globalValue;
  try {
    const source = await vscode.workspace.openTextDocument(sourceUri);
    await withAssociation({ "*.md": "default" }, async (): Promise<void> => {
      const webview = recordingWebview();
      const session = new MarkdownResourceSession(source, webview, (): boolean => true);
      await session.receive(request(source, "日本語%20target.md#見出し-日本語", 1));
      assert.equal(activeUri(), targetUri.toString());
      assert.equal(activeTabKind(), "text", "vscode.open did not resolve the Text Editor default");
      const textEditor = vscode.window.activeTextEditor;
      assert.ok(textEditor);
      assert.equal(textEditor.document.uri.toString(), targetUri.toString());
      assert.equal(textEditor.selection.start.line, 0);
      assert.equal(response(webview).ok, true);

      await session.receive(request(source, "#source", 2));
      assert.equal(
        response(webview).offset,
        0,
        "same-document heading must stay in the Live session",
      );
      session.dispose();
    });

    await withAssociation({ "*.md": LIVE_VIEW_TYPE }, async (): Promise<void> => {
      const webview = recordingWebview();
      const session = new MarkdownResourceSession(source, webview, (): boolean => true);
      await session.receive(request(source, "日本語%20target.md#見出し-日本語", 3));
      assert.equal(activeUri(), targetUri.toString());
      assert.equal(activeTabKind(), "live", "vscode.open did not resolve the Live Editor default");
      assert.equal(response(webview).ok, true);

      await session.receive(request(source, "日本語%20target.txt", 4));
      assert.equal(activeUri(), textUri.toString());
      assert.equal(activeTabKind(), "text", "Text target did not use its file-type default editor");
      assert.equal(response(webview).ok, true);

      await session.receive(request(source, "日本語%20target.md#次", 5));
      assert.equal(activeUri(), targetUri.toString());
      assert.equal(activeTabKind(), "live", "second open selected a stale or different target");
      assert.equal(response(webview).ok, true);
      session.dispose();
    });
    console.log(
      "U4_LINKS_PASS public vscode.open defaults/text-live/same-document/Japanese-space/txt/reopen",
    );
  } finally {
    await vscode.workspace
      .getConfiguration("workbench")
      .update("editorAssociations", originalAssociation, vscode.ConfigurationTarget.Global);
    await closeTabsUnder(folder);
    await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
  }
}

async function verifyLiveAnchor(workspace: vscode.Uri, extensionUri: vscode.Uri): Promise<void> {
  const viewType = "vscodeMarkdownLiveEditor.u4LinkProbe";
  const directory = vscode.Uri.joinPath(workspace, "u4-link-live-anchor");
  const states = new Map<string, number>();
  const registry = new MarkdownEditorSessionRegistry();
  const provider = new MarkdownEditorProvider(
    new DocumentSyncCoordinator(new VscodeDocumentPort()),
    {
      diagnosticMode: "preview",
      sessionRegistry: registry,
      viewType,
      webviewScriptPath: vscode.Uri.joinPath(extensionUri, "dist", "u4-link-probe.js"),
    },
  );
  const registration = vscode.window.registerCustomEditorProvider(viewType, {
    resolveCustomTextEditor: (document, panel, token) => {
      panel.webview.onDidReceiveMessage((message: unknown): void => {
        if (
          typeof message === "object" &&
          message !== null &&
          Reflect.get(message, "kind") === "editor-state" &&
          typeof Reflect.get(message, "documentUri") === "string" &&
          typeof Reflect.get(message, "selectionHead") === "number"
        )
          states.set(
            Reflect.get(message, "documentUri") as string,
            Reflect.get(message, "selectionHead") as number,
          );
      });
      return provider.resolveCustomTextEditor(document, panel, token);
    },
  });
  const associations = vscode.workspace
    .getConfiguration("workbench")
    .inspect<unknown>("editorAssociations");
  await vscode.workspace
    .getConfiguration("workbench")
    .update("editorAssociations", { "*.md": viewType }, vscode.ConfigurationTarget.Global);
  try {
    for (const eol of ["\n", "\r\n"] as const) {
      const suffix = eol.length === 1 ? "lf" : "crlf";
      const sourceUri = vscode.Uri.joinPath(directory, `u4-link-source-${suffix}.md`);
      const targetUri = vscode.Uri.joinPath(directory, `日本語 target-${suffix}.md`);
      const target = ["before", "", "# 古い見出し", "", "# 現在の見出し", "after"].join(eol);
      const source = [
        "# u4-link-source",
        "",
        `[old](日本語%20target-${suffix}.md#古い見出し)`,
        `[current](日本語%20target-${suffix}.md#現在の見出し)`,
      ].join(eol);
      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(sourceUri, new TextEncoder().encode(source));
      await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(target));
      const expected = target
        .slice(0, target.indexOf("# 現在の見出し"))
        .replace(/\r\n/gu, "\n").length;
      await vscode.commands.executeCommand("vscode.openWith", sourceUri, viewType);
      await waitForState(
        () => states.get(targetUri.toString()) === expected,
        `LF-normalized current heading was not reported for ${suffix}`,
      );
      assert.equal(states.get(targetUri.toString()), expected);
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(
        input instanceof vscode.TabInputCustom && input.uri.toString() === targetUri.toString(),
      );
    }
    console.log("U4_LINK_ANCHOR_PASS synthetic-production-click/LF-CRLF/nonzero-heading");
  } finally {
    await vscode.workspace
      .getConfiguration("workbench")
      .update("editorAssociations", associations?.globalValue, vscode.ConfigurationTarget.Global);
    registration.dispose();
    await closeTabsUnder(directory);
    await vscode.workspace.fs.delete(directory, { recursive: true, useTrash: false });
  }
}

async function waitForState(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`U4 link anchor: ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
}

function recordingWebview(): vscode.Webview {
  const messages: RichResponse[] = [];
  const webview = {
    options: {},
    postMessage: (message: unknown): Promise<boolean> => {
      if (
        typeof message === "object" &&
        message !== null &&
        Reflect.get(message, "kind") === "rich-response"
      )
        messages.push(message as RichResponse);
      return Promise.resolve(true);
    },
    asWebviewUri: (uri: vscode.Uri): vscode.Uri => uri,
    get cspSource(): string {
      return "";
    },
    onDidReceiveMessage: (): vscode.Disposable => vscode.Disposable.from(),
    html: "",
    get state(): unknown {
      return undefined;
    },
    messages,
  };
  return webview;
}

function response(webview: vscode.Webview): RichResponse {
  const messages = (webview as unknown as { readonly messages?: readonly RichResponse[] }).messages;
  const message = messages?.at(-1);
  assert.ok(message, "Link operation did not return a RichResponse.");
  return message;
}

function request(document: vscode.TextDocument, target: string, requestId: number): RichRequest {
  return {
    kind: "rich-request",
    protocolVersion: 2,
    documentUri: document.uri.toString(),
    sessionId: "u4-link-session",
    controllerId: "u4-link-controller",
    requestId,
    documentVersion: document.version,
    operation: "link-open",
    target,
  };
}

async function withAssociation(
  value: Record<string, string>,
  action: () => Promise<void>,
): Promise<void> {
  await vscode.workspace
    .getConfiguration("workbench")
    .update("editorAssociations", value, vscode.ConfigurationTarget.Global);
  await action();
}

function activeUri(): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
    ? input.uri.toString()
    : undefined;
}

function activeTabKind(): "text" | "live" | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText) return "text";
  return input instanceof vscode.TabInputCustom && input.viewType === LIVE_VIEW_TYPE
    ? "live"
    : undefined;
}

async function closeTabsUnder(folder: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter((tab) => {
      const input = tab.input;
      return (
        (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) &&
        input.uri.toString().startsWith(folder.toString())
      );
    }),
  );
  if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
}
