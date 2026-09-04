import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly activationEvents?: readonly string[];
  readonly contributes?: {
    readonly views?: Readonly<
      Record<string, readonly { readonly id?: string; readonly name?: string }[]>
    >;
  };
}

describe("Markdown Outline package contribution", () => {
  it("contributes a movable native Tree View to Explorer and activates for it", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
    expect(manifest.activationEvents).toContain("onView:vscodeMarkdownLiveEditor.markdownOutline");
    expect(manifest.contributes?.views?.["explorer"]).toContainEqual({
      id: "vscodeMarkdownLiveEditor.markdownOutline",
      name: "Markdown Outline",
    });
  });
});
