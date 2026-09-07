import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const runnerUrl = new URL("../../scripts/run-browser-geometry-harness.mjs", import.meta.url);

describe("browser geometry harness runner", () => {
  it("keeps the portable candidate label while removing runtime filesystem paths", () => {
    const candidatePath = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
    const userDataDirectory = String.raw`C:\Users\runner\AppData\Local\Temp\geometry-profile`;
    const projectPath = String.raw`E:\codex_work\vscode-markdown-live-editor`;
    const program = [
      `import { redactRuntimePaths } from ${JSON.stringify(runnerUrl.href)};`,
      `const diagnostic = redactRuntimePaths(${JSON.stringify(
        `CHROME_PATH failed to spawn ${candidatePath}; profile ${userDataDirectory}; source ${projectPath}; file:///E:/codex_work/vscode-markdown-live-editor/tests/browser/geometry-harness.html`,
      )}, ${JSON.stringify([candidatePath, userDataDirectory, projectPath])});`,
      "process.stdout.write(diagnostic);",
    ].join("\n");
    const diagnostic = execFileSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
    });

    expect(diagnostic).toContain("CHROME_PATH");
    expect(diagnostic).toContain("[redacted-path]");
    expect(diagnostic).not.toContain(candidatePath);
    expect(diagnostic).not.toContain(userDataDirectory);
    expect(diagnostic).not.toContain(projectPath);
    expect(diagnostic).not.toContain("file:///E:/codex_work");
  });
});
