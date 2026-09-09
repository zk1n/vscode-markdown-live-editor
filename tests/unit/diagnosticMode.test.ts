import { describe, expect, it } from "vitest";

import {
  decodeDiagnosticMode,
  recordsDiagnosticTrace,
  usesBarrierKeymap,
  usesDocumentSync,
  usesLivePreview,
  usesMarkdownLanguage,
} from "../../src/core/diagnostics/diagnosticMode.js";

describe("development diagnostic modes", () => {
  it("fails closed to normal editing for an invalid configuration value", () => {
    expect(decodeDiagnosticMode(undefined)).toBe("off");
    expect(decodeDiagnosticMode("unexpected")).toBe("off");
  });

  it("keeps the A1 through A4 layer boundaries explicit", () => {
    expect(usesMarkdownLanguage("raw-cm6")).toBe(false);
    expect(usesDocumentSync("raw-cm6")).toBe(false);
    expect(usesLivePreview("raw-cm6")).toBe(false);
    expect(usesBarrierKeymap("raw-cm6")).toBe(false);

    expect(usesMarkdownLanguage("markdown")).toBe(true);
    expect(usesDocumentSync("markdown")).toBe(false);
    expect(usesLivePreview("markdown")).toBe(false);
    expect(usesBarrierKeymap("markdown")).toBe(false);

    expect(usesMarkdownLanguage("sync")).toBe(true);
    expect(usesDocumentSync("sync")).toBe(true);
    expect(usesLivePreview("sync")).toBe(false);
    expect(usesBarrierKeymap("sync")).toBe(true);

    expect(usesMarkdownLanguage("preview")).toBe(true);
    expect(usesDocumentSync("preview")).toBe(true);
    expect(usesLivePreview("preview")).toBe(true);
    expect(usesBarrierKeymap("preview")).toBe(true);
    expect(recordsDiagnosticTrace("preview")).toBe(true);
  });
});
