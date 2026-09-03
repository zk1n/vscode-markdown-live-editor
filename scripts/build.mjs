import * as esbuild from "esbuild";

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
  entryPoints: ["src/webview/editor.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});

const extensionHostTestContext = await esbuild.context({
  entryPoints: ["tests/extension-host/index.ts"],
  bundle: true,
  outfile: "dist/extension-host/index.cjs",
  external: ["vscode"],
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
    extensionHostTestContext.watch(),
  ]);
  console.log("Watching extension bundle...");
} else {
  await Promise.all([
    extensionContext.rebuild(),
    webviewContext.rebuild(),
    extensionHostTestContext.rebuild(),
  ]);
  await Promise.all([
    extensionContext.dispose(),
    webviewContext.dispose(),
    extensionHostTestContext.dispose(),
  ]);
}
