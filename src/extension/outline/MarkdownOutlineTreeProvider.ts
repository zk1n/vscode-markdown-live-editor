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
  readonly roots: readonly MarkdownOutlineTreeItem[];
}

interface OutlineDocument {
  readonly uri: { toString(): string };
  readonly version: number;
  getText(): string;
}

interface DisposableLike {
  dispose(): void;
}

interface OutlineTreeExpansionEvent {
  readonly element: MarkdownOutlineTreeItem;
}

export interface MarkdownOutlineTreeView {
  readonly visible: boolean;
  readonly onDidCollapseElement: (
    listener: (event: OutlineTreeExpansionEvent) => unknown,
  ) => DisposableLike;
  readonly onDidExpandElement: (
    listener: (event: OutlineTreeExpansionEvent) => unknown,
  ) => DisposableLike;
  readonly onDidChangeVisibility: (listener: () => unknown) => DisposableLike;
  reveal(
    element: MarkdownOutlineTreeItem,
    options?: {
      readonly select?: boolean;
      readonly focus?: boolean;
      readonly expand?: boolean | number;
    },
  ): PromiseLike<void>;
}

export class MarkdownOutlineTreeItem extends vscode.TreeItem {
  public node: OutlineNode;
  public documentVersion: number;
  public parent: MarkdownOutlineTreeItem | undefined;
  public children: readonly MarkdownOutlineTreeItem[] = [];

  public constructor(
    node: OutlineNode,
    public readonly documentUri: string,
    documentVersion: number,
    treeStateId: string,
    parent: MarkdownOutlineTreeItem | undefined,
  ) {
    super(
      node.label === "" ? "(untitled heading)" : node.label,
      node.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    this.node = node;
    this.documentVersion = documentVersion;
    this.parent = parent;
    this.id = `${documentUri}::${treeStateId}`;
    this.contextValue = "markdownOutlineHeading";
    this.command = {
      command: NAVIGATE_TO_OUTLINE_HEADING_COMMAND,
      title: "Go to Markdown heading",
      arguments: [this],
    };
  }

  public update(
    node: OutlineNode,
    documentVersion: number,
    parent: MarkdownOutlineTreeItem | undefined,
  ): void {
    this.node = node;
    this.documentVersion = documentVersion;
    this.parent = parent;
    this.label = node.label === "" ? "(untitled heading)" : node.label;
    this.collapsibleState =
      node.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded;
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
  private treeView: MarkdownOutlineTreeView | undefined;
  private treeViewSubscriptions: readonly DisposableLike[] = [];
  private readonly manuallyCollapsedIds = new Set<string>();
  private readonly pendingExpansionIds = new Set<string>();
  private readonly automaticallyRetriedExpansionIds = new Set<string>();
  private expansionRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private nextTreeStateId = 1;

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
    return [...(element === undefined ? snapshot.roots : element.children)];
  }

  public getParent(element: MarkdownOutlineTreeItem): MarkdownOutlineTreeItem | undefined {
    return element.parent;
  }

  public attachTreeView(treeView: MarkdownOutlineTreeView): void {
    for (const subscription of this.treeViewSubscriptions) {
      subscription.dispose();
    }
    this.treeView = treeView;
    this.treeViewSubscriptions = [
      treeView.onDidCollapseElement(({ element }): void => {
        if (element.id !== undefined) {
          this.manuallyCollapsedIds.add(element.id);
          this.pendingExpansionIds.delete(element.id);
          this.automaticallyRetriedExpansionIds.delete(element.id);
        }
      }),
      treeView.onDidExpandElement(({ element }): void => {
        if (element.id !== undefined) {
          this.manuallyCollapsedIds.delete(element.id);
          this.automaticallyRetriedExpansionIds.delete(element.id);
        }
        this.flushPendingExpansions();
      }),
      treeView.onDidChangeVisibility((): void => {
        this.flushPendingExpansions();
      }),
    ];
    this.flushPendingExpansions();
  }

  public handleDocumentChange(document: OutlineDocument): void {
    if (this.sessions.activeCustomEditorSession?.documentUri !== document.uri.toString()) {
      return;
    }
    this.setSnapshot(document);
  }

  public async navigateTo(item: MarkdownOutlineTreeItem): Promise<boolean> {
    const session = this.sessions.activeCustomEditorSession;
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
    const currentItem = findItem(snapshot.roots, item.id);
    if (
      currentItem !== item ||
      currentItem.node.from !== item.node.from ||
      currentItem.node.to !== item.node.to ||
      currentItem.node.navigationOffset !== item.node.navigationOffset
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
    this.disposed = true;
    this.registrySubscription.dispose();
    for (const subscription of this.treeViewSubscriptions) {
      subscription.dispose();
    }
    this.treeViewSubscriptions = [];
    this.treeView = undefined;
    if (this.expansionRetryTimer !== undefined) {
      clearTimeout(this.expansionRetryTimer);
      this.expansionRetryTimer = undefined;
    }
    this.changeEmitter.dispose();
  }

  private refreshActiveDocument(): void {
    const session = this.sessions.activeCustomEditorSession;
    const document = session === undefined ? undefined : findOpenDocument(session.documentUri);
    if (document === undefined) {
      if (this.snapshot === undefined) {
        return;
      }
      this.snapshot = undefined;
      this.pendingExpansionIds.clear();
      this.automaticallyRetriedExpansionIds.clear();
      this.changeEmitter.fire(undefined);
      return;
    }
    this.setSnapshot(document);
  }

  private setSnapshot(document: OutlineDocument): void {
    const documentUri = document.uri.toString();
    const nodes = buildOutlineTree(extractOutlineHeadings(toProtocolText(document.getText())));
    const previous = this.snapshot;
    const presentationChanged =
      previous?.documentUri !== documentUri || !sameOutlinePresentation(previous.roots, nodes);
    const newlyCollapsible: MarkdownOutlineTreeItem[] = [];
    const roots = reconcileItems(
      previous?.documentUri === documentUri ? previous.roots : [],
      nodes,
      documentUri,
      document.version,
      undefined,
      newlyCollapsible,
      (): string => {
        const id = `outline-item-${String(this.nextTreeStateId)}`;
        this.nextTreeStateId += 1;
        return id;
      },
    );
    this.snapshot = {
      documentUri,
      documentVersion: document.version,
      roots,
    };
    if (previous?.documentUri === documentUri) {
      for (const item of newlyCollapsible) {
        if (item.id !== undefined && !this.manuallyCollapsedIds.has(item.id)) {
          this.pendingExpansionIds.add(item.id);
          this.automaticallyRetriedExpansionIds.delete(item.id);
        }
      }
    }
    if (presentationChanged) {
      this.changeEmitter.fire(undefined);
    }
    this.flushPendingExpansions();
  }

  private flushPendingExpansions(): void {
    const treeView = this.treeView;
    const snapshot = this.snapshot;
    if (treeView === undefined || snapshot === undefined || !treeView.visible) {
      return;
    }
    for (const id of [...this.pendingExpansionIds]) {
      const item = findItem(snapshot.roots, id);
      if (item === undefined || item.children.length === 0 || this.manuallyCollapsedIds.has(id)) {
        this.pendingExpansionIds.delete(id);
        this.automaticallyRetriedExpansionIds.delete(id);
        continue;
      }
      if (hasManuallyCollapsedAncestor(item, this.manuallyCollapsedIds)) {
        continue;
      }
      this.pendingExpansionIds.delete(id);
      void Promise.resolve(
        treeView.reveal(item, { select: false, focus: false, expand: true }),
      ).then(
        (): void => {
          this.automaticallyRetriedExpansionIds.delete(id);
        },
        (): void => {
          const current = findItem(this.snapshot?.roots ?? [], id);
          if (
            !this.disposed &&
            current === item &&
            current.children.length > 0 &&
            !this.manuallyCollapsedIds.has(id)
          ) {
            // A root refresh can briefly outrun native TreeView readiness. Preserve the request
            // and retry once on the next task without waiting for another user edit.
            this.pendingExpansionIds.add(id);
            if (!this.automaticallyRetriedExpansionIds.has(id)) {
              this.automaticallyRetriedExpansionIds.add(id);
              this.scheduleExpansionRetry();
            }
          }
        },
      );
    }
  }

  private scheduleExpansionRetry(): void {
    if (this.disposed || this.expansionRetryTimer !== undefined) {
      return;
    }
    this.expansionRetryTimer = setTimeout((): void => {
      this.expansionRetryTimer = undefined;
      this.flushPendingExpansions();
    }, 0);
  }
}

function findOpenDocument(documentUri: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === documentUri);
}

function findItem(
  items: readonly MarkdownOutlineTreeItem[],
  id: string | undefined,
): MarkdownOutlineTreeItem | undefined {
  for (const item of items) {
    if (item.id === id) {
      return item;
    }
    const child = findItem(item.children, id);
    if (child !== undefined) {
      return child;
    }
  }
  return undefined;
}

function sameOutlinePresentation(
  items: readonly MarkdownOutlineTreeItem[],
  nodes: readonly OutlineNode[],
): boolean {
  return (
    items.length === nodes.length &&
    items.every((item, index) => {
      const node = nodes[index];
      return (
        node?.level === item.node.level &&
        item.node.label === node.label &&
        sameOutlinePresentation(item.children, node.children)
      );
    })
  );
}

function reconcileItems(
  previousItems: readonly MarkdownOutlineTreeItem[],
  nodes: readonly OutlineNode[],
  documentUri: string,
  documentVersion: number,
  parent: MarkdownOutlineTreeItem | undefined,
  newlyCollapsible: MarkdownOutlineTreeItem[],
  createTreeStateId: () => string,
): readonly MarkdownOutlineTreeItem[] {
  const assigned = new Set<MarkdownOutlineTreeItem>();
  const exactMatches = nodes.map((node): MarkdownOutlineTreeItem | undefined => {
    const match = previousItems.find(
      (candidate) => !assigned.has(candidate) && candidate.node.identity === node.identity,
    );
    if (match !== undefined) {
      assigned.add(match);
    }
    return match;
  });

  for (const [index, node] of nodes.entries()) {
    if (exactMatches[index] !== undefined) {
      continue;
    }
    const localIdentity = outlineLocalIdentity(node.identity);
    const candidates = previousItems.filter(
      (candidate) =>
        !assigned.has(candidate) && outlineLocalIdentity(candidate.node.identity) === localIdentity,
    );
    if (candidates.length === 1) {
      const match = candidates[0];
      if (match !== undefined) {
        exactMatches[index] = match;
        assigned.add(match);
      }
    }
  }

  const unmatchedIndexes = exactMatches.flatMap((match, index) =>
    match === undefined ? [index] : [],
  );
  const unmatchedPrevious = previousItems.filter((candidate) => !assigned.has(candidate));
  if (unmatchedIndexes.length === 1 && unmatchedPrevious.length === 1) {
    const index = unmatchedIndexes[0];
    const node = index === undefined ? undefined : nodes[index];
    const candidate = unmatchedPrevious[0];
    if (index !== undefined && node !== undefined && candidate?.node.level === node.level) {
      exactMatches[index] = candidate;
      assigned.add(candidate);
    }
  }

  return nodes.map((node, index): MarkdownOutlineTreeItem => {
    let item = exactMatches[index];

    const wasCollapsible = item !== undefined && item.children.length > 0;
    if (item === undefined) {
      item = new MarkdownOutlineTreeItem(
        node,
        documentUri,
        documentVersion,
        createTreeStateId(),
        parent,
      );
    } else {
      item.update(node, documentVersion, parent);
    }
    item.children = reconcileItems(
      item.children,
      node.children,
      documentUri,
      documentVersion,
      item,
      newlyCollapsible,
      createTreeStateId,
    );
    if (!wasCollapsible && item.children.length > 0) {
      newlyCollapsible.push(item);
    }
    return item;
  });
}

function outlineLocalIdentity(identity: string): string {
  return identity.slice(identity.lastIndexOf("/") + 1);
}

function hasManuallyCollapsedAncestor(
  item: MarkdownOutlineTreeItem,
  manuallyCollapsedIds: ReadonlySet<string>,
): boolean {
  let ancestor = item.parent;
  while (ancestor !== undefined) {
    if (ancestor.id !== undefined && manuallyCollapsedIds.has(ancestor.id)) {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

function toProtocolText(text: string): string {
  return text.replaceAll("\r\n", "\n");
}
