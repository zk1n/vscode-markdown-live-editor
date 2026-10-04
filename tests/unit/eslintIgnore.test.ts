import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({
  overrideConfigFile: fileURLToPath(new URL("../../eslint.config.mjs", import.meta.url)),
});

describe("ESLint repository ignores", () => {
  it("excludes the repository-owned temporary tree", async () => {
    await expect(eslint.isPathIgnored(".tmp/oracle-user/agent-host/local-endpoint")).resolves.toBe(
      true,
    );
  });

  it("excludes nested delivery repositories and working data", async () => {
    for (const path of [
      "delivery/public/src/extension/extension.ts",
      "delivery/source/tests/unit/projectIdentity.test.ts",
      "delivery/work/validation/eslint.config.mjs",
    ]) {
      await expect(eslint.isPathIgnored(path)).resolves.toBe(true);
    }
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
