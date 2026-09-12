import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as VSCode from "vscode";

const fake = vi.hoisted(() => {
  const state = {
    providerWritable: undefined as boolean | undefined,
    permissions: undefined as number | undefined,
    statError: undefined as Error | undefined,
    nodeMode: 0o666,
    nodeError: undefined as Error | undefined,
    accessError: undefined as Error | undefined,
  };
  const fsStat = vi.fn((): Promise<{ readonly permissions?: number }> => {
    if (state.statError !== undefined) return Promise.reject(state.statError);
    return Promise.resolve(
      state.permissions === undefined ? {} : { permissions: state.permissions },
    );
  });
  const nodeStat = vi.fn((): Promise<{ readonly mode: number }> => {
    if (state.nodeError !== undefined) return Promise.reject(state.nodeError);
    return Promise.resolve({ mode: state.nodeMode });
  });
  const access = vi.fn((): Promise<void> => {
    if (state.accessError !== undefined) return Promise.reject(state.accessError);
    return Promise.resolve();
  });
  return {
    state,
    fsStat,
    nodeStat,
    access,
    vscode: {
      FilePermission: { Readonly: 1 },
      workspace: {
        fs: {
          isWritableFileSystem: (): boolean | undefined => state.providerWritable,
          stat: fsStat,
        },
      },
    },
  };
});

vi.mock("vscode", () => fake.vscode);
vi.mock("node:fs/promises", () => ({ access: fake.access, stat: fake.nodeStat }));

import { getDocumentWriteCapability } from "../../src/extension/editor/documentCapabilities.js";

function document(scheme = "file", isUntitled = false): VSCode.TextDocument {
  return {
    isUntitled,
    uri: { scheme, fsPath: "C:\\note.md" },
  } as VSCode.TextDocument;
}

beforeEach(() => {
  fake.state.providerWritable = true;
  fake.state.permissions = undefined;
  fake.state.statError = undefined;
  fake.state.nodeMode = 0o666;
  fake.state.nodeError = undefined;
  fake.state.accessError = undefined;
  fake.fsStat.mockClear();
  fake.nodeStat.mockClear();
  fake.access.mockClear();
});

describe("document write capability", () => {
  it("keeps untitled documents editable without requiring a filesystem", async () => {
    await expect(getDocumentWriteCapability(document("untitled", true))).resolves.toEqual({
      writable: true,
    });
    expect(fake.fsStat).not.toHaveBeenCalled();
  });

  it("uses the provider readonly capability and FileStat readonly bit", async () => {
    fake.state.providerWritable = false;
    const readonlyFileSystem = await getDocumentWriteCapability(document());
    expect(readonlyFileSystem.writable).toBe(false);
    expect(readonlyFileSystem.reason).toContain("ファイルシステム");

    fake.state.providerWritable = true;
    fake.state.permissions = 1;
    await expect(getDocumentWriteCapability(document())).resolves.toEqual({
      writable: false,
      reason: "この文書は読み取り専用です。",
    });
    expect(fake.nodeStat).not.toHaveBeenCalled();
  });

  it("checks local file metadata and write access before permitting attachment imports", async () => {
    fake.state.nodeMode = 0o444;
    await expect(getDocumentWriteCapability(document())).resolves.toEqual({
      writable: false,
      reason: "この文書は読み取り専用です。",
    });

    fake.state.nodeMode = 0o666;
    fake.state.accessError = new Error("EACCES");
    await expect(getDocumentWriteCapability(document())).resolves.toEqual({
      writable: false,
      reason: "この文書へ書き込めません。",
    });
  });

  it("permits a virtual document only when its provider and FileStat both support writing", async () => {
    await expect(getDocumentWriteCapability(document("git"))).resolves.toEqual({ writable: true });

    fake.state.providerWritable = undefined;
    await expect(getDocumentWriteCapability(document("custom"))).resolves.toEqual({
      writable: false,
      reason: "この文書の書き込み可否を確認できませんでした。",
    });
  });
});
