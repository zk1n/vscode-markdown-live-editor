import { planSearch, type SearchRequest } from "./searchPlan.js";

// Messages originate only from our bundled client. Results are narrowed again at the UI boundary.
globalThis.onmessage = (event: MessageEvent<SearchRequest>): void => {
  globalThis.postMessage(planSearch(event.data));
};
