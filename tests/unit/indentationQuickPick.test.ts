import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  createIndentationQuickPickItems,
  createIndentationQuickPickOptions,
  createTabSizeQuickPickItems,
  createTabSizeQuickPickOptions,
} from "../../src/extension/extension.js";
import type { Localizer } from "../../src/extension/localization.js";
import { DocumentIndentation } from "../../src/extension/editor/DocumentIndentation.js";

describe("indentation status quick pick", () => {
  it("uses VS Code's action and view grouping in the standard order", () => {
    const items = createIndentationQuickPickItems(englishLocalizer);

    expect(createIndentationQuickPickOptions(englishLocalizer)).toEqual({
      placeHolder: "Select Action",
    });
    expect(items).toEqual([
      { label: "change view", kind: -1 },
      {
        label: "Indent Using Spaces",
        value: "spaces",
      },
      {
        label: "Indent Using Tabs",
        value: "tabs",
      },
      {
        label: "Change Tab Display Size",
        value: "size",
      },
    ]);
  });

  it("uses Japanese labels while retaining English aliases as item details", () => {
    const translations: Readonly<Record<string, string>> = {
      "Indent Using Spaces": "スペースでインデント",
      "Indent Using Tabs": "タブでインデント",
      "change view": "ビューの変更",
      "Change Tab Display Size": "タブ表示サイズの変更",
      "Select Action": "アクションの選択",
    };
    const japaneseLocalizer: Localizer = {
      t(message: string): string {
        return translations[message] ?? message;
      },
    };

    expect(createIndentationQuickPickOptions(japaneseLocalizer)).toEqual({
      placeHolder: "アクションの選択",
    });
    expect(createIndentationQuickPickItems(japaneseLocalizer)).toEqual([
      { label: "ビューの変更", kind: -1 },
      {
        label: "スペースでインデント",
        detail: "Indent Using Spaces",
        value: "spaces",
      },
      {
        label: "タブでインデント",
        detail: "Indent Using Tabs",
        value: "tabs",
      },
      {
        label: "タブ表示サイズの変更",
        detail: "Change Tab Display Size",
        value: "size",
      },
    ]);
  });

  it("ships the Japanese action and view labels in the runtime localization bundle", () => {
    const bundle = readFileSync(new URL("../../l10n/bundle.l10n.ja.json", import.meta.url), "utf8");

    expect(bundle).toContain('"Select Action": "アクションの選択"');
    expect(bundle).toContain('"change view": "ビューの変更"');
    expect(bundle).toContain('"Change Tab Display Size": "タブ表示サイズの変更"');
    expect(bundle).toContain(
      '"Select Tab Size for Current File": "現在のファイルのタブ サイズを選択"',
    );
  });
});

const englishLocalizer: Localizer = {
  t(message: string): string {
    return message;
  },
};

describe("indentation picker sequence", () => {
  it("retains document options across panel reopen without changing other documents or defaults", () => {
    const options = new DocumentIndentation();
    const document = {};
    const defaults = { insertSpaces: true, tabSize: 4 };
    options.set(document, { insertSpaces: false, tabSize: 8 });
    expect(options.resolve(document, defaults)).toEqual({ insertSpaces: false, tabSize: 8 });
    expect(options.resolve({}, defaults)).toEqual(defaults);
    expect(defaults).toEqual({ insertSpaces: true, tabSize: 4 });
  });
  it("notifies every live panel for the same document and disposes subscriptions", () => {
    const options = new DocumentIndentation();
    const document = {};
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();
    const subscription = options.subscribe(document, first);
    options.subscribe(document, second);
    options.subscribe({}, other);
    options.set(document, { insertSpaces: true, tabSize: 2, indentSize: 2 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    subscription.dispose();
    options.set(document, { insertSpaces: false, tabSize: 8, indentSize: 8 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
  it("marks configured, default, and current tab sizes like the standard picker", () => {
    const items = createTabSizeQuickPickItems(4, 2, englishLocalizer);

    expect(items).toEqual([
      { label: "1", value: 1 },
      { label: "2", value: 2, description: "Current Tab Size" },
      { label: "3", value: 3 },
      { label: "4", value: 4, description: "Default Tab Size" },
      { label: "5", value: 5 },
      { label: "6", value: 6 },
      { label: "7", value: 7 },
      { label: "8", value: 8 },
    ]);
    expect(createTabSizeQuickPickItems(4, 4, englishLocalizer)[3]).toEqual({
      label: "4",
      value: 4,
      description: "Configured Tab Size",
    });
  });

  it("uses the current document tab size as the active item without a custom title", () => {
    const items = createTabSizeQuickPickItems(4, 12, englishLocalizer);

    expect(createTabSizeQuickPickOptions(items, 12, englishLocalizer)).toEqual({
      placeHolder: "Select Tab Size for Current File",
      activeItem: items[7],
    });
    expect(createTabSizeQuickPickOptions(items, 2, englishLocalizer)).toEqual({
      placeHolder: "Select Tab Size for Current File",
      activeItem: items[1],
    });
  });

  it("localizes the standard tab-size placeholder and descriptions", () => {
    const translations: Readonly<Record<string, string>> = {
      "Select Tab Size for Current File": "現在のファイルのタブ サイズを選択",
      "Configured Tab Size": "構成されたタブ サイズ",
      "Default Tab Size": "既定のタブ サイズ",
      "Current Tab Size": "現在のタブ サイズ",
    };
    const localizer: Localizer = { t: (message): string => translations[message] ?? message };
    const items = createTabSizeQuickPickItems(4, 2, localizer);

    expect(createTabSizeQuickPickOptions(items, 2, localizer).placeHolder).toBe(
      "現在のファイルのタブ サイズを選択",
    );
    expect(items[1]?.description).toBe("現在のタブ サイズ");
    expect(items[3]?.description).toBe("既定のタブ サイズ");
  });
});
