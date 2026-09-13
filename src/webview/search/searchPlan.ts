import { EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";

export interface SearchOptions {
  search: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}
export interface SearchRequest {
  text: string;
  options: SearchOptions;
  scope?: { from: number; to: number };
}
export interface SearchMatch {
  from: number;
  to: number;
  insert: string;
}
export interface SearchResult {
  matches: readonly SearchMatch[];
  error?: "invalid" | "limit" | "timeout" | "unavailable";
}

/** Runs in a disposable worker. CodeMirror owns matching and word semantics. */
export function planSearch(request: SearchRequest): SearchResult {
  if (request.text.length > 5_000_000 || request.options.search.length > 10_000)
    return { matches: [], error: "limit" };
  const query = new SearchQuery({ ...request.options, literal: true });
  if (!query.search) return { matches: [] };
  if (!query.valid) return { matches: [], error: "invalid" };
  const state = EditorState.create({ doc: request.text });
  const matches: SearchMatch[] = [];
  // Search the original document and filter whole matches, so selection boundaries
  // do not manufacture regex anchors/lookbehind or split a word.
  const cursor = query.getCursor(state);
  for (let result = cursor.next(); !result.done; result = cursor.next()) {
    const { from, to } = result.value;
    if (request.scope && (from < request.scope.from || to > request.scope.to)) continue;
    if (matches.length >= 10_000) return { matches: [], error: "limit" };
    const captures: unknown = Reflect.get(result.value, "match");
    const groups = Array.isArray(captures)
      ? captures.map((part: unknown) => (typeof part === "string" ? part : ""))
      : [];
    const insert = query.regexp ? expandReplacement(query.replace, groups) : query.replace;
    matches.push({ from, to, insert });
  }
  return { matches };
}

/** CodeMirror replacement syntax: $$, $&, $1..$99. Unmatched captures are empty. */
function expandReplacement(replacement: string, groups: readonly string[]): string {
  return replacement.replace(/\$([$&]|\d+)/g, (literal: string, token: string) => {
    if (token === "$") return "$";
    if (token === "&") return groups[0] ?? "";
    for (let length = token.length; length > 0; length--) {
      const index = Number(token.slice(0, length));
      if (index > 0 && index < groups.length) return (groups[index] ?? "") + token.slice(length);
    }
    return literal;
  });
}

export function isSearchResult(value: unknown, length: number): value is SearchResult {
  if (
    value === null ||
    typeof value !== "object" ||
    !("matches" in value) ||
    !Array.isArray(value.matches)
  )
    return false;
  if (
    "error" in value &&
    !["invalid", "limit", "timeout", "unavailable"].includes(String(value.error))
  )
    return false;
  let previous = 0;
  return (
    value.matches.length <= 10_000 &&
    value.matches.every((match: unknown) => {
      if (
        match === null ||
        typeof match !== "object" ||
        !("from" in match) ||
        !("to" in match) ||
        !("insert" in match) ||
        typeof match.from !== "number" ||
        typeof match.to !== "number" ||
        typeof match.insert !== "string" ||
        !Number.isSafeInteger(match.from) ||
        !Number.isSafeInteger(match.to) ||
        match.from < previous ||
        match.to < match.from ||
        match.to > length
      )
        return false;
      previous = match.to;
      return true;
    })
  );
}
