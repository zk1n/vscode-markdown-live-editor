import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTests } from "@vscode/test-electron";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureWorkspace = path.join(projectRoot, "tests", "extension-host", "fixtures");
const executablePath = process.env.VSCODE_TEST_EXECUTABLE;
const version = process.env.VSCODE_TEST_VERSION ?? "1.120.0";
const testBundle = process.argv.includes("--v02") ? "v02.cjs" : "index.cjs";

const userDataDirectory = await mkdtemp(
  path.join(os.tmpdir(), "markdown-live-editor-vscode-test-"),
);
let developmentPath = projectRoot;

try {
  if (process.argv.includes("--v02")) {
    // VS Code requires a contribution as well as runtime provider registration.
    // Stage test IDs with the exact runtime payload, never into the shipped manifest.
    developmentPath = path.join(userDataDirectory, "test-extension");
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    for (const viewType of [
      "vscodeMarkdownLiveEditor.v02WebviewFindWidgetProbe",
      "vscodeMarkdownLiveEditor.v02ImageLifecycle",
    ])
      manifest.contributes.customEditors.push({
        viewType,
        displayName: viewType,
        selector: [{ filenamePattern: "*.md" }],
        priority: "option",
      });
    await mkdir(developmentPath, { recursive: true });
    await writeFile(path.join(developmentPath, "package.json"), JSON.stringify(manifest));
    for (const file of [
      "dist/extension.cjs",
      "dist/webview.js",
      "package.nls.json",
      "package.nls.ja.json",
      "l10n/bundle.l10n.json",
      "l10n/bundle.l10n.ja.json",
      "tests/fixtures/v02-review/assets/example.png",
    ]) {
      const target = path.join(developmentPath, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(projectRoot, file), target);
    }
  }
  const exitCode = await runTests({
    extensionDevelopmentPath: developmentPath,
    extensionTestsPath: path.join(projectRoot, "dist", "extension-host", testBundle),
    version,
    ...(executablePath === undefined ? {} : { vscodeExecutablePath: executablePath }),
    launchArgs: ["--disable-extensions", "--user-data-dir", userDataDirectory, fixtureWorkspace],
  });

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
} finally {
  await rm(userDataDirectory, { force: true, recursive: true });
}
