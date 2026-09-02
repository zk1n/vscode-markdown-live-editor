import { describe, expect, it } from "vitest";

import { PROJECT_ID, PROJECT_IDENTITY } from "../../src/core/projectIdentity.js";

describe("project identity", () => {
  it("uses the repository identifier", () => {
    expect(PROJECT_IDENTITY.id).toBe(PROJECT_ID);
  });

  it("has a human-readable display name", () => {
    expect(PROJECT_IDENTITY.displayName.length).toBeGreaterThan(0);
  });
});
