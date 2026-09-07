import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { readFileSync } from "node:fs";

import {
  createIndentationQuickPickItems,
  createIndentationQuickPickOptions,
  chooseIndentation,
} from "../../src/extension/extension.js";
import type { Localizer } from "../../src/extension/localization.js";
import type { StatusActionContext } from "../../src/extension/status/MarkdownEditorStatusBarManager.js";
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
  });
});

const englishLocalizer: Localizer = {
  t(message: string): string {
    return message;
  },
};

const pickerContext: StatusActionContext = {
  identity: { documentUri: "file:///note.md", sessionId: "s", controllerId: "c" },
  documentVersion: 1,
  editorState: {
    reportSequence: 1,
    documentVersion: 1,
    selectionAnchor: 0,
    selectionHead: 0,
    line: 1,
    column: 1,
    focused: true,
    composing: false,
    recoveryActive: false,
    barrierActive: false,
    insertSpaces: false,
    tabSize: 4,
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
  it.each(["spaces", "tabs", "size"])("opens size selection after %s", async (value) => {
    const pick = vi.spyOn(vscode.window, "showQuickPick");
    const action = { label: value, value };
    const size = { label: "2", value: 2 };
    pick.mockResolvedValueOnce(action);
    pick.mockResolvedValueOnce(size);
    expect(await chooseIndentation(pickerContext)).toEqual({
      insertSpaces: value === "spaces",
      tabSize: 2,
      indentSize: value === "size" ? 4 : 2,
    });
    expect(pick).toHaveBeenCalledTimes(2);
    expect(pick.mock.calls[1]?.[0]).toEqual(
      Array.from({ length: 8 }, (_, i) => ({ label: String(i + 1), value: i + 1 })),
    );
    pick.mockRestore();
  });

  it("does not apply a mode change when size selection is cancelled", async () => {
    const pick = vi.spyOn(vscode.window, "showQuickPick");
    const action = { label: "spaces", value: "spaces" };
    pick.mockResolvedValueOnce(action);
    pick.mockResolvedValueOnce(undefined);
    expect(await chooseIndentation(pickerContext)).toBeUndefined();
    pick.mockRestore();
  });
});
