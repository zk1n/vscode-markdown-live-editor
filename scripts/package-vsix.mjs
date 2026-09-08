import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const artifactDirectory = path.join(repositoryRoot, "artifacts");
const artifactPath = path.join(
  artifactDirectory,
  `${packageJson.name}-${packageJson.version}.vsix`,
);
const stagingDirectory = path.join(artifactDirectory, ".vsix-staging");
const curatedReadme = "docs/public/README.md";
const packageReadme = existsSync(path.join(repositoryRoot, curatedReadme))
  ? curatedReadme
  : "README.md";
const expectedEntries = new Set([
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/package.json",
  "extension/readme.md",
  "extension/changelog.md",
  "extension/LICENSE.txt",
  "extension/dist/extension.cjs",
  "extension/dist/webview.js",
  "extension/l10n/bundle.l10n.json",
  "extension/l10n/bundle.l10n.ja.json",
]);

function readArchiveEntries(archivePath) {
  const archive = readFileSync(archivePath);
  const endOfCentralDirectorySignature = 0x06054b50;
  const centralDirectorySignature = 0x02014b50;
  const minimumEndOfCentralDirectoryOffset = Math.max(0, archive.length - 65_557);
  let endOfCentralDirectoryOffset = -1;

  for (
    let offset = archive.length - 22;
    offset >= minimumEndOfCentralDirectoryOffset;
    offset -= 1
  ) {
    if (archive.readUInt32LE(offset) === endOfCentralDirectorySignature) {
      endOfCentralDirectoryOffset = offset;
      break;
    }
  }

  if (endOfCentralDirectoryOffset < 0) {
    throw new Error("VSIX validation failed: ZIP end-of-central-directory record is missing.");
  }

  const entryCount = archive.readUInt16LE(endOfCentralDirectoryOffset + 10);
  let offset = archive.readUInt32LE(endOfCentralDirectoryOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== centralDirectorySignature) {
      throw new Error("VSIX validation failed: malformed ZIP central directory.");
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    entries.push(archive.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function validateArtifact(archivePath) {
  const entries = readArchiveEntries(archivePath);
  const actualEntries = new Set(entries);
  const unexpectedEntries = entries.filter((entry) => !expectedEntries.has(entry));
  const missingEntries = [...expectedEntries].filter((entry) => !actualEntries.has(entry));
  if (unexpectedEntries.length > 0 || missingEntries.length > 0) {
    throw new Error(
      [
        "VSIX validation failed: artifact contents do not match the explicit allowlist.",
        unexpectedEntries.length > 0 ? `Unexpected: ${unexpectedEntries.join(", ")}` : null,
        missingEntries.length > 0 ? `Missing: ${missingEntries.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  console.log(`Validated VSIX contents (${entries.length} entries): ${archivePath}`);
}

const stagedFiles = [
  ["package.json", "package.json"],
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["LICENSE", "LICENSE"],
  [packageReadme, "README.md"],
  ["dist/extension.cjs", "dist/extension.cjs"],
  ["dist/webview.js", "dist/webview.js"],
  ["l10n/bundle.l10n.json", "l10n/bundle.l10n.json"],
  ["l10n/bundle.l10n.ja.json", "l10n/bundle.l10n.ja.json"],
];

for (const [source] of stagedFiles) {
  if (!existsSync(path.join(repositoryRoot, source))) {
    throw new Error(`VSIX packaging requires ${source}. Run npm run build first.`);
  }
}

mkdirSync(artifactDirectory, { recursive: true });
rmSync(stagingDirectory, { force: true, recursive: true });
try {
  for (const [source, target] of stagedFiles) {
    const targetPath = path.join(stagingDirectory, target);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyFileSync(path.join(repositoryRoot, source), targetPath);
  }
  rmSync(artifactPath, { force: true });
  const vsceEntrypoint = path.join(repositoryRoot, "node_modules", "@vscode", "vsce", "vsce");
  const result = spawnSync(
    process.execPath,
    [vsceEntrypoint, "package", "--no-dependencies", "--out", artifactPath],
    {
      cwd: stagingDirectory,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`vsce package failed with exit code ${result.status ?? "unknown"}.`);
  if (!existsSync(artifactPath)) throw new Error(`VSIX packaging did not create ${artifactPath}.`);
  validateArtifact(artifactPath);
} finally {
  rmSync(stagingDirectory, { force: true, recursive: true });
}
