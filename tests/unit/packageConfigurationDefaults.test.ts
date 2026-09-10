import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageContributions {
  readonly contributes?: {
    readonly configurationDefaults?: {
      readonly "[markdown]"?: {
        readonly "files.trimTrailingWhitespace"?: boolean;
      };
    };
    readonly commands?: readonly unknown[];
    readonly customEditors?: readonly unknown[];
  };
}

describe("package configuration defaults", () => {
  it("contributes the Markdown trailing-whitespace safety default without losing editor contributions", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as PackageContributions;

    expect(
      packageJson.contributes?.configurationDefaults?.["[markdown]"]?.[
        "files.trimTrailingWhitespace"
      ],
    ).toBe(false);
    expect(packageJson.contributes?.commands?.length).toBeGreaterThan(0);
    expect(packageJson.contributes?.customEditors?.length).toBeGreaterThan(0);
  });
});

describe("VSIX manifest localization", () => {
  it("checks every manifest token against the packaged NLS resources", () => {
    const scriptUrl = new URL("../../scripts/package-vsix.mjs", import.meta.url);
    const manifestUrl = new URL("../../package.json", import.meta.url);
    const program = `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { validateManifestNls } from ${JSON.stringify(scriptUrl.href)};
      const manifestUrl = new URL(${JSON.stringify(manifestUrl.href)});
      const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
      const resources = new Map(["package.nls.json", "package.nls.ja.json"].map(name => [
        "extension/" + name, readFileSync(new URL(name, manifestUrl))
      ]));
      validateManifestNls(manifest, resources);
      assert.throws(() => validateManifestNls(manifest, new Map()), /Missing manifest NLS resource/);
      for (const filename of resources.keys()) {
        const missingFile = new Map(resources);
        missingFile.delete(filename);
        assert.throws(() => validateManifestNls(manifest, missingFile), /Missing manifest NLS resource/);
        for (const key of ["displayName", "description", "command.undo"]) {
          const incomplete = new Map(resources);
          const messages = JSON.parse(resources.get(filename).toString("utf8"));
          delete messages[key];
          incomplete.set(filename, Buffer.from(JSON.stringify(messages)));
          assert.throws(() => validateManifestNls(manifest, incomplete), /Missing or unresolved manifest NLS key/);
          messages[key] = "%" + key + "%";
          incomplete.set(filename, Buffer.from(JSON.stringify(messages)));
          assert.throws(() => validateManifestNls(manifest, incomplete), /Missing or unresolved manifest NLS key/);
        }
      }
      validateManifestNls({ displayName: "Literal name" }, new Map());
    `;
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "--eval", program]),
    ).not.toThrow();
  });
});
