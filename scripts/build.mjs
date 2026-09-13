import * as esbuild from "esbuild";

import { searchWorkerDefine } from "./search-worker-build.mjs";

const watch = process.argv.includes("--watch");

const extensionContext = await esbuild.context({
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  outfile: "dist/extension.cjs",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
});

const webviewContext = await esbuild.context({
  define: await searchWorkerDefine(),
  entryPoints: ["src/webview/editor.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});

const interactionProbeContext = await esbuild.context({
  entryPoints: ["tests/browser/interaction-probe.ts"],
  bundle: true,
  outfile: "dist/interaction-probe.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  define: await searchWorkerDefine(),
});

const u4LinkProbeContext = await esbuild.context({
  entryPoints: ["tests/browser/u4-link-probe.ts"],
  bundle: true,
  outfile: "dist/u4-link-probe.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  define: await searchWorkerDefine(),
});

const extensionHostTestContext = await esbuild.context({
  entryPoints: {
    index: "tests/extension-host/index.ts",
    v02: "tests/extension-host/v02.ts",
  },
  bundle: true,
  outdir: "dist/extension-host",
  outExtension: { ".js": ".cjs" },
  // Prettier loads parser plugins dynamically. Keep the already-installed
  // development dependency external so the extension-host test runs it from
  // its package boundary instead of bundling an invalid dynamic require.
  external: ["vscode", "prettier"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
});

if (watch) {
  await Promise.all([
    extensionContext.watch(),
    webviewContext.watch(),
    interactionProbeContext.watch(),
    u4LinkProbeContext.watch(),
    extensionHostTestContext.watch(),
  ]);
  console.log("Watching extension bundle...");
} else {
  await Promise.all([
    extensionContext.rebuild(),
    webviewContext.rebuild(),
    interactionProbeContext.rebuild(),
    u4LinkProbeContext.rebuild(),
    extensionHostTestContext.rebuild(),
  ]);
  await Promise.all([
    extensionContext.dispose(),
    webviewContext.dispose(),
    interactionProbeContext.dispose(),
    u4LinkProbeContext.dispose(),
    extensionHostTestContext.dispose(),
  ]);
}
