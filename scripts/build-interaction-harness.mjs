import { build } from "esbuild";
import { searchWorkerDefine } from "./search-worker-build.mjs";
await build({
  entryPoints: ["tests/browser/interaction-harness.ts"],
  bundle: true,
  outfile: "dist/interaction-harness.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  define: await searchWorkerDefine(),
});
