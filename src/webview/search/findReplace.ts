import { type EditorState, type Extension } from "@codemirror/state";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView, keymap, type KeyBinding, type Panel, type ViewUpdate } from "@codemirror/view";

export interface FindReplaceOptions {
  /**
   * The editor controller remains the authority for whether source mutations
   * are currently safe (for example, outside composition or a sync barrier).
   */
  readonly isEditable: () => boolean;
}

export interface FindReplace {
  readonly extension: Extension;
  open(view: EditorView, replace?: boolean): void;
}

interface SourceRange {
  readonly from: number;
  readonly to: number;
}

type SearchMatch = SourceRange;

const findReplaceTheme = EditorView.theme({
  ".cm-panel.cm-find-replace": {
    backgroundColor: "var(--vscode-editorWidget-background)",
    borderBottom: "1px solid var(--vscode-editorWidget-border)",
    boxSizing: "border-box",
    color: "var(--vscode-editorWidget-foreground)",
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    padding: "6px",
  },
  ".cm-find-replace-row": {
    alignItems: "center",
    display: "flex",
    flex: "1 1 100%",
    flexWrap: "wrap",
    gap: "4px",
    minWidth: "0",
  },
  ".cm-find-replace input[type=text]": {
    backgroundColor: "var(--vscode-input-background)",
    border: "1px solid var(--vscode-input-border)",
    borderRadius: "2px",
    color: "var(--vscode-input-foreground)",
    font: "inherit",
    minWidth: "9rem",
    padding: "2px 4px",
  },
  ".cm-find-replace input[type=text]:focus": {
    borderColor: "var(--vscode-focusBorder)",
    outline: "1px solid var(--vscode-focusBorder)",
  },
  ".cm-find-replace button": {
    backgroundColor: "var(--vscode-button-secondaryBackground)",
    border: "1px solid transparent",
    borderRadius: "2px",
    color: "var(--vscode-button-secondaryForeground)",
    font: "inherit",
    padding: "2px 6px",
  },
  ".cm-find-replace button:hover:not(:disabled)": {
    backgroundColor: "var(--vscode-button-secondaryHoverBackground)",
  },
  ".cm-find-replace button:focus": {
    borderColor: "var(--vscode-focusBorder)",
    outline: "1px solid var(--vscode-focusBorder)",
  },
  ".cm-find-replace button:disabled": {
    cursor: "default",
    opacity: "0.55",
  },
  ".cm-find-replace label": {
    alignItems: "center",
    display: "inline-flex",
    fontSize: "0.9em",
    gap: "2px",
    whiteSpace: "nowrap",
  },
  ".cm-find-replace-count": {
    color: "var(--vscode-descriptionForeground)",
    fontVariantNumeric: "tabular-nums",
    minWidth: "4.5rem",
    textAlign: "right",
  },
  ".cm-find-replace-status": {
    color: "var(--vscode-errorForeground)",
    fontSize: "0.9em",
    minHeight: "1.2em",
  },
});

/**
 * Creates the webview-only Find / Replace surface. `open` is intentionally
 * separate from the extension so the controller can route host commands only
 * to the active CodeMirror view.
 */
export function createFindReplace(options: FindReplaceOptions): FindReplace {
  const panels = new WeakMap<EditorView, FindReplacePanel>();
  const openWithReplace = new WeakSet<EditorView>();
  const createPanel = (view: EditorView): Panel => {
    const panel = new FindReplacePanel(view, options);
    panels.set(view, panel);
    if (openWithReplace.delete(view)) {
      panel.setReplaceVisible(true);
    }
    return panel;
  };

  const open = (view: EditorView, replace = false): void => {
    if (view.composing) {
      return;
    }
    if (replace) {
      openWithReplace.add(view);
    }
    openSearchPanel(view);
    const panel = panels.get(view);
    if (panel !== undefined) {
      panel.setReplaceVisible(replace);
    }
  };

  const keyBindings: readonly KeyBinding[] = [
    {
      key: "Mod-f",
      preventDefault: true,
      run: (view): boolean => {
        if (view.composing) {
          return false;
        }
        open(view);
        return true;
      },
      stopPropagation: true,
    },
    {
      key: "Mod-h",
      preventDefault: true,
      run: (view): boolean => {
        if (view.composing) {
          return false;
        }
        open(view, true);
        return true;
      },
      stopPropagation: true,
    },
    {
      key: "F3",
      preventDefault: true,
      run: (view): boolean => {
        if (view.composing) {
          return false;
        }
        return findNext(view);
      },
      shift: (view): boolean => {
        if (view.composing) {
          return false;
        }
        return findPrevious(view);
      },
      stopPropagation: true,
    },
  ];

  return {
    extension: [search({ createPanel, top: true }), keymap.of(keyBindings), findReplaceTheme],
    open,
  };
}

class FindReplacePanel implements Panel {
  public readonly dom: HTMLElement;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly caseField: HTMLInputElement;
  private readonly wordField: HTMLInputElement;
  private readonly regexpField: HTMLInputElement;
  private readonly scopeField: HTMLInputElement;
  private readonly replaceRow: HTMLElement;
  private readonly count: HTMLElement;
  private readonly status: HTMLElement;
  private readonly replaceButton: HTMLButtonElement;
  private readonly replaceAllButton: HTMLButtonElement;
  private query: SearchQuery;
  private selectionScope: SourceRange | undefined;

  public constructor(
    private readonly view: EditorView,
    private readonly options: FindReplaceOptions,
  ) {
    this.query = getSearchQuery(view.state);
    this.dom = document.createElement("div");
    this.dom.className = "cm-search cm-find-replace";
    this.dom.setAttribute("role", "search");
    this.dom.addEventListener("keydown", (event): void => {
      this.handleKeydown(event);
    });

    const findRow = this.createRow();
    this.searchField = this.createTextField("検索", "search", true);
    findRow.append(this.searchField);
    findRow.append(
      this.createButton("前へ", "previous", (): void => {
        this.movePrevious();
      }),
    );
    findRow.append(
      this.createButton("次へ", "next", (): void => {
        this.moveNext();
      }),
    );
    this.count = document.createElement("span");
    this.count.className = "cm-find-replace-count";
    this.count.dataset["findReplace"] = "count";
    this.count.setAttribute("aria-live", "polite");
    findRow.append(this.count);
    const caseToggle = this.createToggle("大文字小文字", "case");
    this.caseField = caseToggle.field;
    findRow.append(caseToggle.element);
    const wordToggle = this.createToggle("単語単位", "word");
    this.wordField = wordToggle.field;
    findRow.append(wordToggle.element);
    const regexpToggle = this.createToggle("正規表現", "regexp");
    this.regexpField = regexpToggle.field;
    findRow.append(regexpToggle.element);
    const scopeToggle = this.createToggle("選択範囲内", "selection");
    this.scopeField = scopeToggle.field;
    findRow.append(scopeToggle.element);
    findRow.append(
      this.createButton(
        "閉じる",
        "close",
        (): void => {
          this.close();
        },
        "閉じる",
      ),
    );

    this.replaceRow = this.createRow();
    this.replaceRow.dataset["findReplace"] = "replace-row";
    this.replaceField = this.createTextField("置換", "replace", false);
    this.replaceRow.append(this.replaceField);
    this.replaceButton = this.createButton("置換", "replace", (): void => {
      this.replaceCurrent();
    });
    this.replaceRow.append(this.replaceButton);
    this.replaceAllButton = this.createButton("すべて置換", "replace-all", (): void => {
      this.replaceEvery();
    });
    this.replaceRow.append(this.replaceAllButton);

    this.status = document.createElement("span");
    this.status.className = "cm-find-replace-status";
    this.status.dataset["findReplace"] = "status";
    this.status.setAttribute("aria-live", "polite");

    this.dom.append(findRow, this.replaceRow, this.status);
    this.searchField.addEventListener("input", (): void => {
      this.commitQuery();
    });
    this.replaceField.addEventListener("input", (): void => {
      this.commitQuery();
    });
    for (const field of [this.caseField, this.wordField, this.regexpField]) {
      field.addEventListener("change", (): void => {
        this.commitQuery();
      });
    }
    this.scopeField.addEventListener("change", (): void => {
      this.setSelectionScope();
    });
    this.reflectQuery(this.query);
    this.setReplaceVisible(false);
  }

  public readonly top = true;

  public mount(): void {
    this.searchField.focus();
    this.searchField.select();
  }

  public update(update: ViewUpdate): void {
    if (update.docChanged && this.selectionScope !== undefined) {
      this.selectionScope = {
        from: update.changes.mapPos(this.selectionScope.from, -1),
        to: update.changes.mapPos(this.selectionScope.to, 1),
      };
      // The query's predicate closes over this panel, so it observes the
      // mapped range without dispatching recursively from Panel.update.
    }
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.reflectQuery(effect.value);
        }
      }
    }
    if (update.docChanged || update.selectionSet) {
      this.renderMatchState();
    }
  }

  public setReplaceVisible(visible: boolean): void {
    this.replaceRow.hidden = !visible;
    if (visible) {
      this.replaceField.focus();
      this.replaceField.select();
    }
  }

  private createRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "cm-find-replace-row";
    return row;
  }

  private createTextField(label: string, name: string, mainField: boolean): HTMLInputElement {
    const field = document.createElement("input");
    field.type = "text";
    field.autocomplete = "off";
    field.className = "cm-textfield";
    field.name = name;
    field.placeholder = label;
    field.setAttribute("aria-label", label);
    field.dataset["findReplace"] = name;
    if (mainField) {
      field.setAttribute("main-field", "true");
    }
    return field;
  }

  private createButton(
    label: string,
    name: string,
    onClick: () => void,
    ariaLabel = label,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.name = name;
    button.textContent = label;
    button.setAttribute("aria-label", ariaLabel);
    button.dataset["findReplace"] = name;
    button.addEventListener("click", onClick);
    return button;
  }

  private createToggle(
    label: string,
    name: string,
  ): { readonly element: HTMLElement; readonly field: HTMLInputElement } {
    const element = document.createElement("label");
    const field = document.createElement("input");
    field.type = "checkbox";
    field.name = name;
    field.setAttribute("aria-label", label);
    field.dataset["findReplace"] = name;
    element.append(field, document.createTextNode(label));
    return { element, field };
  }

  private handleKeydown(event: KeyboardEvent): void {
    // The panel is outside CM's content DOM, but a webview wrapper can still
    // observe bubbled trusted keys. Keep text-input Undo and IME local here.
    event.stopPropagation();
    if (event.isComposing) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.searchField.focus();
      this.searchField.select();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "h") {
      event.preventDefault();
      this.setReplaceVisible(true);
      return;
    }
    if (event.key === "F3") {
      event.preventDefault();
      if (event.shiftKey) {
        this.movePrevious();
      } else {
        this.moveNext();
      }
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    if (event.target === this.searchField) {
      if (event.shiftKey) {
        this.movePrevious();
      } else {
        this.moveNext();
      }
    } else if (event.target === this.replaceField) {
      this.replaceCurrent();
    }
  }

  private setSelectionScope(): void {
    if (this.scopeField.checked) {
      const selection = this.view.state.selection.main;
      if (selection.empty) {
        this.scopeField.checked = false;
        this.selectionScope = undefined;
        this.status.textContent = "選択範囲を選んでから有効にしてください";
        this.commitQuery();
        return;
      }
      this.selectionScope = { from: selection.from, to: selection.to };
    } else {
      this.selectionScope = undefined;
    }
    this.commitQuery();
  }

  private commitQuery(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.regexpField.checked,
      wholeWord: this.wordField.checked,
      replace: this.replaceField.value,
      ...(this.selectionScope === undefined
        ? {}
        : {
            test: (_match: string, _state: EditorState, from: number, to: number): boolean =>
              this.isInSelectionScope(from, to),
          }),
    });
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
    this.renderMatchState();
  }

  private reflectQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseField.checked = query.caseSensitive;
    this.wordField.checked = query.wholeWord;
    this.regexpField.checked = query.regexp;
    this.renderMatchState();
  }

  private isInSelectionScope(from: number, to: number): boolean {
    return (
      this.selectionScope !== undefined &&
      from >= this.selectionScope.from &&
      to <= this.selectionScope.to
    );
  }

  private matches(): readonly SearchMatch[] {
    if (!this.query.valid) {
      return [];
    }
    const matches: SearchMatch[] = [];
    const cursor = this.query.getCursor(this.view.state);
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      matches.push(next.value);
    }
    return matches;
  }

  private renderMatchState(): void {
    if (!this.query.valid) {
      this.count.textContent = "0 / 0";
      this.status.textContent = this.query.search === "" ? "" : "無効な正規表現";
      this.setReplaceButtonsDisabled(true);
      return;
    }
    const matches = this.matches();
    const selection = this.view.state.selection.main;
    const index = matches.findIndex(
      (match) => match.from === selection.from && match.to === selection.to,
    );
    this.count.textContent = `${String(index + 1)} / ${String(matches.length)}`;
    this.status.textContent = matches.length === 0 && this.query.search !== "" ? "一致なし" : "";
    this.setReplaceButtonsDisabled(matches.length === 0 || !this.options.isEditable());
  }

  private setReplaceButtonsDisabled(disabled: boolean): void {
    this.replaceButton.disabled = disabled;
    this.replaceAllButton.disabled = disabled;
  }

  private moveNext(): void {
    if (this.view.composing || !this.query.valid) {
      return;
    }
    findNext(this.view);
    this.renderMatchState();
  }

  private movePrevious(): void {
    if (this.view.composing || !this.query.valid) {
      return;
    }
    findPrevious(this.view);
    this.renderMatchState();
  }

  private replaceCurrent(): void {
    if (this.view.composing || !this.options.isEditable() || !this.query.valid) {
      this.renderMatchState();
      return;
    }
    const selection = this.view.state.selection.main;
    const current = this.matches().some(
      (match) => match.from === selection.from && match.to === selection.to,
    );
    if (!current) {
      this.moveNext();
    }
    if (this.options.isEditable()) {
      replaceNext(this.view);
    }
  }

  private replaceEvery(): void {
    if (this.view.composing || !this.options.isEditable() || !this.query.valid) {
      this.renderMatchState();
      return;
    }
    // @codemirror/search constructs all source replacements and dispatches
    // them as one `input.replace.all` transaction, preserving host sync/Undo.
    replaceAll(this.view);
  }

  private close(): void {
    closeSearchPanel(this.view);
  }
}
