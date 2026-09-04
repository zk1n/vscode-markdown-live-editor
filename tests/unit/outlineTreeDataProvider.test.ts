import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownEditorSessionRegistry } from "../../src/extension/editor/MarkdownEditorSessionRegistry.js";
import {
  MarkdownOutlineTreeItem,
  MarkdownOutlineTreeProvider,
  type MarkdownOutlineTreeView,
} from "../../src/extension/outline/MarkdownOutlineTreeProvider.js";
import { PROTOCOL_VERSION, type HostToWebviewMessage } from "../../src/protocol/messages.js";
import { TreeItemCollapsibleState, setTextDocuments } from "../support/vscodeMock.js";

afterEach((): void => {
  vi.useRealTimers();
  setTextDocuments([]);
});

describe("MarkdownOutlineTreeProvider", () => {
  it("maps authoritative roots and children to native collapsible TreeItems", () => {
    const document = fakeDocument("file:///outline.md", 1, "# A\n## B\n### C\n## D\n# E");
    setTextDocuments([document]);
    const { provider } = createProvider(document.uri.toString());

    const roots = provider.getChildren();
    expect(roots.map((item) => item.label)).toEqual(["A", "E"]);
    expect(roots[0]?.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(roots[1]?.collapsibleState).toBe(TreeItemCollapsibleState.None);
    const children = provider.getChildren(roots[0]);
    expect(children.map((item) => item.label)).toEqual(["B", "D"]);
    expect(children[0]?.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(provider.getChildren(children[0]).map((item) => item.label)).toEqual(["C"]);
  });

  it("keeps duplicate item identities distinct without using their offsets as the stable key", () => {
    const document = fakeDocument("file:///outline.md", 1, "# Same\n# Same");
    setTextDocuments([document]);
    const { provider } = createProvider(document.uri.toString());

    const [first, second] = provider.getChildren();
    expect(first?.id).not.toBe(second?.id);
    const beforeInsertionIds = provider.getChildren().map((item) => item.id);
    const changed = fakeDocument(document.uri.toString(), 2, "plain\n# Same\n# Same");
    setTextDocuments([changed]);
    provider.handleDocumentChange(changed);
    expect(provider.getChildren().map((item) => item.id)).toEqual(beforeInsertionIds);
  });

  it("updates stable items without refreshing when only version or source ranges change", async () => {
    const document = fakeDocument("file:///outline.md", 1, "# A\nbody");
    setTextDocuments([document]);
    const messages: HostToWebviewMessage[] = [];
    const sessions = new MarkdownEditorSessionRegistry();
    sessions.register(
      {
        documentUri: document.uri.toString(),
        sessionId: "session-a",
        reveal: (): void => undefined,
        postMessage: (message): boolean => {
          messages.push(message);
          return true;
        },
      },
      true,
    );
    const provider = new MarkdownOutlineTreeProvider(sessions);
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    const [before] = provider.getChildren();
    if (before === undefined) throw new Error("Expected a stable Outline item.");

    const bodyChanged = fakeDocument(document.uri.toString(), 2, "# A\nchanged body");
    setTextDocuments([bodyChanged]);
    provider.handleDocumentChange(bodyChanged);

    const [afterBodyChange] = provider.getChildren();
    expect(afterBodyChange).toBe(before);
    expect(before.documentVersion).toBe(2);
    expect(listener).not.toHaveBeenCalled();

    const shifted = fakeDocument(document.uri.toString(), 3, "plain\n# A\nchanged body");
    setTextDocuments([shifted]);
    provider.handleDocumentChange(shifted);

    const [afterShift] = provider.getChildren();
    expect(afterShift).toBe(before);
    expect(before.node.from).toBe(6);
    expect(before.documentVersion).toBe(3);
    expect(listener).not.toHaveBeenCalled();
    expect(await provider.navigateTo(before)).toBe(true);
    expect(messages.at(-1)).toMatchObject({
      documentVersion: 3,
      targetOffset: 8,
      highlightFrom: 6,
    });
  });

  it("emits one refresh for a heading change while preserving unique matched item identities", async () => {
    const document = fakeDocument("file:///outline.md", 1, "# A\n## B");
    setTextDocuments([document]);
    const { provider } = createProvider(document.uri.toString());
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    const treeView = createFakeTreeView();
    provider.attachTreeView(treeView.view);
    const [root] = provider.getChildren();
    const [child] = provider.getChildren(root);
    if (root === undefined || child === undefined) throw new Error("Expected nested headings.");
    const rootId = root.id;
    const childId = child.id;
    treeView.collapse(root);

    const renamed = fakeDocument(document.uri.toString(), 2, "# Renamed\n## B");
    setTextDocuments([renamed]);
    provider.handleDocumentChange(renamed);

    const [renamedRoot] = provider.getChildren();
    const [renamedChild] = provider.getChildren(renamedRoot);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(renamedRoot).toBe(root);
    expect(renamedChild).toBe(child);
    expect(renamedRoot?.id).toBe(rootId);
    expect(renamedChild?.id).toBe(childId);
    expect(renamedRoot?.label).toBe("Renamed");

    const undone = fakeDocument(document.uri.toString(), 3, "# A\n## B");
    setTextDocuments([undone]);
    provider.handleDocumentChange(undone);
    const redone = fakeDocument(document.uri.toString(), 4, "# Renamed\n## B");
    setTextDocuments([redone]);
    provider.handleDocumentChange(redone);

    expect(listener).toHaveBeenCalledTimes(3);
    expect(provider.getChildren()[0]).toBe(root);
    expect(provider.getChildren()[0]?.id).toBe(rootId);
    expect(treeView.reveal).not.toHaveBeenCalled();

    const oldLabelReintroduced = fakeDocument(document.uri.toString(), 5, "# Renamed\n## B\n# A");
    setTextDocuments([oldLabelReintroduced]);
    provider.handleDocumentChange(oldLabelReintroduced);
    const [currentRoot, reintroduced] = provider.getChildren();
    if (currentRoot === undefined || reintroduced === undefined) {
      throw new Error("Expected both the renamed and reintroduced headings.");
    }
    expect(new Set([currentRoot.id, reintroduced.id]).size).toBe(2);
    expect(currentRoot.id).toBe(rootId);
    expect(await provider.navigateTo(currentRoot)).toBe(true);
    expect(await provider.navigateTo(reintroduced)).toBe(true);
  });

  it("does not transplant presentation identities across an ambiguous multi-heading rewrite", () => {
    const document = fakeDocument("file:///outline.md", 1, "# A\n# B");
    setTextDocuments([document]);
    const { provider } = createProvider(document.uri.toString());
    const previousIds = new Set(provider.getChildren().map((item) => item.id));

    const rewritten = fakeDocument(document.uri.toString(), 2, "# C\n# D");
    setTextDocuments([rewritten]);
    provider.handleDocumentChange(rewritten);

    const currentIds = provider.getChildren().map((item) => item.id);
    expect(currentIds.every((id) => !previousIds.has(id))).toBe(true);
    expect(new Set(currentIds).size).toBe(2);
  });

  it("expands a newly collapsible heading once without overriding a manual collapse", () => {
    const document = fakeDocument("file:///outline.md", 1, "# A");
    setTextDocuments([document]);
    const { provider } = createProvider(document.uri.toString());
    const treeView = createFakeTreeView();
    provider.attachTreeView(treeView.view);
    const [root] = provider.getChildren();
    if (root === undefined) throw new Error("Expected a root heading.");
    const rootId = root.id;
    expect(treeView.reveal).not.toHaveBeenCalled();

    const withChild = fakeDocument(document.uri.toString(), 2, "# A\n## B");
    setTextDocuments([withChild]);
    provider.handleDocumentChange(withChild);

    expect(provider.getChildren()[0]).toBe(root);
    expect(root.id).toBe(rootId);
    expect(root.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(provider.getChildren(root).map((item) => item.label)).toEqual(["B"]);
    expect(treeView.reveal).toHaveBeenCalledOnce();
    expect(treeView.reveal).toHaveBeenCalledWith(root, {
      select: false,
      focus: false,
      expand: true,
    });

    treeView.collapse(root);
    const leafAgain = fakeDocument(document.uri.toString(), 3, "# A");
    setTextDocuments([leafAgain]);
    provider.handleDocumentChange(leafAgain);
    const childAgain = fakeDocument(document.uri.toString(), 4, "# A\n## B");
    setTextDocuments([childAgain]);
    provider.handleDocumentChange(childAgain);

    expect(treeView.reveal).toHaveBeenCalledTimes(1);
    expect(root.id).toBe(rootId);
  });

  it("does not reveal a new descendant through a manually collapsed ancestor", () => {
    const document = fakeDocument("file:///outline.md", 1, "# A\n## B");
    setTextDocuments([document]);
    const { provider } = createProvider(document.uri.toString());
    const treeView = createFakeTreeView();
    provider.attachTreeView(treeView.view);
    const [root] = provider.getChildren();
    const [child] = provider.getChildren(root);
    if (root === undefined || child === undefined) throw new Error("Expected nested headings.");
    treeView.collapse(root);

    const grandchild = fakeDocument(document.uri.toString(), 2, "# A\n## B\n### C");
    setTextDocuments([grandchild]);
    provider.handleDocumentChange(grandchild);

    expect(child.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(treeView.reveal).not.toHaveBeenCalled();
    treeView.expand(root);
    expect(treeView.reveal).toHaveBeenCalledWith(child, {
      select: false,
      focus: false,
      expand: true,
    });
  });

  it("retries a rejected initial expansion once without another edit or redundant refresh", async () => {
    vi.useFakeTimers();
    const document = fakeDocument("file:///outline.md", 1, "# A");
    setTextDocuments([document]);
    const { provider } = createProvider(document.uri.toString());
    const treeView = createFakeTreeView();
    provider.attachTreeView(treeView.view);
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    treeView.rejectNextReveal();

    const withChild = fakeDocument(document.uri.toString(), 2, "# A\n## B");
    setTextDocuments([withChild]);
    provider.handleDocumentChange(withChild);
    await Promise.resolve();
    await Promise.resolve();
    expect(treeView.reveal).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();

    expect(treeView.reveal).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not recreate an expansion retry after the provider is disposed", async () => {
    vi.useFakeTimers();
    const document = fakeDocument("file:///outline.md", 1, "# A");
    setTextDocuments([document]);
    const { provider } = createProvider(document.uri.toString());
    const treeView = createFakeTreeView();
    provider.attachTreeView(treeView.view);
    treeView.rejectNextReveal();

    const withChild = fakeDocument(document.uri.toString(), 2, "# A\n## B");
    setTextDocuments([withChild]);
    provider.handleDocumentChange(withChild);
    provider.dispose();
    await Promise.resolve();
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(treeView.reveal).toHaveBeenCalledTimes(1);
  });

  it("refreshes on authoritative change and switches with the last-active editor", () => {
    const firstDocument = fakeDocument("file:///a.md", 1, "# A");
    const secondDocument = fakeDocument("file:///b.md", 4, "# B");
    setTextDocuments([firstDocument, secondDocument]);
    const sessions = new MarkdownEditorSessionRegistry();
    const first = sessions.register(fakeSession(firstDocument.uri.toString(), "a"), true);
    const provider = new MarkdownOutlineTreeProvider(sessions);
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);

    expect(provider.getChildren().map((item) => item.label)).toEqual(["A"]);
    const second = sessions.register(fakeSession(secondDocument.uri.toString(), "b"), true);
    expect(provider.getChildren().map((item) => item.label)).toEqual(["B"]);
    const renamed = fakeDocument(secondDocument.uri.toString(), 5, "# Renamed\n## Child");
    setTextDocuments([firstDocument, renamed]);
    provider.handleDocumentChange(renamed);
    expect(provider.getChildren().map((item) => item.label)).toEqual(["Renamed"]);
    expect(listener).toHaveBeenCalled();

    second.dispose();
    expect(provider.getChildren().map((item) => item.label)).toEqual(["A"]);
    first.dispose();
    expect(provider.getChildren()).toEqual([]);
  });

  it("reveals and sends an identity/version-bound presentation-only navigation message", async () => {
    const document = fakeDocument("file:///outline.md", 7, "### Heading\nbody");
    setTextDocuments([document]);
    const reveal = vi.fn();
    const messages: HostToWebviewMessage[] = [];
    const sessions = new MarkdownEditorSessionRegistry();
    sessions.register(
      {
        documentUri: document.uri.toString(),
        sessionId: "session-a",
        reveal,
        postMessage: (message): boolean => {
          messages.push(message);
          return true;
        },
      },
      true,
    );
    const provider = new MarkdownOutlineTreeProvider(sessions);
    const [item] = provider.getChildren();
    expect(item).toBeInstanceOf(MarkdownOutlineTreeItem);
    if (item === undefined) throw new Error("Expected an Outline item.");

    expect(await provider.navigateTo(item)).toBe(true);
    expect(reveal).toHaveBeenCalledOnce();
    expect(messages).toEqual([
      {
        kind: "navigate-to-heading",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: document.uri.toString(),
        documentVersion: 7,
        sessionId: "session-a",
        targetOffset: 4,
        highlightFrom: 0,
        highlightTo: 11,
      },
    ]);
    expect(document.getText()).toBe("### Heading\nbody");
  });

  it("uses canonical LF offsets for CRLF TextDocument source", async () => {
    const source = "# A\r\n## 日本語";
    const document = fakeDocument("file:///crlf.md", 3, source);
    setTextDocuments([document]);
    const messages: HostToWebviewMessage[] = [];
    const sessions = new MarkdownEditorSessionRegistry();
    sessions.register(
      {
        documentUri: document.uri.toString(),
        sessionId: "crlf-session",
        reveal: (): void => undefined,
        postMessage: (message): boolean => {
          messages.push(message);
          return true;
        },
      },
      true,
    );
    const provider = new MarkdownOutlineTreeProvider(sessions);
    const [root] = provider.getChildren();
    const [japanese] = provider.getChildren(root);
    if (japanese === undefined) throw new Error("Expected a Japanese child heading.");

    expect(await provider.navigateTo(japanese)).toBe(true);
    expect(messages.at(-1)).toMatchObject({
      kind: "navigate-to-heading",
      targetOffset: 7,
      highlightFrom: 4,
      highlightTo: 10,
    });
    expect(document.getText()).toBe(source);
  });

  it("rejects stale items and disposed sessions without revealing or posting", async () => {
    const document = fakeDocument("file:///outline.md", 1, "# Old");
    setTextDocuments([document]);
    const reveal = vi.fn();
    const postMessage = vi.fn(() => true);
    const sessions = new MarkdownEditorSessionRegistry();
    const registration = sessions.register(
      { documentUri: document.uri.toString(), sessionId: "session-a", reveal, postMessage },
      true,
    );
    const provider = new MarkdownOutlineTreeProvider(sessions);
    const [staleItem] = provider.getChildren();
    if (staleItem === undefined) throw new Error("Expected a stale Outline item fixture.");
    setTextDocuments([fakeDocument(document.uri.toString(), 2, "# New")]);

    expect(await provider.navigateTo(staleItem)).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    registration.dispose();
    expect(await provider.navigateTo(staleItem)).toBe(false);
  });

  it("rejects an item after the last-active Live Editor switches documents", async () => {
    const firstDocument = fakeDocument("file:///a.md", 1, "# A");
    const secondDocument = fakeDocument("file:///b.md", 1, "# B");
    setTextDocuments([firstDocument, secondDocument]);
    const firstPost = vi.fn(() => true);
    const secondPost = vi.fn(() => true);
    const sessions = new MarkdownEditorSessionRegistry();
    sessions.register(
      {
        documentUri: firstDocument.uri.toString(),
        sessionId: "session-a",
        reveal: (): void => undefined,
        postMessage: firstPost,
      },
      true,
    );
    const provider = new MarkdownOutlineTreeProvider(sessions);
    const [firstItem] = provider.getChildren();
    if (firstItem === undefined) throw new Error("Expected the first document item.");
    sessions.register(
      {
        documentUri: secondDocument.uri.toString(),
        sessionId: "session-b",
        reveal: (): void => undefined,
        postMessage: secondPost,
      },
      true,
    );

    expect(await provider.navigateTo(firstItem)).toBe(false);
    expect(firstPost).not.toHaveBeenCalled();
    expect(secondPost).not.toHaveBeenCalled();
    expect(provider.getChildren().map((item) => item.label)).toEqual(["B"]);
  });
});

function createProvider(documentUri: string): {
  readonly provider: MarkdownOutlineTreeProvider;
} {
  const sessions = new MarkdownEditorSessionRegistry();
  sessions.register(fakeSession(documentUri, "session"), true);
  return { provider: new MarkdownOutlineTreeProvider(sessions) };
}

function fakeSession(
  documentUri: string,
  sessionId: string,
): {
  readonly documentUri: string;
  readonly sessionId: string;
  readonly reveal: () => void;
  readonly postMessage: () => boolean;
} {
  return {
    documentUri,
    sessionId,
    reveal: (): void => undefined,
    postMessage: (): boolean => true,
  };
}

function fakeDocument(
  uri: string,
  version: number,
  text: string,
): {
  readonly uri: { toString(): string };
  readonly version: number;
  getText(): string;
} {
  return {
    uri: { toString: (): string => uri },
    version,
    getText: (): string => text,
  };
}

function createFakeTreeView(): {
  readonly view: MarkdownOutlineTreeView;
  readonly reveal: ReturnType<typeof vi.fn>;
  readonly collapse: (element: MarkdownOutlineTreeItem) => void;
  readonly expand: (element: MarkdownOutlineTreeItem) => void;
  readonly rejectNextReveal: () => void;
} {
  let collapseListener:
    ((event: { readonly element: MarkdownOutlineTreeItem }) => unknown) | undefined;
  let expandListener:
    ((event: { readonly element: MarkdownOutlineTreeItem }) => unknown) | undefined;
  let rejectNextReveal = false;
  const reveal = vi.fn(() => {
    if (rejectNextReveal) {
      rejectNextReveal = false;
      return Promise.reject(new Error("Tree refresh still settling."));
    }
    return Promise.resolve();
  });
  const view: MarkdownOutlineTreeView = {
    visible: true,
    onDidCollapseElement: (listener) => {
      collapseListener = listener;
      return {
        dispose: (): void => {
          collapseListener = undefined;
        },
      };
    },
    onDidExpandElement: (listener) => {
      expandListener = listener;
      return {
        dispose: (): void => {
          expandListener = undefined;
        },
      };
    },
    onDidChangeVisibility: () => ({ dispose: (): void => undefined }),
    reveal,
  };
  return {
    view,
    reveal,
    collapse: (element): void => {
      collapseListener?.({ element });
    },
    expand: (element): void => {
      expandListener?.({ element });
    },
    rejectNextReveal: (): void => {
      rejectNextReveal = true;
    },
  };
}
