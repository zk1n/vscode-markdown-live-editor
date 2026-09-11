import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const openInterception = vi.hoisted(() => ({
  beforeOpen: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const hook = openInterception.beforeOpen;
      openInterception.beforeOpen = undefined;
      await hook?.();
      return await actual.open(...args);
    },
  };
});

import { findMarkdownLinks, headingOffset } from "../../src/core/markdown/markdownLinks.js";
import {
  isWithin,
  localMarkdownTarget,
  storeAttachment,
} from "../../src/extension/editor/markdownResources.js";
import {
  decodeRichRequest,
  decodeRichResponse,
  MAX_IMAGE_BYTES,
} from "../../src/protocol/richMessages.js";
import { PROTOCOL_VERSION } from "../../src/protocol/messages.js";

const temporary: string[] = [];
afterEach(async () => {
  openInterception.beforeOpen = undefined;
  for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true });
});
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const identity = {
  protocolVersion: PROTOCOL_VERSION,
  documentUri: "file:///note.md",
  sessionId: "session",
  controllerId: "controller",
};

describe("Markdown links retain source destinations", () => {
  it("resolves inline/title, full/collapsed/shortcut reference and image without reading HTML", () => {
    const text =
      '[日本語](<a b.md#節> "説明") ![alt][img] [ref][] [ref]\n\n[img]: assets/p.png "画像"\n[ref]: note.md#heading\n`[code](no.md)`';
    expect(
      findMarkdownLinks(text).map(({ target, image, title }) => ({ target, image, title })),
    ).toEqual([
      { target: "a b.md#節", image: false, title: "説明" },
      { target: "assets/p.png", image: true, title: "画像" },
      { target: "note.md#heading", image: false, title: undefined },
      { target: "note.md#heading", image: false, title: undefined },
    ]);
  });
  it("keeps escaped parentheses, entities and Japanese paths, ignores frontmatter/fences", () => {
    const text =
      "---\nx: [bad](hidden.md)\n---\n[リンク](a\\(b\\).md?x=1&amp;y=2)\n```\n[bad](no.md)\n```";
    expect(findMarkdownLinks(text).map((link) => link.target)).toEqual(["a(b).md?x=1&y=2"]);
  });
  it("resolves Japanese, duplicate headings and setext headings with code/frontmatter excluded", () => {
    const text =
      "---\n# fake\n---\n# 日本語 見出し\n\n## Repeat\n\n## Repeat\n\nSetext\n---\n\n```\n# hidden\n```";
    expect(headingOffset(text, encodeURIComponent("日本語-見出し"))).toBe(text.indexOf("# 日本語"));
    expect(headingOffset(text, "repeat-1")).toBe(text.lastIndexOf("## Repeat"));
    expect(headingOffset(text, "setext")).toBe(text.indexOf("Setext"));
    expect(headingOffset(text, "fake")).toBeUndefined();
    expect(headingOffset(text, "hidden")).toBeUndefined();
  });
});

describe("workspace attachment and path boundary", () => {
  const root = path.resolve("/workspace");
  const doc = path.join(root, "notes", "note.md");
  it("resolves relative, workspace-root, percent-encoded and same-document fragments", () => {
    expect(localMarkdownTarget(doc, root, "../assets/a%20b.png").path).toBe(
      path.join(root, "assets", "a b.png"),
    );
    expect(localMarkdownTarget(doc, root, "/notes/日本語.md#節")).toEqual({
      path: path.join(root, "notes", "日本語.md"),
      fragment: "節",
    });
    expect(localMarkdownTarget(doc, root, "#section").path).toBe(doc);
  });
  it.each([
    "../../outside.md",
    "%2e%2e/%2e%2e/outside.md",
    "file:///secret",
    "command:run",
    "data:text/plain,x",
    "javascript:alert(1)",
    "//server/file",
    "\\\\server\\file",
    "C:/secret.md",
    "bad%00.md",
    "%zz",
  ])("rejects %j", (target) => {
    expect(() => localMarkdownTarget(doc, root, target)).toThrow();
  });
  it("keeps root-prefix lookalikes outside", () => {
    expect(isWithin(root, `${root}-private/file`)).toBe(false);
  });
  it("copies only explicit valid images with unique exclusive names and leaves files after document Undo", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "live-editor-attachment-"));
    temporary.push(folder);
    const document = path.join(folder, "note.md");
    await writeFile(document, "# note");
    const first = await storeAttachment(document, folder, "attachments", "図.png", png);
    const second = await storeAttachment(document, folder, "attachments", "図.png", png);
    expect(first).not.toBe(second);
    expect(await readFile(path.join(folder, decodeURIComponent(first)))).toEqual(Buffer.from(png));
    expect(await readFile(document, "utf8")).toBe("# note");
    await expect(
      storeAttachment(document, folder, "../outside", "image.png", png),
    ).rejects.toThrow();
    await expect(
      storeAttachment(document, folder, "attachments", "fake.png", Uint8Array.from([0, 1, 2])),
    ).rejects.toThrow();
    await expect(
      storeAttachment(
        document,
        folder,
        "attachments",
        "big.png",
        new Uint8Array(MAX_IMAGE_BYTES + 1),
      ),
    ).rejects.toThrow();
  });
  it("rejects an attachment directory junction escaping the workspace", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "live-editor-attachment-link-"));
    temporary.push(parent);
    const folder = path.join(parent, "workspace");
    const outside = path.join(parent, "outside");
    await mkdir(folder);
    await mkdir(outside);
    const document = path.join(folder, "note.md");
    await writeFile(document, "note");
    await symlink(await realpath(outside), path.join(folder, "attachments"), "junction");
    await expect(
      storeAttachment(document, folder, "attachments", "image.png", png),
    ).rejects.toThrow("ワークスペース外");
  });
  it("does not write image content when a validated attachment directory becomes a junction before open", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "live-editor-attachment-race-"));
    temporary.push(parent);
    const workspace = path.join(parent, "workspace");
    const outside = path.join(parent, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    const document = path.join(workspace, "note.md");
    await writeFile(document, "note");
    const attachments = path.join(workspace, "attachments");
    openInterception.beforeOpen = async (): Promise<void> => {
      await rm(attachments, { recursive: true, force: true });
      await symlink(await realpath(outside), attachments, "junction");
    };

    await expect(
      storeAttachment(document, workspace, "attachments", "image.png", png),
    ).rejects.toThrow("添付先が操作中に変更されました。");

    const files = await (await import("node:fs/promises")).readdir(outside);
    expect(files).toHaveLength(1);
    const staged = files[0];
    if (staged === undefined)
      throw new Error("The race probe did not create its exclusive staging file.");
    expect(await readFile(path.join(outside, staged))).toEqual(Buffer.alloc(0));
  });
});

describe("rich protocol validation", () => {
  it("bounds requests and rejects malformed identities/payloads before host access", () => {
    const request = {
      ...identity,
      kind: "rich-request",
      requestId: 1,
      documentVersion: 2,
      operation: "image-resolve",
      target: "image.png",
    };
    expect(decodeRichRequest(request)).toEqual(request);
    expect(decodeRichRequest({ ...request, operation: "execute" })).toBeUndefined();
    expect(decodeRichRequest({ ...request, target: 1 })).toBeUndefined();
    expect(decodeRichRequest({ ...request, controllerId: "" })).toBeUndefined();
    expect(
      decodeRichRequest({
        ...request,
        operation: "image-import",
        data: "a".repeat(MAX_IMAGE_BYTES * 2),
      }),
    ).toBeUndefined();
    expect(
      decodeRichResponse({
        ...identity,
        kind: "rich-response",
        requestId: 1,
        documentVersion: 1,
        ok: true,
        offset: -1,
      }),
    ).toBeUndefined();
  });
});
