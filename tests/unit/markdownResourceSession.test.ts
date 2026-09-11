import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";
import type { RichRequest } from "../../src/protocol/richMessages.js";

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
  const state = {
    root: undefined as FakeUri | undefined,
    trusted: true,
    configuration: new Map<string, unknown>(),
    documents: new Map<string, unknown>(),
    openExternal: vi.fn((): Promise<boolean> => Promise.resolve(true)),
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
    get isTrusted(): boolean {
      return state.trusted;
    },
    getWorkspaceFolder: (): { readonly uri: FakeUri } | undefined =>
      state.root === undefined ? undefined : { uri: state.root },
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
    FakeUri,
    FakeRange,
    file,
    state,
    workspace,
    webviewUris,
    vscode: {
      Uri: { file, parse },
      Range: FakeRange,
      workspace,
      window: { showTextDocument: state.showTextDocument, showOpenDialog: state.showOpenDialog },
      env: { openExternal: state.openExternal },
    },
  };
});

vi.mock("vscode", () => fake.vscode);

import { MarkdownResourceSession } from "../../src/extension/editor/markdownResources.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true });
});

beforeEach(() => {
  fake.state.root = undefined;
  fake.state.trusted = true;
  fake.state.configuration.clear();
  fake.state.documents.clear();
  fake.state.openExternal.mockClear();
  fake.state.openExternal.mockResolvedValue(true);
  fake.state.showTextDocument.mockClear();
  fake.state.showOpenDialog.mockClear();
  fake.state.showOpenDialog.mockResolvedValue(undefined);
  fake.workspace.openTextDocument.mockClear();
  fake.webviewUris.mockClear();
});

describe("MarkdownResourceSession", () => {
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

  it("uses an already-open dirty document for previews and opens another document at its heading", async () => {
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
    const call = fake.state.showTextDocument.mock.calls[0] as readonly unknown[] | undefined;
    expect(call?.[0]).toBe(other);
    const options = call?.[1] as
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
    let versionReads = 0;
    Object.defineProperty(fixture.document, "version", {
      configurable: true,
      get: (): number => {
        versionReads += 1;
        return versionReads === 3 ? 2 : 1;
      },
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
} {
  return {
    uri: fake.file(fsPath) as unknown as VSCode.Uri,
    isUntitled: false,
    isClosed: false,
    version,
    getText: (): string => text,
    positionAt: (offset: number): { offset: number } => ({ offset }),
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
