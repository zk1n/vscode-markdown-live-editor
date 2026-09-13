import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import type { RichRequest } from "../../src/protocol/richMessages.js";
import {
  MarkdownEditorSessionRegistry,
  type MarkdownEditorSessionHandle,
} from "../../src/extension/editor/MarkdownEditorSessionRegistry.js";

const fake = vi.hoisted(() => {
  class FakeUri {
    public constructor(
      public readonly scheme: string,
      public readonly fsPath: string,
      private readonly value: string,
    ) {}
    public toString(): string {
      return this.value;
    }
  }
  class FakeRange {
    public constructor(
      public readonly start: unknown,
      public readonly end: unknown,
    ) {}
  }
  class FakeRelativePattern {
    public constructor(
      public readonly baseUri: FakeUri,
      public readonly pattern: string,
    ) {}
  }
  class FakeTabInputText {
    public constructor(public readonly uri: FakeUri) {}
  }
  class FakeTabInputCustom {
    public constructor(public readonly uri: FakeUri) {}
  }
  const watchers: {
    change: (uri: FakeUri) => void;
    dispose: ReturnType<typeof vi.fn>;
    listeners: Set<(uri: FakeUri) => void>;
  }[] = [];
  const state = {
    root: undefined as FakeUri | undefined,
    trusted: true,
    fileSystemWritable: true,
    filePermissions: undefined as number | undefined,
    configuration: new Map<string, unknown>(),
    documents: new Map<string, unknown>(),
    activeTab: undefined as { readonly input: FakeTabInputText | FakeTabInputCustom } | undefined,
    openExternal: vi.fn((): Promise<boolean> => Promise.resolve(true)),
    open: vi.fn((): Promise<void> => Promise.resolve()),
    showTextDocument: vi.fn((): Promise<void> => Promise.resolve()),
    showOpenDialog: vi.fn((): Promise<readonly FakeUri[] | undefined> =>
      Promise.resolve(undefined),
    ),
  };
  const file = (fsPath: string): FakeUri =>
    new FakeUri("file", fsPath, `file://${fsPath.replaceAll("\\", "/")}`);
  const parse = (value: string): FakeUri =>
    new FakeUri(new URL(value).protocol.slice(0, -1), "", value);
  const workspace = {
    textDocuments: [],
    createFileSystemWatcher: () => {
      const listeners = new Set<(uri: FakeUri) => void>();
      const subscribe = (listener: (uri: FakeUri) => void): { dispose: () => boolean } => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      };
      const watcher = {
        change: (uri: FakeUri) => {
          for (const listener of [...listeners]) listener(uri);
        },
        dispose: vi.fn(() => {
          listeners.clear();
        }),
        listeners,
      };
      watchers.push(watcher);
      return { ...watcher, onDidChange: subscribe, onDidCreate: subscribe, onDidDelete: subscribe };
    },
    get isTrusted(): boolean {
      return state.trusted;
    },
    getWorkspaceFolder: (): { readonly uri: FakeUri } | undefined =>
      state.root === undefined ? undefined : { uri: state.root },
    fs: {
      isWritableFileSystem: (): boolean => state.fileSystemWritable,
      stat: vi.fn((): Promise<{ readonly permissions?: number }> =>
        Promise.resolve(
          state.filePermissions === undefined ? {} : { permissions: state.filePermissions },
        ),
      ),
    },
    getConfiguration: (): { readonly get: <T>(key: string, fallback: T) => T } => ({
      get: <T>(key: string, fallback: T): T =>
        (state.configuration.get(key) as T | undefined) ?? fallback,
    }),
    openTextDocument: vi.fn((uri: FakeUri): Promise<unknown> =>
      Promise.resolve(state.documents.get(uri.fsPath)),
    ),
  };
  const webviewUris = vi.fn(
    (uri: FakeUri): FakeUri => new FakeUri("webview", "", `webview:${uri.toString()}`),
  );
  return {
    watchers,
    FakeUri,
    FakeRange,
    FakeTabInputCustom,
    file,
    state,
    workspace,
    webviewUris,
    vscode: {
      Uri: { file, parse },
      FilePermission: { Readonly: 1 },
      Range: FakeRange,
      RelativePattern: FakeRelativePattern,
      workspace,
      window: {
        showTextDocument: state.showTextDocument,
        showOpenDialog: state.showOpenDialog,
        tabGroups: {
          activeTabGroup: {
            get activeTab(): { readonly input: FakeTabInputText | FakeTabInputCustom } | undefined {
              return state.activeTab;
            },
          },
          onDidChangeTabs: (): { dispose: () => void } => ({ dispose: (): void => undefined }),
        },
      },
      TabInputText: FakeTabInputText,
      TabInputCustom: FakeTabInputCustom,
      Disposable: { from: (): { dispose: () => void } => ({ dispose: (): void => undefined }) },
      commands: { executeCommand: state.open },
      env: { openExternal: state.openExternal },
    },
  };
});

vi.mock("vscode", () => fake.vscode);

import {
  MarkdownLinkNavigator,
  MarkdownResourceSession,
  resourceRootsForDocument,
} from "../../src/extension/editor/markdownResources.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true });
});

beforeEach(() => {
  fake.watchers.length = 0;
  fake.state.root = undefined;
  fake.state.trusted = true;
  fake.state.fileSystemWritable = true;
  fake.state.filePermissions = undefined;
  fake.state.configuration.clear();
  fake.state.documents.clear();
  fake.state.activeTab = undefined;
  fake.state.openExternal.mockClear();
  fake.state.openExternal.mockResolvedValue(true);
  fake.state.open.mockClear();
  fake.state.showTextDocument.mockClear();
  fake.state.showOpenDialog.mockClear();
  fake.state.showOpenDialog.mockResolvedValue(undefined);
  fake.workspace.openTextDocument.mockClear();
  fake.webviewUris.mockClear();
  fake.workspace.fs.stat.mockClear();
});

describe("MarkdownResourceSession", () => {
  it("keeps webview options unchanged for an image covered by an existing allowed root", async () => {
    const fixture = await createFixture("![a](image.png)");
    await writeFile(
      path.join(fixture.root, "notes", "image.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const options = { localResourceRoots: [fake.file(fixture.root)] };
    Object.defineProperty(fixture.webview, "options", {
      configurable: true,
      get: () => options,
      set: () => {
        throw new Error("unnecessary Webview reload");
      },
    });
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      () => true,
    );
    await session.receive(request("image-resolve", "image.png"));
    expect(lastMessage(fixture.postMessage)).toMatchObject({ ok: true });
    session.invalidateImages();
    await session.receive(request("image-resolve", "image.png"));
    expect(lastMessage(fixture.postMessage)).toMatchObject({ ok: true });
    expect(fixture.webview.options).toBe(options);
    session.dispose();
  });
  it("invalidates actual image resources, prunes removed images and disposes all watchers", async () => {
    const fixture = await createFixture("![a](image.png)\n![b](image.png)");
    const imagePath = path.join(fixture.root, "notes", "image.png");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const invalidated = vi.fn();
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      () => true,
      false,
      invalidated,
    );
    await session.receive(request("image-resolve", "image.png"));
    const originalUrl = lastMessage(fixture.postMessage)["url"];
    const first = fake.watchers[0];
    expect(first).toBeDefined();
    first?.change(fake.file(path.join(fixture.root, "notes", "unrelated.md")));
    expect(invalidated).not.toHaveBeenCalled();
    first?.change(fake.file(imagePath));
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(first?.dispose).toHaveBeenCalledTimes(1);
    await session.receive(request("image-resolve", "image.png"));
    expect(lastMessage(fixture.postMessage)["url"]).not.toBe(originalUrl);
    session.pruneImageWatches("![b](image.png)");
    expect(fake.watchers[1]?.dispose).not.toHaveBeenCalled();
    session.pruneImageWatches("no image");
    expect(fake.watchers[1]?.dispose).toHaveBeenCalledTimes(1);
    await session.receive(request("image-resolve", "image.png"));
    session.dispose();
    expect(fake.watchers[2]?.dispose).toHaveBeenCalledTimes(1);
    first?.change(fake.file(imagePath));
    expect(invalidated).toHaveBeenCalledTimes(1);
  });
  it("reserves image import before the asynchronous capability check", async () => {
    const fixture = await createFixture();
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      () => true,
    );
    let release: (() => void) | undefined;
    fake.workspace.fs.stat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({});
          };
        }),
    );
    const first = session.receive({
      ...request("image-import", undefined, 1, 20),
      data: "iVBORw0KGgoB",
    });
    await session.receive({ ...request("image-import", undefined, 1, 21), data: "iVBORw0KGgoB" });
    expect(lastMessage(fixture.postMessage)).toMatchObject({
      ok: false,
      note: "画像の取り込み中です。",
    });
    release?.();
    await first;
    expect(lastMessage(fixture.postMessage)["ok"]).toBe(true);
  });
  it("suppresses stale and disposed responses, including a completion that became stale", async () => {
    const fixture = await createFixture();
    const current = vi.fn<(request: RichRequest) => boolean>().mockReturnValue(false);
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      current,
    );

    await session.receive(request("link-preview", "https://example.test/page"));
    expect(fixture.postMessage).not.toHaveBeenCalled();

    current.mockReturnValue(true);
    let complete: (() => void) | undefined;
    fake.state.openExternal.mockImplementationOnce(
      async (): Promise<boolean> =>
        await new Promise((resolve): void => {
          complete = (): void => {
            resolve(true);
          };
        }),
    );
    const pending = session.receive(request("link-open", "https://example.test/page"));
    current.mockReturnValue(false);
    complete?.();
    await pending;
    expect(fixture.postMessage).not.toHaveBeenCalled();

    current.mockReturnValue(true);
    session.dispose();
    await session.receive(request("link-preview", "https://example.test/page"));
    expect(fixture.postMessage).not.toHaveBeenCalled();
  });

  it("uses an already-open dirty document for previews and opens another document through its default editor", async () => {
    const fixture = await createFixture();
    const otherPath = path.join(fixture.root, "notes", "other.md");
    await writeFile(otherPath, "# Disk heading\nold");
    const other = document(otherPath, "# Current heading\nnew content", 3);
    fake.state.documents.set(otherPath, other);
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      (): boolean => true,
    );

    await session.receive(request("link-preview", "other.md#current-heading"));
    expect(fixture.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: true,
        title: "other.md",
        text: "# Current heading\nnew content",
      }),
    );

    await session.receive(request("link-open", "other.md#current-heading", 1, 4));
    const call = fake.state.open.mock.calls[0] as readonly unknown[] | undefined;
    expect(call?.[0]).toBe("vscode.open");
    expect(call?.[1]).toBe(other.uri);
    const options = call?.[2] as
      | {
          readonly preview: boolean;
          readonly selection: { readonly start: { readonly offset: number } };
        }
      | undefined;
    expect(options).toMatchObject({ preview: true, selection: { start: { offset: 0 } } });
  });
  it("returns same-document fragment offsets without opening a second editor", async () => {
    const fixture = await createFixture("before\n## Current heading\nafter");
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      (): boolean => true,
    );

    await session.receive(request("link-open", "#current-heading", 1, 7));

    expect(fixture.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, offset: 7 }),
    );
    expect(fake.state.showTextDocument).not.toHaveBeenCalled();
  });

  it("opens a Japanese, space-containing non-Markdown target through the default editor", async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.root, "notes", "日本語 note.txt");
    await writeFile(targetPath, "target");
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      (): boolean => true,
    );

    await session.receive(request("link-open", "%E6%97%A5%E6%9C%AC%E8%AA%9E%20note.txt", 1, 20));

    expect(fake.state.open).toHaveBeenCalledWith("vscode.open", fake.file(targetPath), {
      preview: true,
    });
    expect(lastMessage(fixture.postMessage)).toMatchObject({ ok: true });
  });

  it("delivers a pending heading only after the active target Live Editor reports ready", async () => {
    const fixture = await createFixture();
    const target = document(path.join(fixture.root, "notes", "other.md"), "# Heading", 3);
    const postMessage = vi.fn((): boolean => true);
    const handle: MarkdownEditorSessionHandle = {
      documentUri: target.uri.toString(),
      sessionId: "target-session",
      reveal: (): void => undefined,
      postMessage,
    };
    const registry = new MarkdownEditorSessionRegistry();
    registry.register(handle, true);
    registry.replaceController(handle.sessionId, "target-controller");
    const navigator = new MarkdownLinkNavigator(registry);
    fake.state.activeTab = {
      input: new fake.FakeTabInputCustom(
        target.uri as unknown as InstanceType<typeof fake.FakeUri>,
      ),
    };

    await navigator.open(
      target as unknown as VSCode.TextDocument,
      new fake.FakeRange({ offset: 0 }, { offset: 9 }) as unknown as VSCode.Range,
      {
        targetOffset: 0,
        highlightFrom: 0,
        highlightTo: 9,
      },
    );
    expect(postMessage).not.toHaveBeenCalled();

    expect(
      registry.reportEditorState(handle.sessionId, "target-controller", {
        reportSequence: 1,
        documentVersion: target.version,
        selectionAnchor: 0,
        selectionHead: 0,
        line: 0,
        column: 0,
        focused: true,
        composing: false,
        recoveryActive: false,
        barrierActive: false,
        insertSpaces: true,
        tabSize: 2,
      }),
    ).toBe(true);
    const ready = registry.activeStatusSession;
    expect(ready?.handle).toBe(handle);
    if (ready === undefined) throw new Error("target session did not become ready");
    navigator.deliverWhenReady(target as unknown as VSCode.TextDocument, ready.handle, true);

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "navigate-to-heading",
        documentUri: target.uri.toString(),
        documentVersion: 3,
        sessionId: "target-session",
        targetOffset: 0,
      }),
    );
  });

  it("supersedes an older pending target while its vscode.open is still resolving", async () => {
    const fixture = await createFixture();
    const older = document(path.join(fixture.root, "notes", "older.md"), "# Older", 1);
    const newer = document(path.join(fixture.root, "notes", "newer.md"), "# Newer", 1);
    const olderPost = vi.fn((): boolean => true);
    const newerPost = vi.fn((): boolean => true);
    let releaseOlderOpen: (() => void) | undefined;
    fake.state.open.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseOlderOpen = resolve;
        }),
    );
    const navigator = new MarkdownLinkNavigator();
    const olderOpen = navigator.open(
      older as unknown as VSCode.TextDocument,
      new fake.FakeRange({ offset: 0 }, { offset: 7 }) as unknown as VSCode.Range,
      { targetOffset: 0, highlightFrom: 0, highlightTo: 7 },
    );
    await Promise.resolve();
    fake.state.activeTab = {
      input: new fake.FakeTabInputCustom(newer.uri as unknown as InstanceType<typeof fake.FakeUri>),
    };
    await navigator.open(
      newer as unknown as VSCode.TextDocument,
      new fake.FakeRange({ offset: 0 }, { offset: 7 }) as unknown as VSCode.Range,
      { targetOffset: 0, highlightFrom: 0, highlightTo: 7 },
    );
    releaseOlderOpen?.();
    await olderOpen;

    navigator.deliverWhenReady(
      older as unknown as VSCode.TextDocument,
      {
        documentUri: older.uri.toString(),
        sessionId: "older",
        reveal: (): void => undefined,
        postMessage: olderPost,
      },
      true,
    );
    navigator.deliverWhenReady(
      newer as unknown as VSCode.TextDocument,
      {
        documentUri: newer.uri.toString(),
        sessionId: "newer",
        reveal: (): void => undefined,
        postMessage: newerPost,
      },
      true,
    );

    expect(olderPost).not.toHaveBeenCalled();
    expect(newerPost).toHaveBeenCalledTimes(1);
  });

  it("discards a version-drifted target and ignores a ready session for another document", async () => {
    const fixture = await createFixture();
    const target = document(path.join(fixture.root, "notes", "target.md"), "# Target", 5);
    const other = document(path.join(fixture.root, "notes", "other.md"), "# Other", 5);
    const targetPost = vi.fn((): boolean => true);
    const otherPost = vi.fn((): boolean => true);
    const navigator = new MarkdownLinkNavigator();
    fake.state.activeTab = {
      input: new fake.FakeTabInputCustom(
        target.uri as unknown as InstanceType<typeof fake.FakeUri>,
      ),
    };
    await navigator.open(
      target as unknown as VSCode.TextDocument,
      new fake.FakeRange({ offset: 0 }, { offset: 8 }) as unknown as VSCode.Range,
      { targetOffset: 0, highlightFrom: 0, highlightTo: 8 },
    );
    navigator.deliverWhenReady(
      target as unknown as VSCode.TextDocument,
      {
        documentUri: other.uri.toString(),
        sessionId: "other",
        reveal: (): void => undefined,
        postMessage: otherPost,
      },
      true,
    );
    expect(otherPost).not.toHaveBeenCalled();

    target.version = 6;
    navigator.deliverWhenReady(
      target as unknown as VSCode.TextDocument,
      {
        documentUri: target.uri.toString(),
        sessionId: "target",
        reveal: (): void => undefined,
        postMessage: targetPost,
      },
      true,
    );
    target.version = 5;
    navigator.deliverWhenReady(
      target as unknown as VSCode.TextDocument,
      {
        documentUri: target.uri.toString(),
        sessionId: "target",
        reveal: (): void => undefined,
        postMessage: targetPost,
      },
      true,
    );

    expect(targetPost).not.toHaveBeenCalled();
  });

  it("keeps a target navigation reservation when the source resource session disposes during vscode.open", async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.root, "notes", "target.md");
    await writeFile(targetPath, "# Target");
    const target = document(targetPath, "# Target", 2);
    fake.state.documents.set(targetPath, target);
    const targetPost = vi.fn((): boolean => true);
    const navigator = new MarkdownLinkNavigator();
    const source = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      (): boolean => true,
      false,
      undefined,
      navigator,
    );
    fake.state.activeTab = {
      input: new fake.FakeTabInputCustom(
        target.uri as unknown as InstanceType<typeof fake.FakeUri>,
      ),
    };
    fake.state.open.mockImplementationOnce((): Promise<void> => {
      source.dispose();
      return Promise.resolve();
    });

    await source.receive(request("link-open", "target.md#target"));
    navigator.deliverWhenReady(
      target as unknown as VSCode.TextDocument,
      {
        documentUri: target.uri.toString(),
        sessionId: "target",
        reveal: (): void => undefined,
        postMessage: targetPost,
      },
      true,
    );

    expect(targetPost).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "navigate-to-heading", documentVersion: 2, targetOffset: 0 }),
    );
  });

  it("requires trusted HTTPS opt-in for remote images and reports operation errors", async () => {
    const fixture = await createFixture();
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      (): boolean => true,
    );

    await session.receive(request("image-resolve", "http://example.test/image.png"));
    expect(lastMessage(fixture.postMessage)["ok"]).toBe(false);
    expect(lastMessage(fixture.postMessage)["note"]).toContain("外部画像は無効");

    fake.state.trusted = false;
    fake.state.configuration.set("allowRemoteImages", true);
    await session.receive(request("image-resolve", "https://example.test/image.png"));
    expect(lastMessage(fixture.postMessage)["ok"]).toBe(false);

    fake.state.trusted = true;
    // CSP and resolver use the same open-time permission snapshot; changing
    // settings alone cannot activate HTTPS inside a previously denied webview.
    await session.receive(request("image-resolve", "https://example.test/image.png"));
    expect(lastMessage(fixture.postMessage)["ok"]).toBe(false);
    const reopened = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      () => true,
      true,
    );
    await reopened.receive(request("image-resolve", "https://example.test/image.png"));
    expect(fixture.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: true, url: "https://example.test/image.png" }),
    );

    fake.state.openExternal.mockResolvedValueOnce(false);
    await session.receive(request("link-open", "https://example.test/page", 1, 8));
    expect(fixture.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, note: "リンクを開けませんでした。" }),
    );
  });

  it("rejects unsafe schemes and paths outside the workspace", async () => {
    const fixture = await createFixture();
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      (): boolean => true,
    );

    for (const target of ["command:run", "../../outside.md", "//server/file", "%zz"]) {
      await session.receive(request("link-preview", target));
      expect(fixture.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
    }
    expect(fake.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("uses a saved standalone document directory as its narrow local resource scope", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "markdown-standalone-resource-"));
    temporary.push(folder);
    const documentPath = path.join(folder, "source.md");
    const imagePath = path.join(folder, "image.png");
    await writeFile(documentPath, "![image](image.png)");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
    const source = document(documentPath, "![image](image.png)", 1);
    const postMessage = vi.fn((): Promise<boolean> => Promise.resolve(true));
    const webview = {
      options: {},
      postMessage,
      asWebviewUri: fake.webviewUris,
    } as unknown as VSCode.Webview;
    fake.state.root = undefined;
    const session = new MarkdownResourceSession(
      source as unknown as VSCode.TextDocument,
      webview,
      (): boolean => true,
    );

    expect(resourceRootsForDocument(source as unknown as VSCode.TextDocument)[0]?.fsPath).toBe(
      folder,
    );
    await session.receive(request("image-resolve", "image.png"));
    const response = lastMessage(postMessage);
    expect(response["ok"]).toBe(true);
    expect(typeof response["url"]).toBe("string");
    expect(webview.options.localResourceRoots).toEqual([fake.file(imagePath)]);

    await session.receive(request("link-preview", "../outside.md", 1, 12));
    expect(lastMessage(postMessage)).toMatchObject({ ok: false });
  });

  it("requires a Save As destination only when an untitled document imports an attachment", async () => {
    const fixture = await createFixture();
    fixture.document.isUntitled = true;
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      (): boolean => true,
    );

    await session.receive({
      ...request("image-import", undefined, 1, 13),
      data: "iVBORw0KGgoB",
    });

    expect(lastMessage(fixture.postMessage)).toMatchObject({
      ok: false,
      note: "画像やローカル参照を使う前に、文書の保存先を指定してください。",
    });
  });

  it("rejects automatic resources and attachments for a standalone document at a filesystem root", async () => {
    const filesystemRoot = path.parse(process.cwd()).root;
    const source = document(path.join(filesystemRoot, "source.md"), "![image](image.png)", 1);
    const postMessage = vi.fn((): Promise<boolean> => Promise.resolve(true));
    const webview = {
      options: {},
      postMessage,
      asWebviewUri: fake.webviewUris,
    } as unknown as VSCode.Webview;
    fake.state.root = undefined;
    const session = new MarkdownResourceSession(
      source as unknown as VSCode.TextDocument,
      webview,
      (): boolean => true,
    );

    expect(resourceRootsForDocument(source as unknown as VSCode.TextDocument)).toEqual([
      source.uri,
    ]);
    await session.receive(request("image-resolve", "image.png"));
    expect(lastMessage(postMessage)["ok"]).toBe(false);
    expect(String(lastMessage(postMessage)["note"])).toContain("自動読込");

    await session.receive({ ...request("image-import", undefined, 1, 14), data: "iVBORw0KGgoB" });
    expect(lastMessage(postMessage)["ok"]).toBe(false);
    expect(String(lastMessage(postMessage)["note"])).toContain("添付画像を作成できません");
  });

  it("rejects image imports before attachment creation when the document is readonly", async () => {
    const fixture = await createFixture();
    fake.state.filePermissions = 1;
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      (): boolean => true,
    );

    await session.receive({ ...request("image-import", undefined, 1, 15), data: "iVBORw0KGgoB" });

    expect(lastMessage(fixture.postMessage)).toMatchObject({
      ok: false,
      note: "この文書は読み取り専用です。",
    });
    await expect(stat(path.join(fixture.root, "notes", "attachments"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not write after cancellation or mid-picker drift, and never returns Markdown after an attachment-time drift", async () => {
    const fixture = await createFixture();
    const session = new MarkdownResourceSession(
      fixture.document as unknown as VSCode.TextDocument,
      fixture.webview,
      (): boolean => true,
    );

    await session.receive(request("image-pick", undefined, 1, 9));
    expect(fixture.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true }));
    expect(fixture.postMessage.mock.calls.at(-1)?.[0]).not.toHaveProperty("markdown");

    const selected = path.join(fixture.root, "selected.png");
    await writeFile(selected, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
    fake.state.showOpenDialog.mockImplementationOnce(
      (): Promise<readonly InstanceType<typeof fake.FakeUri>[]> => {
        fixture.document.version = 2;
        return Promise.resolve([fake.file(selected)]);
      },
    );
    await session.receive(request("image-pick", undefined, 1, 10));
    expect(lastMessage(fixture.postMessage)["note"]).toBe(
      "文書が更新されました。もう一度操作してください。",
    );
    await expect(stat(path.join(fixture.root, "notes", "attachments"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    fixture.document.version = 1;
    Object.defineProperty(fixture.document, "version", {
      configurable: true,
      get: (): number => (existsSync(path.join(fixture.root, "notes", "attachments")) ? 2 : 1),
    });
    fake.state.showOpenDialog.mockResolvedValueOnce([fake.file(selected)]);
    await session.receive(request("image-pick", undefined, 1, 11));
    const attachmentDirectory = await stat(path.join(fixture.root, "notes", "attachments"));
    expect(attachmentDirectory.isDirectory()).toBe(true);
    expect(lastMessage(fixture.postMessage)["ok"]).toBe(false);
    expect(lastMessage(fixture.postMessage)).not.toHaveProperty("markdown");
  });
});

function request(
  operation: RichRequest["operation"],
  target?: string,
  documentVersion = 1,
  requestId = 1,
): RichRequest {
  return {
    kind: "rich-request",
    protocolVersion: 2,
    documentUri: "file:///source.md",
    sessionId: "session",
    controllerId: "controller",
    requestId,
    documentVersion,
    operation,
    ...(target === undefined ? {} : { target }),
  };
}

function document(
  fsPath: string,
  text: string,
  version: number,
): {
  uri: VSCode.Uri;
  isUntitled: boolean;
  isClosed: boolean;
  version: number;
  getText: () => string;
  positionAt: (offset: number) => { offset: number };
  offsetAt: (position: { readonly offset: number }) => number;
  lineAt: (line: number) => {
    readonly range: {
      readonly start: { readonly offset: number };
      readonly end: { readonly offset: number };
    };
  };
} {
  const lineStart = (line: number): number => {
    let offset = 0;
    for (let index = 0; index < line; index += 1) offset = text.indexOf("\n", offset) + 1;
    return offset;
  };
  return {
    uri: fake.file(fsPath) as unknown as VSCode.Uri,
    isUntitled: false,
    isClosed: false,
    version,
    getText: (): string => text,
    positionAt: (offset: number): { offset: number } => ({ offset }),
    offsetAt: (position: { readonly offset: number }): number => position.offset,
    lineAt: (line: number) => {
      const start = lineStart(line);
      const end = text.indexOf("\n", start);
      return { range: { start: { offset: start }, end: { offset: end < 0 ? text.length : end } } };
    },
  };
}

async function createFixture(text = "# Source"): Promise<{
  readonly root: string;
  readonly document: ReturnType<typeof document>;
  readonly postMessage: ReturnType<typeof vi.fn>;
  readonly webview: VSCode.Webview;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "markdown-resource-session-"));
  temporary.push(root);
  const notes = path.join(root, "notes");
  await mkdir(notes);
  const sourcePath = path.join(notes, "source.md");
  await writeFile(sourcePath, text);
  const source = document(sourcePath, text, 1);
  fake.state.root = fake.file(root);
  fake.state.documents.set(sourcePath, source);
  const postMessage = vi.fn((): Promise<boolean> => Promise.resolve(true));
  const webview = {
    options: {},
    postMessage,
    asWebviewUri: fake.webviewUris,
  } as unknown as VSCode.Webview;
  return { root, document: source, postMessage, webview };
}

function lastMessage(postMessage: ReturnType<typeof vi.fn>): Readonly<Record<string, unknown>> {
  const call = postMessage.mock.calls.at(-1) as readonly unknown[] | undefined;
  const message = call?.[0];
  if (typeof message !== "object" || message === null) throw new Error("Expected a rich response.");
  return message as Readonly<Record<string, unknown>>;
}
