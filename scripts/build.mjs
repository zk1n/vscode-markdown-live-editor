import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
});

if (watch) {
  await context.watch();
  console.log("Watching extension bundle...");
} else {
  await context.rebuild();
  await context.dispose();
}
