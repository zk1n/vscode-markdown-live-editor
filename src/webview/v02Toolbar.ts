import type { Extension } from "@codemirror/state";
import { EditorView, showPanel } from "@codemirror/view";
import type { RichCommand } from "../protocol/richMessages.js";
import { editTable, type TableAction } from "./livePreview/tableEditing.js";

export function v02Toolbar(
  run: (command: RichCommand) => void,
  isEditable: () => boolean,
  notify: (note: string) => void,
): Extension {
  return [
    showPanel.of((view) => {
      const dom = document.createElement("div");
      dom.className = "cm-v02-toolbar";
      dom.setAttribute("role", "toolbar");
      dom.setAttribute("aria-label", "Markdown編集");
      for (const [label, command] of [
        ["検索", "find"],
        ["置換", "replace"],
        ["表を挿入", "insert-table"],
        ["画像を挿入", "insert-image"],
      ] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", () => {
          run(command);
        });
        dom.append(button);
      }
      const select = document.createElement("select");
      select.setAttribute("aria-label", "表の操作");
      const actions: readonly (readonly [string, TableAction | ""])[] = [
        ["表の操作…", ""],
        ["行を追加", "row-add"],
        ["行を削除", "row-delete"],
        ["列を追加", "column-add"],
        ["列を削除", "column-delete"],
        ["左揃え", "align-left"],
        ["中央揃え", "align-center"],
        ["右揃え", "align-right"],
        ["表のsource表示切替", "source"],
      ];
      for (const [label, action] of actions) {
        const option = document.createElement("option");
        option.textContent = label;
        option.value = action;
        select.append(option);
      }
      select.addEventListener("change", () => {
        const action = actions.find((entry) => entry[1] === select.value)?.[1];
        if (action !== undefined && action !== "" && (!isEditable() || !editTable(view, action)))
          notify("表のセルにcaretを置いて操作してください。ヘッダー行と最後の列は削除できません。");
        select.value = "";
      });
      dom.append(select);
      return { dom, top: true };
    }),
    EditorView.baseTheme({
      ".cm-v02-toolbar": {
        display: "flex",
        flexWrap: "wrap",
        gap: "4px",
        padding: "4px 8px",
        color: "var(--vscode-foreground)",
        background: "var(--vscode-editorWidget-background)",
        borderBottom: "1px solid var(--vscode-editorWidget-border)",
        font: "12px var(--vscode-font-family)",
      },
      ".cm-v02-toolbar button, .cm-v02-toolbar select": {
        font: "inherit",
        color: "inherit",
        background: "var(--vscode-dropdown-background, transparent)",
        border: "1px solid var(--vscode-dropdown-border, transparent)",
        padding: "2px 6px",
        borderRadius: "2px",
      },
      ".cm-v02-toolbar button:hover": { background: "var(--vscode-toolbar-hoverBackground)" },
      ".cm-v02-toolbar button:focus-visible, .cm-v02-toolbar select:focus-visible": {
        outline: "1px solid var(--vscode-focusBorder)",
      },
    }),
  ];
}
