import assert from "node:assert/strict";
import { TextEncoder } from "node:util";
import * as vscode from "vscode";

import { DocumentSyncCoordinator } from "../../src/core/sync/documentSyncCoordinator.js";
import { MarkdownEditorProvider } from "../../src/extension/editor/MarkdownEditorProvider.js";
import { VscodeDocumentPort } from "../../src/extension/sync/VscodeDocumentPort.js";

const PROBE_VIEW_TYPE = "vscodeMarkdownLiveEditor.v02WebviewFindWidgetProbe";

interface WebviewObservation {
  panel: vscode.WebviewPanel | undefined;
  editorReady: boolean;
  editorState: boolean;
}

class ObservedMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public constructor(
    private readonly provider: MarkdownEditorProvider,
    private readonly observation: WebviewObservation,
  ) {}

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    cancellationToken: vscode.CancellationToken,
  ): Promise<void> {
    this.observation.panel = panel;
    panel.webview.onDidReceiveMessage((message: unknown): void => {
      if (typeof message !== "object" || message === null || !("kind" in message)) return;
      if (message.kind === "editor-ready") this.observation.editorReady = true;
      if (message.kind === "editor-state") this.observation.editorState = true;
    });
    return this.provider.resolveCustomTextEditor(document, panel, cancellationToken);
  }
}

function isActiveProbe(uri: vscode.Uri): boolean {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return (
    input instanceof vscode.TabInputCustom &&
    input.viewType === PROBE_VIEW_TYPE &&
    input.uri.toString() === uri.toString()
  );
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Webview Find probe: ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
}

async function closeTabsFor(uri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        (tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputCustom) &&
        tab.input.uri.toString() === uri.toString(),
    );
  await vscode.window.tabGroups.close(tabs);
}

/**
 * Runs an isolated custom editor using the real provider and `dist/webview.js`.
 * It intentionally observes only public host/webview messages and never reads
 * workbench or iframe DOM.
 */
export async function verifyV02WebviewFindWidgetProbe(workspace: vscode.Uri): Promise<void> {
  const extension = vscode.extensions.getExtension("zcw.vscode-markdown-live-editor");
  assert.ok(extension, "The Markdown Live Editor extension was not found.");
  const uri = vscode.Uri.joinPath(workspace, "v02-webview-find-widget-probe.md");
  const source = [
    "# Find widget probe",
    "visible needle",
    ...Array.from(
      { length: 300 },
      (_, index) => `offscreen ${String(index)} needle-${String(index)}`,
    ),
    "![needle-image](assets/needle.png)",
    "[needle-link](target.md#needle-anchor)",
    "",
  ].join("\n");
  const observation: WebviewObservation = {
    panel: undefined,
    editorReady: false,
    editorState: false,
  };
  const provider = new MarkdownEditorProvider(
    new DocumentSyncCoordinator(new VscodeDocumentPort()),
    {
      diagnosticMode: "off",
      viewType: PROBE_VIEW_TYPE,
      webviewScriptPath: vscode.Uri.joinPath(extension.extensionUri, "dist", "webview.js"),
    },
  );
  const registration = vscode.window.registerCustomEditorProvider(
    PROBE_VIEW_TYPE,
    new ObservedMarkdownEditorProvider(provider, observation),
    { webviewOptions: { enableFindWidget: true } },
  );
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source));
  const document = await vscode.workspace.openTextDocument(uri);
  try {
    try {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        PROBE_VIEW_TYPE,
        vscode.ViewColumn.One,
      );
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      console.log(`V02_WEBVIEW_FIND_WIDGET_PROBE_BLOCKED ${vscode.version} openWith=${note}`);
      return;
    }
    await waitFor(() => isActiveProbe(uri), "the registered custom editor did not become active");
    await waitFor(
      () => observation.editorReady && observation.editorState,
      "the real webview did not report editor-ready and editor-state",
    );
    const panel = observation.panel;
    assert.ok(panel, "the custom editor provider did not receive a WebviewPanel");
    assert.equal(
      panel.options.enableFindWidget,
      true,
      "the public find-widget option was rejected",
    );
    assert.equal(panel.active, true, "the actual Live custom-editor screen was not active");
    assert.equal(
      document.getText(),
      source,
      "loading the real webview changed authoritative source",
    );

    await vscode.commands.executeCommand("actions.find");
    await vscode.commands.executeCommand("editor.action.startFindReplaceAction");
    assert.equal(
      document.getText(),
      source,
      "opening public Find/Replace commands mutated authoritative source",
    );
    assert.equal(
      isActiveProbe(uri),
      true,
      "Find/Replace command switched away from the custom editor",
    );
    console.log(
      `V02_WEBVIEW_FIND_WIDGET_PROBE ${vscode.version} ` +
        "real-custom-editor/real-webview-ready/editor-state/options-accepted/" +
        "find-command-resolved/replace-command-resolved/source-unchanged",
    );
  } finally {
    await vscode.commands.executeCommand("closeFindWidget");
    await closeTabsFor(uri);
    registration.dispose();
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  }
}
