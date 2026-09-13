import { build } from "esbuild";

// Embed one local bundle, so VS Code's blob-only Worker loading needs no fetch or new resource root.
export async function searchWorkerDefine() {
  const result = await build({
    entryPoints: ["src/webview/search/searchWorker.ts"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
  });
  return { SEARCH_WORKER_SOURCE: JSON.stringify(result.outputFiles[0].text) };
}
