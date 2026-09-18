import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Setting {
  readonly type: string | readonly string[];
  readonly default: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
}
interface Manifest {
  readonly contributes?: {
    readonly configuration?: { readonly properties?: Readonly<Record<string, Setting>> };
  };
}

describe("U6 Settings contribution", () => {
  it("exposes all presentation preferences with protocol-aligned bounds", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as Manifest;
    const settings = manifest.contributes?.configuration?.properties;
    expect(settings?.["vscodeMarkdownLiveEditor.tableMinWidth"]).toMatchObject({
      minimum: 3,
      maximum: 16,
      default: 4.75,
    });
    expect(settings?.["vscodeMarkdownLiveEditor.tableMaxWidth"]).toMatchObject({
      minimum: 8,
      maximum: 100,
      default: 32,
    });
    expect(settings?.["vscodeMarkdownLiveEditor.tableBandSize"]).toMatchObject({
      minimum: 10,
      maximum: 28,
      default: 18,
    });
    expect(settings?.["vscodeMarkdownLiveEditor.structuralGap"]).toMatchObject({
      minimum: 2,
      maximum: 32,
      default: 6,
    });
    expect(settings?.["vscodeMarkdownLiveEditor.linkHoverDelay"]).toMatchObject({
      minimum: 100,
      maximum: 2000,
      default: 300,
    });
    for (const key of ["compactSpacing", "imageKeepHeight", "lineNumbers"])
      expect(settings?.[`vscodeMarkdownLiveEditor.${key}`]).toMatchObject({
        type: "boolean",
        default: true,
      });
  });
});
