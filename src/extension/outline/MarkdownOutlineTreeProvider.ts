import * as vscode from "vscode";

import {
  buildOutlineTree,
  extractOutlineHeadings,
  type OutlineNode,
} from "../../core/outline/outlineModel.js";
import { PROTOCOL_VERSION, type NavigateToHeadingMessage } from "../../protocol/messages.js";
import type { MarkdownEditorSessionRegistry } from "../editor/MarkdownEditorSessionRegistry.js";

export const MARKDOWN_OUTLINE_VIEW_ID = "vscodeMarkdownLiveEditor.markdownOutline";
export const NAVIGATE_TO_OUTLINE_HEADING_COMMAND =
  "vscodeMarkdownLiveEditor.navigateToOutlineHeading";

interface OutlineSnapshot {
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly roots: readonly OutlineNode[];
}

interface OutlineDocument {
  readonly uri: { toString(): string };
  readonly version: number;
  getText(): string;
}

export class MarkdownOutlineTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly node: OutlineNode,
    public readonly documentUri: string,
    public readonly documentVersion: number,
  ) {
    super(
      node.label === "" ? "(untitled heading)" : node.label,
      node.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    this.id = `${documentUri}::${node.identity}`;
    this.contextValue = "markdownOutlineHeading";
    this.command = {
      command: NAVIGATE_TO_OUTLINE_HEADING_COMMAND,
      title: "Go to Markdown heading",
      arguments: [this],
    };
  }
}

/** Native VS Code tree backed only by the active authoritative TextDocument. */
export class MarkdownOutlineTreeProvider
  implements vscode.TreeDataProvider<MarkdownOutlineTreeItem>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    MarkdownOutlineTreeItem | undefined | null
  >();
  private readonly registrySubscription: { dispose(): void };
  private snapshot: OutlineSnapshot | undefined;

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly sessions: MarkdownEditorSessionRegistry) {
    this.registrySubscription = sessions.onDidChange((): void => {
      this.refreshActiveDocument();
    });
    this.refreshActiveDocument();
  }

  public getTreeItem(element: MarkdownOutlineTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: MarkdownOutlineTreeItem): MarkdownOutlineTreeItem[] {
    const snapshot = this.snapshot;
    if (snapshot === undefined) {
      return [];
    }
    const nodes = element === undefined ? snapshot.roots : element.node.children;
    return nodes.map(
      (node) => new MarkdownOutlineTreeItem(node, snapshot.documentUri, snapshot.documentVersion),
    );
  }

  public handleDocumentChange(document: OutlineDocument): void {
    if (this.sessions.activeSession?.documentUri !== document.uri.toString()) {
      return;
    }
    this.setSnapshot(document);
  }

  public async navigateTo(item: MarkdownOutlineTreeItem): Promise<boolean> {
    const session = this.sessions.activeSession;
    const snapshot = this.snapshot;
    if (
      session === undefined ||
      snapshot === undefined ||
      session.sessionId === "" ||
      session.documentUri !== item.documentUri ||
      snapshot.documentUri !== item.documentUri ||
      snapshot.documentVersion !== item.documentVersion
    ) {
      this.refreshActiveDocument();
      return false;
    }
    const document = findOpenDocument(item.documentUri);
    if (document?.version !== item.documentVersion) {
      this.refreshActiveDocument();
      return false;
    }
    const currentNode = findNode(snapshot.roots, item.node.identity);
    if (
      currentNode?.from !== item.node.from ||
      currentNode.to !== item.node.to ||
      currentNode.navigationOffset !== item.node.navigationOffset
    ) {
      this.refreshActiveDocument();
      return false;
    }

    const message: NavigateToHeadingMessage = {
      kind: "navigate-to-heading",
      protocolVersion: PROTOCOL_VERSION,
      documentUri: item.documentUri,
      documentVersion: item.documentVersion,
      sessionId: session.sessionId,
      targetOffset: item.node.navigationOffset,
      highlightFrom: item.node.from,
      highlightTo: item.node.to,
    };
    session.reveal();
    return await Promise.resolve(session.postMessage(message));
  }

  public dispose(): void {
    this.registrySubscription.dispose();
    this.changeEmitter.dispose();
  }

  private refreshActiveDocument(): void {
    const session = this.sessions.activeSession;
    const document = session === undefined ? undefined : findOpenDocument(session.documentUri);
    if (document === undefined) {
      this.snapshot = undefined;
      this.changeEmitter.fire(undefined);
      return;
    }
    this.setSnapshot(document);
  }

  private setSnapshot(document: OutlineDocument): void {
    const documentUri = document.uri.toString();
    this.snapshot = {
      documentUri,
      documentVersion: document.version,
      roots: buildOutlineTree(extractOutlineHeadings(toProtocolText(document.getText()))),
    };
    this.changeEmitter.fire(undefined);
  }
}

function findOpenDocument(documentUri: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === documentUri);
}

function findNode(nodes: readonly OutlineNode[], identity: string): OutlineNode | undefined {
  for (const node of nodes) {
    if (node.identity === identity) {
      return node;
    }
    const child = findNode(node.children, identity);
    if (child !== undefined) {
      return child;
    }
  }
  return undefined;
}

function toProtocolText(text: string): string {
  return text.replaceAll("\r\n", "\n");
}
