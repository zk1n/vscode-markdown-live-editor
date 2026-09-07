import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRootPrefix = `${projectRoot}${path.sep}`;
let harnessResult = null;
let resultResolver = null;
let runErrorOutput = "";
const requestLog = [];
const holdResponses = [];

if (isMainModule()) {
  await main();
}

async function main() {
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), "markdown-live-editor-geometry-"));
  const browserCandidates = await discoverBrowserCandidates();

  if (browserCandidates.length === 0) {
    throw new Error("No usable Chromium-family browser executable was found.");
  }

  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requestLog.push(`${request.method ?? "GET"} ${pathname}`);
    if (pathname === "/__geometry-harness-hold") {
      holdResponses.push(response);
      return;
    }
    if (pathname === "/__geometry-harness-result") {
      if (request.method === "GET") {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        const encodedPayload = requestUrl.searchParams.get("payload");
        if (encodedPayload === null) {
          response.writeHead(400).end("geometry result payload is missing");
          return;
        }
        try {
          const payload = JSON.parse(encodedPayload);
          harnessResult = payload;
          releaseHarnessHolds();
          if (resultResolver !== null) {
            resultResolver(payload);
            resultResolver = null;
          }
          response.writeHead(200).end("ok");
        } catch (error) {
          response.writeHead(400).end(`invalid geometry result payload: ${String(error)}`);
        }
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end("method not allowed");
        return;
      }
      try {
        const payload = await parseJsonBody(request);
        harnessResult = payload;
        releaseHarnessHolds();
        if (resultResolver !== null) {
          resultResolver(payload);
          resultResolver = null;
        }
        response.writeHead(200).end("ok");
      } catch (error) {
        response.writeHead(400).end(`invalid geometry result payload: ${String(error)}`);
      }
      return;
    }

    const target = path.resolve(projectRoot, `.${decodeURIComponent(pathname)}`);
    if (target !== projectRoot && !target.startsWith(projectRootPrefix)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const targetStat = await stat(target);
      if (!targetStat.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": contentType(target) });
      response.end(await readFile(target));
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The geometry harness server did not receive a TCP port.");
  }
  const harnessUrl = `http://127.0.0.1:${String(address.port)}/tests/browser/geometry-harness.html`;

  const browserFlags = [
    // The managed Windows test environment denies Chromium's child-process
    // sandbox token. This harness serves only repository files on loopback from
    // a one-shot profile, so disable that browser sandbox explicitly here.
    "--no-sandbox",
    "--disable-gpu",
    "--dump-dom",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-pings",
    "--virtual-time-budget=5000",
    "--enable-logging=stderr",
    "--log-level=0",
    // Keep every fixture line inside the viewport so elementFromPoint can
    // independently identify the visible DOM line at each tested coordinate.
    "--window-size=1000,1400",
    `--user-data-dir=${userDataDirectory}`,
  ];
  const browserModes = ["--headless=new"];

  let finalResult = null;
  const errors = [];
  for (const candidate of browserCandidates) {
    for (const browserMode of browserModes) {
      try {
        finalResult = await runBrowserCandidate(
          candidate,
          [...browserFlags, browserMode],
          harnessUrl,
        );
        break;
      } catch (error) {
        const compactOutput = redactRuntimePaths(runErrorOutput.slice(-8000), [
          candidate.path,
          userDataDirectory,
          projectRoot,
        ]);
        const requestState = requestLog.length === 0 ? "no-requests" : requestLog.join(", ");
        errors.push(
          `${candidate.label} (${browserMode}): ${redactRuntimePaths(String(error), [
            candidate.path,
            userDataDirectory,
            projectRoot,
          ])}\nOutput:${compactOutput}\nRequests:${requestState}`,
        );
      }
      if (finalResult !== null) {
        finalResult.browser = candidate.label;
        break;
      }
    }
    if (finalResult !== null) {
      finalResult.browser = candidate.label;
      break;
    }
    harnessResult = null;
    resultResolver = null;
    runErrorOutput = "";
  }

  if (finalResult === null) {
    throw new Error(redactRuntimePaths(`All browser candidates failed:\n${errors.join("\n")}`));
  }

  process.stdout.write(`${JSON.stringify(finalResult)}\n`);
  if (
    finalResult.error !== undefined ||
    finalResult.geometryMatches !== true ||
    finalResult.hitTestsMatch !== true
  ) {
    process.exitCode = 1;
  }

  server.closeAllConnections();
  await Promise.race([new Promise((resolve) => server.close(resolve)), delay(2_000)]);

  try {
    await rm(userDataDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    // Chrome's Crashpad child can briefly retain a dump after the browser
    // closes. Preserve the harness result instead of replacing it with a
    // cleanup-only error.
    process.stderr.write(`Geometry harness temporary cleanup failed: ${String(error)}\n`);
  }
}

async function runBrowserCandidate(candidate, browserFlags, harnessUrl) {
  harnessResult = null;
  runErrorOutput = "";
  const resultPromise = new Promise((resolve) => {
    resultResolver = (payload) => {
      resultResolver = null;
      resolve(payload);
    };
  });

  const browser = spawn(candidate.path, [...browserFlags, harnessUrl], { windowsHide: true });
  browser.stdout.setEncoding("utf8");
  browser.stderr.setEncoding("utf8");
  browser.stdout.on("data", (chunk) => {
    runErrorOutput += chunk;
    const fallbackResult = parseResultFromStdout(runErrorOutput);
    if (fallbackResult !== null && resultResolver !== null) {
      resultResolver(fallbackResult);
    }
  });
  browser.stderr.on("data", (chunk) => {
    runErrorOutput += chunk;
  });

  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Geometry harness timed out after 10 seconds in ${candidate.label}.`));
    }, 10_000);
  });
  const completion = new Promise((resolve) => {
    browser.once("error", resolve);
    browser.once("close", resolve);
  });
  try {
    const result = await Promise.race([
      resultPromise,
      timeout,
      completion.then(async () => {
        if (harnessResult !== null) {
          return harnessResult;
        }
        const dumpedResult = parseResultFromStdout(runErrorOutput);
        if (dumpedResult !== null) {
          return dumpedResult;
        }
        // Chrome can emit its final --dump-dom stdout chunk after the process
        // close event. Give both reporting paths a few short turns to settle.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await delay(100);
          if (harnessResult !== null) {
            return harnessResult;
          }
          const delayedDumpedResult = parseResultFromStdout(runErrorOutput);
          if (delayedDumpedResult !== null) {
            return delayedDumpedResult;
          }
        }
        throw new Error(
          `Chromium closed before reporting geometry result (${candidate.label}, exitCode=${String(browser.exitCode)}).`,
        );
      }),
    ]);

    if (browser.exitCode === null) {
      browser.kill();
      await Promise.race([new Promise((resolve) => browser.once("close", resolve)), delay(2_000)]);
    }
    return result;
  } catch (error) {
    if (browser.exitCode === null) {
      browser.kill();
      await Promise.race([new Promise((resolve) => browser.once("close", resolve)), delay(2_000)]);
    }
    if (browser.exitCode !== null && browser.exitCode !== 0) {
      throw new Error(
        `Chromium exited with ${String(browser.exitCode)} while running ${candidate.label}: ${runErrorOutput || error}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Removes machine-specific filesystem locations before runner diagnostics are
 * emitted. Browser executable paths are intentionally usable only at the
 * spawn/access boundary; public output identifies the candidate by label.
 */
export function redactRuntimePaths(value, privatePaths = []) {
  let redacted = String(value);
  for (const privatePath of privatePaths) {
    if (typeof privatePath !== "string" || privatePath.length === 0) {
      continue;
    }
    redacted = redacted.replace(
      new RegExp(escapeRegularExpression(privatePath), "gi"),
      "[redacted-path]",
    );
  }
  return redacted
    .replace(/file:\/\/\/?[^\s"'<>]+/giu, "file:[redacted-path]")
    .replace(/(?:[a-z]:\\|\\\\)[^\r\n]*/giu, "[redacted-path]");
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function contentType(target) {
  if (target.endsWith(".html")) return "text/html; charset=utf-8";
  if (target.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (target.endsWith(".map")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function discoverBrowserCandidates() {
  const candidates = [];
  const candidatesByPriority = buildBrowserCandidateSpecs(process.env);

  for (const candidate of candidatesByPriority) {
    if (candidate.path === undefined) {
      continue;
    }
    try {
      await access(candidate.path, constants.X_OK);
      candidates.push({ path: candidate.path, label: candidate.label });
    } catch {
      continue;
    }
  }
  return candidates;
}

/**
 * Builds candidate paths from the caller's runtime environment only.
 *
 * Keeping this pure makes the public runner testable without probing a
 * machine, and deliberately avoids embedding a local installation path in a
 * source file that may be included in the filtered public projection.
 */
export function buildBrowserCandidateSpecs(environment) {
  const candidates = [
    { label: "CHROME_PATH", path: environment.CHROME_PATH },
    { label: "EDGE_PATH", path: environment.EDGE_PATH },
  ];
  const programFileRoots = [
    environment.ProgramFiles,
    environment.PROGRAMFILES,
    environment.ProgramW6432,
    environment["ProgramFiles(x86)"],
    environment["PROGRAMFILES(X86)"],
  ].filter((root) => typeof root === "string" && root.length > 0);

  for (const root of programFileRoots) {
    candidates.push(
      {
        label: "CHROME",
        path: path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      },
      {
        label: "MS_EDGE",
        path: path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      },
    );
  }

  const pathValue = environment.PATH ?? environment.Path;
  if (typeof pathValue === "string") {
    for (const directory of pathValue.split(path.delimiter)) {
      if (directory.length === 0) {
        continue;
      }
      candidates.push(
        { label: "PATH_CHROME", path: path.join(directory, "chrome.exe") },
        { label: "PATH_MS_EDGE", path: path.join(directory, "msedge.exe") },
      );
    }
  }

  return candidates.filter(
    (candidate) => typeof candidate.path === "string" && candidate.path.length > 0,
  );
}

function isMainModule() {
  const entryPoint = process.argv[1];
  return (
    typeof entryPoint === "string" && path.resolve(entryPoint) === fileURLToPath(import.meta.url)
  );
}

async function parseJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(String(chunk));
  }
  const body = chunks.join("");
  if (body.length === 0) {
    throw new Error("empty body");
  }
  return JSON.parse(body);
}

function parseResultFromStdout(outputChunk) {
  const marker = "GEOMETRY_HARNESS_RESULT:";
  const output = String(outputChunk);
  const markerIndex = output.indexOf(marker);
  if (markerIndex >= 0) {
    const jsonText = output.slice(markerIndex + marker.length).trim();
    if (jsonText.length > 0) {
      const line = jsonText.split("\n")[0];
      try {
        return JSON.parse(line);
      } catch {
        // Chromium may still be streaming the line. Try again on the next
        // chunk or fall back to the completed DOM below.
      }
    }
  }

  const preMarker = '<pre id="geometry-harness-result">';
  const preIndex = output.indexOf(preMarker);
  if (preIndex < 0) {
    return null;
  }
  const jsonStart = preIndex + preMarker.length;
  const jsonEnd = output.indexOf("</pre>", jsonStart);
  if (jsonEnd < 0) {
    return null;
  }
  try {
    return JSON.parse(
      output
        .slice(jsonStart, jsonEnd)
        .replaceAll("&quot;", '"')
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&"),
    );
  } catch {
    return null;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function releaseHarnessHolds() {
  for (const response of holdResponses.splice(0)) {
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(204).end();
    }
  }
}
