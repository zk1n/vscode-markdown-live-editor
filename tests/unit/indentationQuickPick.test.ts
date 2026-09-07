import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  createIndentationQuickPickItems,
  createIndentationQuickPickOptions,
} from "../../src/extension/extension.js";
import type { Localizer } from "../../src/extension/localization.js";

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
  });
});

const englishLocalizer: Localizer = {
  t(message: string): string {
    return message;
  },
};
