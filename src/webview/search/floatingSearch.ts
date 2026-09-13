import {
  EditorSelection,
  StateEffect,
  StateField,
  type Extension,
  type Text,
  type SelectionRange,
} from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { executeSearch, type SearchExecutor } from "./searchExecutor.js";
import type { SearchMatch, SearchOptions, SearchResult } from "./searchPlan.js";
import {
  revealSearchMatch,
  searchReveal,
  searchPresentation,
  setSearchPresentation,
} from "../livePreview/searchReveal.js";

const setMatches = StateEffect.define<readonly SearchMatch[]>();
export const searchMatches = StateField.define<readonly SearchMatch[]>({
  create: () => [],
  update(value, transaction) {
    let next = transaction.docChanged ? [] : value;
    for (const effect of transaction.effects) if (effect.is(setMatches)) next = effect.value;
    return next;
  },
});
const currentHighlight = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = transaction.docChanged ? Decoration.none : value;
    for (const effect of transaction.effects)
      if (effect.is(revealSearchMatch)) {
        const match = effect.value;
        next =
          match && match.from < match.to
            ? Decoration.set([
                Decoration.mark({ class: "cm-source-search-current" }).range(match.from, match.to),
              ])
            : Decoration.none;
      }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
const highlights = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = transaction.docChanged ? Decoration.none : value;
    for (const effect of transaction.effects)
      if (effect.is(setMatches))
        next = Decoration.set(
          effect.value
            .filter((match) => match.from < match.to)
            .map((match) =>
              Decoration.mark({ class: "cm-source-search-match" }).range(match.from, match.to),
            ),
          true,
        );
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const labels = {
  ja: {
    find: "検索",
    replace: "置換",
    next: "次の一致",
    previous: "前の一致",
    close: "閉じる (Esc)",
    one: "置換",
    all: "すべて置換",
    case: "大文字小文字を区別",
    word: "単語単位",
    regex: "正規表現",
    selection: "選択範囲内",
    empty: "一致なし",
    busy: "検索中…",
    invalid: "正規表現が正しくありません",
    limit: "検索範囲または一致数が上限を超えています",
    timeout: "検索を中断しました。条件を簡単にしてください",
    unavailable: "検索を開始できませんでした",
  },
  en: {
    find: "Find",
    replace: "Replace",
    next: "Next match",
    previous: "Previous match",
    close: "Close (Esc)",
    one: "Replace",
    all: "Replace all",
    case: "Match case",
    word: "Whole word",
    regex: "Regular expression",
    selection: "In selection",
    empty: "No matches",
    busy: "Searching…",
    invalid: "Invalid regular expression",
    limit: "Search size or match limit exceeded",
    timeout: "Search stopped. Simplify the expression",
    unavailable: "Search could not start",
  },
};

export function createFloatingSearch(options: {
  isReady: () => boolean;
  isEditable: () => boolean;
  save: () => void;
  executor?: SearchExecutor;
}): {
  extension: Extension;
  open(view: EditorView, replace: boolean): void;
} {
  const instances = new WeakMap<EditorView, FloatingSearch>();
  class FloatingSearch {
    readonly dom = document.createElement("section");
    private readonly query = document.createElement("input");
    private readonly replacement = document.createElement("input");
    private readonly replaceRow = document.createElement("div");
    private readonly status = document.createElement("span");
    private readonly toggles = new Map<keyof SearchOptions | "scope", HTMLButtonElement>();
    private readonly replaceButtons: HTMLButtonElement[] = [];
    private readonly expand: HTMLButtonElement;
    private readonly text = document.documentElement.lang.startsWith("ja") ? labels.ja : labels.en;
    private abort: AbortController | undefined;
    private snapshot: Text | undefined;
    private result: SearchResult = { matches: [] };
    private saved: SelectionRange;
    private scope: { from: number; to: number } | undefined;
    private current = -1;
    private opened = false;
    private destroyed = false;
    private generation = 0;
    constructor(readonly view: EditorView) {
      instances.set(view, this);
      this.saved = view.state.selection.main;
      this.dom.className = "cm-floating-search";
      this.dom.setAttribute("role", "search");
      this.dom.setAttribute("aria-label", this.text.find);
      this.query.type = this.replacement.type = "text";
      this.query.placeholder = this.text.find;
      this.replacement.placeholder = this.text.replace;
      this.query.setAttribute("aria-label", this.text.find);
      this.replacement.setAttribute("aria-label", this.text.replace);
      this.query.dataset["searchInput"] = "query";
      this.replacement.dataset["searchInput"] = "replacement";
      const row = document.createElement("div");
      row.className = "cm-floating-search-row";
      this.expand = this.button("", `${this.text.replace} / ${this.text.find}`, () => {
        this.setExpanded(this.replaceRow.hidden !== false);
      });
      this.expand.className = "cm-search-expand";
      row.append(
        this.expand,
        this.query,
        this.button("↑", this.text.previous, () => this.navigate(-1)),
        this.button("↓", this.text.next, () => this.navigate(1)),
        this.button("×", this.text.close, () => {
          this.close();
        }),
      );
      this.replaceRow.className = "cm-floating-search-row";
      const one = this.button(this.text.one, this.text.one, () => {
        this.replace(false);
      });
      const all = this.button(this.text.all, this.text.all, () => {
        this.replace(true);
      });
      this.replaceButtons.push(one, all);
      this.replaceRow.append(this.replacement, one, all);
      const controls = document.createElement("div");
      controls.className = "cm-floating-search-options";
      for (const [key, display, label] of [
        ["caseSensitive", "Aa", this.text.case],
        ["wholeWord", "ab", this.text.word],
        ["regexp", ".*", this.text.regex],
        ["scope", this.text.selection, this.text.selection],
      ] as const) {
        const button = this.button(display, label, () => {
          button.setAttribute(
            "aria-pressed",
            String(button.getAttribute("aria-pressed") !== "true"),
          );
          this.refresh();
        });
        button.setAttribute("aria-pressed", "false");
        this.toggles.set(key, button);
        controls.append(button);
      }
      this.status.setAttribute("role", "status");
      this.status.setAttribute("aria-live", "polite");
      const queryBox = document.createElement("div");
      queryBox.className = "cm-search-query-box";
      this.query.replaceWith(queryBox);
      queryBox.append(this.query);
      for (const option of ["caseSensitive", "wholeWord", "regexp"] as const) {
        const button = this.toggles.get(option);
        if (button) queryBox.append(button);
      }
      const scopeButton = this.toggles.get("scope");
      if (scopeButton) {
        scopeButton.textContent = "";
        scopeButton.className = "cm-search-scope";
        row.insertBefore(scopeButton, row.lastChild);
      }
      row.insertBefore(this.status, queryBox.nextSibling);
      this.dom.append(row, this.replaceRow);
      this.dom.addEventListener("focusin", () => {
        if (!this.view.state.field(searchPresentation))
          this.view.dispatch({ effects: setSearchPresentation.of(true) });
      });
      this.query.addEventListener("input", () => {
        this.refresh();
      });
      this.replacement.addEventListener("input", () => {
        this.refresh(false);
      });
      this.dom.addEventListener("keydown", (event) => {
        // Keep native input Undo and Tab inside this form; never forward to the table/workbench.
        event.stopPropagation();
        if (event.isComposing || Reflect.get(event, "keyCode") === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          this.close();
        } else if (event.key === "Enter" || event.key === "F3") {
          event.preventDefault();
          this.navigate(event.shiftKey ? -1 : 1);
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          options.save();
        } else if (
          (event.ctrlKey || event.metaKey) &&
          ["f", "h"].includes(event.key.toLowerCase())
        ) {
          event.preventDefault();
          this.open(event.key.toLowerCase() === "h");
        } else if (event.key === "Tab") {
          const controls = [
            ...this.dom.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"),
          ].filter((element) => !element.disabled && !element.closest("[hidden]"));
          const index = controls.findIndex((element) => element === document.activeElement);
          const target =
            controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length];
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }
      });
    }
    private setExpanded(expanded: boolean): void {
      this.replaceRow.hidden = !expanded;
      this.expand.setAttribute("aria-expanded", String(expanded));
    }
    private button(display: string, label: string, run: () => void): HTMLButtonElement {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = display;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.addEventListener("click", run);
      return button;
    }
    open(replace: boolean): void {
      if (!options.isReady() || this.view.composing || this.view.compositionStarted) return;
      const alreadyOpened = this.opened;
      if (!this.opened) {
        this.saved = this.view.state.selection.main;
        this.scope = this.saved.empty ? undefined : { from: this.saved.from, to: this.saved.to };
        this.toggles.get("scope")?.setAttribute("aria-pressed", "false");
        const selected = this.view.state.sliceDoc(this.saved.from, this.saved.to);
        if (selected && !selected.includes("\n")) this.query.value = selected;
        this.view.dom.append(this.dom);
        this.opened = true;
      }
      const scope = this.toggles.get("scope");
      if (scope) scope.disabled = this.scope === undefined;
      if (replace || !alreadyOpened) this.setExpanded(replace);
      this.query.focus();
      this.query.select();
      this.refresh();
    }
    private close(): void {
      const owned = this.dom.contains(document.activeElement);
      const match = this.result.matches[this.current];
      const selection =
        this.snapshot === this.view.state.doc && match
          ? EditorSelection.single(match.to)
          : EditorSelection.single(this.saved.anchor, this.saved.head);
      this.opened = false;
      this.generation++;
      this.abort?.abort();
      this.dom.remove();
      this.view.dispatch({
        selection,
        effects: [
          setMatches.of([]),
          revealSearchMatch.of(undefined),
          setSearchPresentation.of(false),
        ],
        scrollIntoView: owned,
      });
      if (owned) this.view.focus();
    }
    private enabled(key: keyof SearchOptions | "scope"): boolean {
      return this.toggles.get(key)?.getAttribute("aria-pressed") === "true";
    }
    private refresh(navigate = true): void {
      this.abort?.abort();
      this.abort = new AbortController();
      const generation = ++this.generation;
      const snapshot = this.view.state.doc;
      const selection = this.view.state.selection.main;
      const previous = this.result.matches[this.current];
      this.snapshot = undefined;
      this.result = { matches: [] };
      this.current = -1;
      this.view.dispatch({ effects: [setMatches.of([]), revealSearchMatch.of(undefined)] });
      this.status.textContent = this.text.busy;
      this.setButtons();
      void (options.executor ?? executeSearch)(
        {
          text: snapshot.toString(),
          options: {
            search: this.query.value,
            replace: this.replacement.value,
            caseSensitive: this.enabled("caseSensitive"),
            wholeWord: this.enabled("wholeWord"),
            regexp: this.enabled("regexp"),
          },
          ...(this.enabled("scope") && this.scope ? { scope: this.scope } : {}),
        },
        this.abort.signal,
      )
        .then((result) => {
          if (
            this.destroyed ||
            !this.opened ||
            generation !== this.generation ||
            snapshot !== this.view.state.doc
          )
            return;
          this.snapshot = snapshot;
          this.result = result;
          this.view.dispatch({ effects: setMatches.of(result.matches) });
          if (
            navigate &&
            this.dom.contains(document.activeElement) &&
            this.view.state.selection.main.eq(selection) &&
            result.matches.length
          ) {
            const index = result.matches.findIndex((match) => match.from >= selection.from);
            this.select(index < 0 ? 0 : index);
          } else {
            this.current = result.matches.findIndex(
              (match) => match.from === previous?.from && match.to === previous.to,
            );
            if (this.current >= 0) this.select(this.current);
            else this.showStatus();
          }
        })
        .catch(() => {
          if (generation === this.generation && this.opened) {
            this.result = { matches: [], error: "unavailable" };
            this.showStatus();
          }
        });
    }
    private setButtons(): void {
      for (const button of this.replaceButtons)
        button.setAttribute(
          "aria-disabled",
          String(
            !options.isEditable() ||
              !this.result.matches.length ||
              this.snapshot !== this.view.state.doc,
          ),
        );
    }
    private showStatus(): void {
      this.status.textContent = this.result.error
        ? this.text[this.result.error]
        : this.result.matches.length
          ? `${String(this.current + 1)} / ${String(this.result.matches.length)}`
          : this.text.empty;
      this.query.setAttribute("aria-invalid", String(this.result.error === "invalid"));
      this.setButtons();
    }
    private select(index: number): void {
      const match = this.result.matches[index];
      if (!match || !options.isReady()) return;
      this.current = index;
      this.view.dispatch({
        effects: [
          revealSearchMatch.of(match),
          EditorView.scrollIntoView(match.from, { y: "nearest" }),
        ],
      });
      this.showStatus();
    }
    navigate(direction: number): boolean {
      if (!this.opened) {
        this.open(false);
        return true;
      }
      if (this.snapshot === this.view.state.doc && this.result.matches.length && options.isReady())
        this.select(
          this.current < 0
            ? direction < 0
              ? this.result.matches.length - 1
              : 0
            : (this.current + direction + this.result.matches.length) % this.result.matches.length,
        );
      return true;
    }
    private replace(all: boolean): void {
      if (
        !options.isEditable() ||
        this.view.composing ||
        this.view.compositionStarted ||
        this.snapshot !== this.view.state.doc
      )
        return;
      const matches = all
        ? this.result.matches
        : this.result.matches.slice(this.current, this.current + 1);
      if (!matches.length) return;
      this.view.dispatch({
        changes: matches,
        userEvent: "input.replace",
        effects: revealSearchMatch.of(undefined),
      });
    }
    update(update: ViewUpdate): void {
      if (!this.opened) return;
      if (update.focusChanged && update.view.hasFocus) {
        queueMicrotask(() => {
          if (!this.destroyed && this.opened && this.view.hasFocus) {
            this.saved = this.view.state.selection.main;
            this.view.dispatch({ effects: setSearchPresentation.of(false) });
          }
        });
      }
      if (update.selectionSet && !update.docChanged && this.view.hasFocus)
        this.saved = this.view.state.selection.main;
      if (update.docChanged) {
        this.saved = this.saved.map(update.changes);
        if (this.scope)
          this.scope = {
            from: update.changes.mapPos(this.scope.from, -1),
            to: update.changes.mapPos(this.scope.to, 1),
          };
        this.abort?.abort();
        this.snapshot = undefined;
        const generation = ++this.generation;
        queueMicrotask(() => {
          if (!this.destroyed && this.opened && generation === this.generation) this.refresh();
        });
      }
      this.setButtons();
    }
    destroy(): void {
      this.destroyed = true;
      this.abort?.abort();
      this.dom.remove();
      instances.delete(this.view);
    }
  }
  return {
    open: (view, replace) => instances.get(view)?.open(replace),
    extension: [
      searchReveal,
      searchPresentation,
      searchMatches,
      highlights,
      currentHighlight,
      ViewPlugin.fromClass(FloatingSearch),
      keymap.of([
        {
          key: "F3",
          run: (view) => instances.get(view)?.navigate(1) ?? false,
          preventDefault: true,
          stopPropagation: true,
        },
        {
          key: "Shift-F3",
          run: (view) => instances.get(view)?.navigate(-1) ?? false,
          preventDefault: true,
          stopPropagation: true,
        },
      ]),
      EditorView.baseTheme({
        ".cm-floating-search": {
          position: "absolute",
          top: "4px",
          right: "8px",
          width: "min(460px, calc(100% - 16px))",
          boxSizing: "border-box",
          padding: "6px",
          zIndex: "25",
          font: "12px var(--vscode-font-family, sans-serif)",
          color: "var(--vscode-editorWidget-foreground, inherit)",
          background: "var(--vscode-editorWidget-background, #252526)",
          border: "1px solid var(--vscode-editorWidget-border, #888)",
          boxShadow: "0 2px 8px var(--vscode-widget-shadow, #0005)",
        },
        ".cm-floating-search-row, .cm-floating-search-options": {
          display: "flex",
          gap: "4px",
          marginBottom: "4px",
          alignItems: "center",
          flexWrap: "nowrap",
        },
        ".cm-floating-search [hidden]": { display: "none" },
        ".cm-search-expand::before": {
          content: "''",
          display: "block",
          width: "6px",
          height: "6px",
          borderRight: "1.5px solid currentColor",
          borderBottom: "1.5px solid currentColor",
          transform: "rotate(-45deg)",
          margin: "0 3px",
        },
        ".cm-search-expand[aria-expanded=true]::before": { transform: "rotate(45deg)" },
        ".cm-search-query-box": {
          display: "flex",
          flex: "1 1 160px",
          minWidth: "65px",
          alignItems: "center",
          border: "1px solid var(--vscode-input-border, transparent)",
          background: "var(--vscode-input-background, #80808022)",
        },
        ".cm-search-query-box:focus-within": { borderColor: "var(--vscode-focusBorder, #168bdd)" },
        ".cm-search-query-box input": {
          width: "40px",
          minWidth: "20px",
          border: "none",
          outline: "none",
          background: "transparent",
        },
        ".cm-floating-search [role=status]": {
          whiteSpace: "nowrap",
          minWidth: "30px",
          fontSize: "11px",
        },
        ".cm-search-scope::before": {
          content: "''",
          display: "block",
          width: "12px",
          height: "10px",
          borderLeft: "1px solid currentColor",
          borderRight: "1px solid currentColor",
          background:
            "repeating-linear-gradient(to bottom, transparent 0 2px, currentColor 2px 3px, transparent 3px 4px)",
        },
        ".cm-floating-search input": {
          flex: "1 1 100px",
          minWidth: "50px",
          width: "100px",
          padding: "4px",
          color: "var(--vscode-input-foreground, inherit)",
          background: "var(--vscode-input-background, #333)",
          border: "1px solid var(--vscode-input-border, transparent)",
        },
        ".cm-floating-search button": {
          cursor: "pointer",
          color: "inherit",
          background: "transparent",
          border: "1px solid transparent",
          borderRadius: "2px",
          padding: "3px 5px",
          margin: "0",
          flexShrink: "0",
          minHeight: "24px",
        },
        ".cm-floating-search button:hover, .cm-floating-search button[aria-pressed=true]": {
          background: "var(--vscode-inputOption-activeBackground, #555)",
          borderColor: "var(--vscode-inputOption-activeBorder, #888)",
        },
        ".cm-floating-search :focus-visible": {
          outline: "1px solid var(--vscode-focusBorder, #168bdd)",
        },
        ".cm-floating-search button:disabled, .cm-floating-search button[aria-disabled=true]": {
          opacity: "0.45",
          cursor: "default",
        },
        ".cm-source-search-match": {
          background: "var(--vscode-editor-findMatchHighlightBackground, #ea5c004d)",
          outline: "1px solid var(--vscode-editor-findMatchHighlightBorder, transparent)",
        },
        ".cm-source-search-current": {
          background: "var(--vscode-editor-findMatchBackground, #9e6a03)",
          outline:
            "1px solid var(--vscode-editor-findMatchBorder, var(--vscode-contrastActiveBorder, transparent))",
        },
      }),
    ],
  };
}
