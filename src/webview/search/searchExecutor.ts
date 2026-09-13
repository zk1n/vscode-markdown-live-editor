import { isSearchResult, type SearchRequest, type SearchResult } from "./searchPlan.js";

declare const SEARCH_WORKER_SOURCE: string;
export type SearchExecutor = (request: SearchRequest, signal: AbortSignal) => Promise<SearchResult>;

export const executeSearch: SearchExecutor = (request, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ matches: [] });
      return;
    }
    let worker: Worker | undefined;
    let url: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: SearchResult): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      worker?.terminate();
      if (url !== undefined) URL.revokeObjectURL(url);
      resolve(result);
    };
    const cancelled = (): void => {
      finish({ matches: [] });
    };
    try {
      url = URL.createObjectURL(new Blob([SEARCH_WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = (event: MessageEvent<unknown>) => {
        finish(
          isSearchResult(event.data, request.text.length)
            ? event.data
            : { matches: [], error: "unavailable" },
        );
      };
      worker.onerror = () => {
        finish({ matches: [], error: "unavailable" });
      };
      signal.addEventListener("abort", cancelled, { once: true });
      timer = setTimeout(() => {
        finish({ matches: [], error: "timeout" });
      }, 2000);
      worker.postMessage(request);
    } catch {
      finish({ matches: [], error: "unavailable" });
    }
  });
