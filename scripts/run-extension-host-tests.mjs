import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTests } from "@vscode/test-electron";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureWorkspace = path.join(projectRoot, "tests", "extension-host", "fixtures");
const executablePath = process.env.VSCODE_TEST_EXECUTABLE;
const version = process.env.VSCODE_TEST_VERSION ?? "1.120.0";

const exitCode = await runTests({
  extensionDevelopmentPath: projectRoot,
  extensionTestsPath: path.join(projectRoot, "dist", "extension-host", "index.cjs"),
  version,
  ...(executablePath === undefined ? {} : { vscodeExecutablePath: executablePath }),
  launchArgs: [fixtureWorkspace, "--disable-extensions"],
});

if (exitCode !== 0) {
  process.exitCode = exitCode;
}
