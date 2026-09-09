import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly contributes?: {
    readonly configuration?: {
      readonly properties?: Readonly<
        Record<string, { readonly restricted?: boolean; readonly type?: string }>
      >;
    };
    readonly commands?: readonly { readonly command?: string }[];
    readonly keybindings?: readonly {
      readonly command?: string;
      readonly key?: string;
      readonly when?: string;
    }[];
  };
}

describe("M10 package contributions", () => {
  it("contributes blurred history keybindings and the restricted literal CSS setting", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as PackageManifest;
    const commands = manifest.contributes?.commands?.map(({ command }) => command);
    expect(commands).toContain("vscodeMarkdownLiveEditor.undo");
    expect(commands).toContain("vscodeMarkdownLiveEditor.redo");
    expect(manifest.contributes?.keybindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "vscodeMarkdownLiveEditor.undo",
          key: "ctrl+z",
          when: "activeCustomEditorId == vscodeMarkdownLiveEditor.editor",
        }),
        expect.objectContaining({
          command: "vscodeMarkdownLiveEditor.redo",
          key: "ctrl+y",
          when: "activeCustomEditorId == vscodeMarkdownLiveEditor.editor",
        }),
      ]),
    );
    expect(
      manifest.contributes?.configuration?.properties?.["vscodeMarkdownLiveEditor.customCss"],
    ).toMatchObject({ type: "string", restricted: true });
  });
});
