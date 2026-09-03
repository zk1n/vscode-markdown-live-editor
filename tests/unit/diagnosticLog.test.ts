import { describe, expect, it } from "vitest";

import { BoundedDiagnosticLog } from "../../src/core/diagnostics/diagnosticLog.js";

describe("BoundedDiagnosticLog", () => {
  it("keeps only the configured newest metadata events", () => {
    const log = new BoundedDiagnosticLog(2);

    log.record("one", { sequence: 1 });
    log.record("two", { sequence: 2 });
    log.record("three", { sequence: 3 });

    const copied = log.copyText();
    expect(copied).not.toContain(" one ");
    expect(copied).toContain(" two ");
    expect(copied).toContain(" three ");
  });

  it("enforces a total retained-size cap", () => {
    const log = new BoundedDiagnosticLog(250, undefined, 200);

    log.record("first", { note: "a".repeat(160) });
    log.record("second", { note: "b".repeat(160) });

    expect(log.copyText().length).toBeLessThanOrEqual(200);
  });
});
