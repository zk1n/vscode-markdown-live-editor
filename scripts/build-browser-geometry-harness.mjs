import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

await esbuild.build({
  absWorkingDir: projectRoot,
  entryPoints: [path.join(projectRoot, "tests/browser/geometry-harness.ts")],
  bundle: true,
  outfile: path.join(projectRoot, "dist/geometry-harness.js"),
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});
