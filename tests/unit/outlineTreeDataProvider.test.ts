import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownEditorSessionRegistry } from "../../src/extension/editor/MarkdownEditorSessionRegistry.js";
import {
  MarkdownOutlineTreeItem,
  MarkdownOutlineTreeProvider,
} from "../../src/extension/outline/MarkdownOutlineTreeProvider.js";
import { PROTOCOL_VERSION, type HostToWebviewMessage } from "../../src/protocol/messages.js";
import { TreeItemCollapsibleState, setTextDocuments } from "../support/vscodeMock.js";

afterEach((): void => {
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
