import assert from "node:assert/strict";
import { TextEncoder } from "node:util";
import * as vscode from "vscode";

import { DocumentSyncCoordinator } from "../../src/core/sync/documentSyncCoordinator.js";
import { MarkdownEditorProvider } from "../../src/extension/editor/MarkdownEditorProvider.js";
import { VscodeDocumentPort } from "../../src/extension/sync/VscodeDocumentPort.js";

const PROBE_VIEW_TYPE = "vscodeMarkdownLiveEditor.v02ImageLifecycle";

interface Observation {
  panel: vscode.WebviewPanel | undefined;
  editorReady: boolean;
  editorStateVersion: number;
  initialSelectionAtZero: boolean;
  readonly events: string[];
}

function count(events: readonly string[], event: string): number {
  return events.filter((candidate) => candidate === event).length;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

class ObservedMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public constructor(
    private readonly provider: MarkdownEditorProvider,
    private readonly observation: Observation,
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
      if (message.kind === "editor-state") {
        const version = readNumber(
          "documentVersion" in message ? message.documentVersion : undefined,
        );
        if (version !== undefined)
          this.observation.editorStateVersion = Math.max(
            version,
            this.observation.editorStateVersion,
          );
        const anchor = readNumber(
          "selectionAnchor" in message ? message.selectionAnchor : undefined,
        );
        const head = readNumber("selectionHead" in message ? message.selectionHead : undefined);
        if (anchor === 0 && head === 0) this.observation.initialSelectionAtZero = true;
      }
      if (message.kind === "diagnostic" && "event" in message && typeof message.event === "string")
        this.observation.events.push(message.event);
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
  const deadline = Date.now() + 20000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Image lifecycle: ${description}`);
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

async function replaceLine(
  document: vscode.TextDocument,
  line: number,
  replacement: string,
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, document.lineAt(line).range, replacement);
  assert.equal(await vscode.workspace.applyEdit(edit), true, "VS Code rejected the source edit");
}

function lineWith(document: vscode.TextDocument, text: string): number {
  for (let line = 0; line < document.lineCount; line += 1)
    if (document.lineAt(line).text === text) return line;
  throw new Error(`Image lifecycle: source line '${text}' was not found`);
}

/**
 * Actual Extension Host evidence for the cold local-image path and DOM reuse.
 * It observes only protocol/diagnostic messages and does not inspect iframe or
 * workbench DOM. Clipboard, Drop, IME, and physical-pixel UX remain out of scope.
 */
export async function verifyV02ImageLifecycle(workspace: vscode.Uri): Promise<void> {
  const extension = vscode.extensions.getExtension("zcw.vscode-markdown-live-editor");
  assert.ok(extension, "The Markdown Live Editor extension was not found.");
  await extension.activate();
  const documentUri = vscode.Uri.joinPath(workspace, "v02-image-lifecycle.md");
  const imageUri = vscode.Uri.joinPath(workspace, "v02-image-lifecycle.png");
  const fixtureImage = vscode.Uri.joinPath(
    extension.extensionUri,
    "tests",
    "fixtures",
    "v02-review",
    "assets",
    "example.png",
  );
  const source = "before\n\n![](v02-image-lifecycle.png)\n\nafter\n";
  const observation: Observation = {
    panel: undefined,
    editorReady: false,
    editorStateVersion: -1,
    initialSelectionAtZero: false,
    events: [],
  };
  const port = new VscodeDocumentPort();
  const coordinator = new DocumentSyncCoordinator(port);
  const provider = new MarkdownEditorProvider(coordinator, {
    diagnosticMode: "preview",
    viewType: PROBE_VIEW_TYPE,
    webviewScriptPath: vscode.Uri.joinPath(extension.extensionUri, "dist", "webview.js"),
  });
  const registration = vscode.window.registerCustomEditorProvider(
    PROBE_VIEW_TYPE,
    new ObservedMarkdownEditorProvider(provider, observation),
  );
  const imageBytes = await vscode.workspace.fs.readFile(fixtureImage);
  await vscode.workspace.fs.writeFile(imageUri, imageBytes);
  await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode(source));
  const document = await vscode.workspace.openTextDocument(documentUri);
  const changes = vscode.workspace.onDidChangeTextDocument((event): void => {
    if (event.document.uri.toString() !== documentUri.toString()) return;
    void coordinator.publishExternalChange(documentUri.toString()).catch((): void => undefined);
  });
  try {
    await vscode.commands.executeCommand(
      "vscode.openWith",
      documentUri,
      PROBE_VIEW_TYPE,
      vscode.ViewColumn.One,
    );
    await waitFor(() => isActiveProbe(documentUri), "the real custom editor did not become active");
    await waitFor(
      () => observation.editorReady && observation.editorStateVersion >= document.version,
      "the real controller did not become ready",
    );
    assert.notEqual(
      observation.panel?.options.enableFindWidget,
      true,
      "the image probe changed Find-widget defaults",
    );
    assert.equal(
      observation.initialSelectionAtZero,
      true,
      "the initial caret was not on the first source line",
    );
    await waitFor(
      () => count(observation.events, "image.load") >= 1,
      "the cold local image did not load",
    );
    assert.equal(document.getText(), source, "cold image rendering changed source");

    const baseline = {
      created: count(observation.events, "image.dom-created"),
      loading: count(observation.events, "image.loading"),
      requested: count(observation.events, "image.resolve-requested"),
      reused: count(observation.events, "image.dom-reused"),
    };
    await replaceLine(document, 0, "before changed");
    await waitFor(
      () => observation.editorStateVersion >= document.version,
      "the before-image TextDocument edit did not reach the real controller",
    );
    await replaceLine(document, lineWith(document, "after"), "after changed");
    await waitFor(
      () => observation.editorStateVersion >= document.version,
      "the after-image TextDocument edit did not reach the real controller",
    );
    assert.equal(
      count(observation.events, "image.dom-created"),
      baseline.created,
      "source edits recreated image DOM",
    );
    assert.equal(
      count(observation.events, "image.loading"),
      baseline.loading,
      "source edits restored image loading",
    );
    assert.equal(
      count(observation.events, "image.resolve-requested"),
      baseline.requested,
      "source edits re-resolved an unchanged image",
    );
    assert.ok(
      count(observation.events, "image.dom-reused") >= baseline.reused + 1,
      "before/after source edits did not reuse the visible image DOM",
    );
    const editedSource = document.getText();

    const beforeRefresh = {
      created: count(observation.events, "image.dom-created"),
      loading: count(observation.events, "image.loading"),
      requested: count(observation.events, "image.resolve-requested"),
      loaded: count(observation.events, "image.load"),
    };
    await vscode.workspace.fs.writeFile(imageUri, imageBytes);
    await waitFor(
      () =>
        count(observation.events, "image.dom-created") >= beforeRefresh.created + 1 &&
        count(observation.events, "image.loading") >= beforeRefresh.loading + 1 &&
        count(observation.events, "image.resolve-requested") >= beforeRefresh.requested + 1 &&
        count(observation.events, "image.load") >= beforeRefresh.loaded + 1,
      "the watched image write did not invalidate and reload the visible image",
    );
    assert.equal(document.getText(), editedSource, "image resource invalidation changed source");
    console.log(
      `V02_IMAGE_LIFECYCLE_PASS ${vscode.version} ` +
        "cold-load/first-line-selection/source-unchanged/before-after-dom-reuse/" +
        "watcher-invalidation-reload",
    );
  } finally {
    changes.dispose();
    await closeTabsFor(documentUri);
    registration.dispose();
    await vscode.workspace.fs.delete(documentUri, { useTrash: false });
    await vscode.workspace.fs.delete(imageUri, { useTrash: false });
  }
}
