import { describe, expect, it } from "vitest";

import {
  MAX_CUSTOM_CSS_COMBINED_BYTES,
  MAX_CUSTOM_CSS_SOURCE_BYTES,
  loadCustomCss,
  validateCustomCss,
  type CustomCssHost,
  type CustomCssUri,
} from "../../src/extension/styles/customCss.js";

describe("custom CSS validation and resolution", () => {
  it("accepts literal CSS but rejects network-capable and malformed syntax", () => {
    expect(validateCustomCss(".note { color: rebeccapurple; }").status).toBe("accepted");
    for (const css of [
      '@import "https://example.test/theme.css";',
      ".note { background: url (asset.png); }",
      String.raw`.note { background: u\72l(asset.png); }`,
      String.raw`.note { content: "\2022"; }`,
      '.note { background: image("https://example.test/a.png"); }',
      ".note { color: red; ",
      ".note { content: 'unterminated; }",
      ".note { color: red; }\0",
    ]) {
      expect(validateCustomCss(css).status).toBe("invalid");
    }
  });

  it("uses UTF-8 bytes, not JavaScript character count, for limits", () => {
    expect(validateCustomCss("a".repeat(MAX_CUSTOM_CSS_SOURCE_BYTES)).status).toBe("accepted");
    expect(validateCustomCss("あ".repeat(Math.ceil(MAX_CUSTOM_CSS_SOURCE_BYTES / 3))).status).toBe(
      "invalid",
    );
  });

  it("resolves only the fixed CSS file from the document owning folder", async () => {
    const host = new FakeHost();
    const owningFolder = uri("file:///workspace-a");
    host.folders.set("file:///workspace-a/note.md", { uri: owningFolder });
    host.files.set("file:///workspace-a/.vscode/markdown-live-editor.css", bytes(".workspace {}"));

    const result = await loadCustomCss(host, uri("file:///workspace-a/note.md"), ".user {}");

    expect(result.workspaceCss).toBe(".workspace {}");
    expect(result.userCss).toBe(".user {}");
    expect(result.css).toBe(".workspace {}\n.user {}");
    expect(host.joinedBases).toEqual(["file:///workspace-a"]);
  });

  it("keeps the available source and base-only fallback when a source is unavailable", async () => {
    const host = new FakeHost();
    host.folders.set("file:///workspace/note.md", { uri: uri("file:///workspace") });

    const missingWorkspace = await loadCustomCss(
      host,
      uri("file:///workspace/note.md"),
      ".user {}",
    );
    expect(missingWorkspace.css).toBe(".user {}");
    expect(missingWorkspace.workspace.status).toBe("missing");

    host.trusted = false;
    const untrusted = await loadCustomCss(host, uri("file:///workspace/note.md"), ".user {}");
    expect(untrusted.css).toBe(".user {}");
    expect(untrusted.user.status).toBe("accepted");
    expect(untrusted.workspace.status).toBe("disabled");
  });

  it("treats malformed UTF-8 from the workspace file as an invalid optional source", async () => {
    const host = new FakeHost();
    host.folders.set("file:///workspace/note.md", { uri: uri("file:///workspace") });
    host.files.set(
      "file:///workspace/.vscode/markdown-live-editor.css",
      Uint8Array.from([0xc3, 0x28]),
    );

    const result = await loadCustomCss(host, uri("file:///workspace/note.md"), undefined);

    expect(result.css).toBe("");
    expect(result.workspace.status).toBe("invalid");
    expect(result.workspace.reason).toBe("CSS is not valid UTF-8.");
  });

  it("rejects an over-limit lower-priority combined style without losing workspace CSS", async () => {
    const host = new FakeHost();
    host.folders.set("file:///workspace/note.md", { uri: uri("file:///workspace") });
    host.files.set(
      "file:///workspace/.vscode/markdown-live-editor.css",
      bytes("a".repeat(MAX_CUSTOM_CSS_SOURCE_BYTES)),
    );
    const result = await loadCustomCss(
      host,
      uri("file:///workspace/note.md"),
      "b".repeat(MAX_CUSTOM_CSS_COMBINED_BYTES - MAX_CUSTOM_CSS_SOURCE_BYTES),
    );

    expect(result.workspace.status).toBe("accepted");
    expect(result.user.status).toBe("invalid");
    expect(result.css).toBe("a".repeat(MAX_CUSTOM_CSS_SOURCE_BYTES));
  });
});

function uri(value: string): CustomCssUri {
  return { scheme: "file", toString: (): string => value };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

class NotFoundError extends Error {}

class FakeHost implements CustomCssHost {
  public trusted = true;
  public readonly files = new Map<string, Uint8Array>();
  public readonly folders = new Map<string, { readonly uri: CustomCssUri }>();
  public readonly joinedBases: string[] = [];

  public readonly isWorkspaceTrusted = (): boolean => this.trusted;
  public readonly getWorkspaceFolder = (
    documentUri: CustomCssUri,
  ): { readonly uri: CustomCssUri } | undefined => this.folders.get(documentUri.toString());
  public readonly joinPath = (base: CustomCssUri, ...segments: readonly string[]): CustomCssUri => {
    this.joinedBases.push(base.toString());
    return uri(`${base.toString()}/${segments.join("/")}`);
  };
  public readonly readFile = (target: CustomCssUri): Promise<Uint8Array> => {
    const file = this.files.get(target.toString());
    if (file === undefined) {
      throw new NotFoundError();
    }
    return Promise.resolve(file);
  };
  public readonly createWatcher = (): never => {
    throw new Error("Watcher is not used by loadCustomCss.");
  };
  public readonly isFileNotFound = (error: unknown): boolean => error instanceof NotFoundError;
}
