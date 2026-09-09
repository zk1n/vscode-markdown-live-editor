import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
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
  "extension/package.nls.json",
  "extension/package.nls.ja.json",
  "extension/readme.md",
  "extension/changelog.md",
  "extension/LICENSE.txt",
  "extension/dist/extension.cjs",
  "extension/dist/webview.js",
  "extension/l10n/bundle.l10n.json",
  "extension/l10n/bundle.l10n.ja.json",
]);

function readArchiveFiles(archivePath) {
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
  const files = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== centralDirectorySignature) {
      throw new Error("VSIX validation failed: malformed ZIP central directory.");
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const localOffset = archive.readUInt32LE(offset + 42);
    if (archive.readUInt32LE(localOffset) !== 0x04034b50 || files.has(name)) {
      throw new Error("VSIX validation failed: invalid or duplicate ZIP entry.");
    }
    const dataOffset =
      localOffset +
      30 +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    if (method !== 0 && method !== 8) throw new Error("Unsupported VSIX compression method.");
    files.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

export function validateManifestNls(manifest, files) {
  const requiredKeys = new Set();
  function collect(value) {
    if (typeof value === "string" && /^%[^%]+%$/.test(value)) {
      requiredKeys.add(value.slice(1, -1));
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(collect);
    }
  }
  collect(manifest);
  if (requiredKeys.size === 0) return;
  for (const filename of ["extension/package.nls.json", "extension/package.nls.ja.json"]) {
    const contents = files.get(filename);
    if (!contents) throw new Error(`Missing manifest NLS resource: ${filename}`);
    const messages = JSON.parse(contents.toString("utf8"));
    for (const key of requiredKeys) {
      if (
        typeof messages?.[key] !== "string" ||
        !messages[key].trim() ||
        /^%[^%]+%$/.test(messages[key])
      ) {
        throw new Error(`Missing or unresolved manifest NLS key: ${filename}: ${key}`);
      }
    }
  }
}

export function validateArtifact(archivePath) {
  const files = readArchiveFiles(archivePath);
  const entries = [...files.keys()];
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
  validateManifestNls(JSON.parse(files.get("extension/package.json").toString("utf8")), files);
  console.log(`Validated VSIX contents (${entries.length} entries): ${archivePath}`);
}

function packageVsix() {
  const stagedFiles = [
    ["package.json", "package.json"],
    ["package.nls.json", "package.nls.json"],
    ["package.nls.ja.json", "package.nls.ja.json"],
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
    if (!existsSync(artifactPath))
      throw new Error(`VSIX packaging did not create ${artifactPath}.`);
    validateArtifact(artifactPath);
  } finally {
    rmSync(stagingDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageVsix();
}
