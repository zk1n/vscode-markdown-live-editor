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
