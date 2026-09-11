import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

describe("ESLint repository ignores", () => {
  it("excludes the repository-owned temporary tree", async () => {
    await expect(eslint.isPathIgnored(".tmp/oracle-user/agent-host/local-endpoint")).resolves.toBe(
      true,
    );
  });

  it("keeps managed source, tests, scripts, and config in scope", async () => {
    for (const path of [
      "src/extension.ts",
      "tests/unit/projectIdentity.test.ts",
      "scripts/build.mjs",
      "eslint.config.mjs",
    ]) {
      await expect(eslint.isPathIgnored(path)).resolves.toBe(false);
    }
  });
});
