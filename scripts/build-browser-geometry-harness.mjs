import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["tests/browser/geometry-harness.ts"],
  bundle: true,
  outfile: "dist/geometry-harness.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});
