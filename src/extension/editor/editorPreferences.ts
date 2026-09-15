import * as vscode from "vscode";
import {
  defaultEditorPreferences,
  normalizeEditorPreferences,
  type EditorPreferences,
} from "../../protocol/editorPreferences.js";

/** Resolves resource/language scoped presentation settings without persisting editor state. */
export function resolveEditorPreferences(document: vscode.TextDocument): EditorPreferences {
  const scope = { uri: document.uri, languageId: document.languageId };
  const own = vscode.workspace.getConfiguration("vscodeMarkdownLiveEditor", scope);
  const editor = vscode.workspace.getConfiguration("editor", scope);
  const wordWrap = own.get<unknown>("wordWrap", "on");
  const minimap = own.get<unknown>("minimapEnabled", "follow");
  return normalizeEditorPreferences({
    wordWrap:
      wordWrap === "follow"
        ? editor.get<unknown>("wordWrap") !== "off"
        : wordWrap === "off"
          ? false
          : true,
    lineNumbers: own.get<unknown>("lineNumbers", defaultEditorPreferences.lineNumbers),
    minimapEnabled:
      minimap === "follow"
        ? editor.get<boolean>("minimap.enabled", true)
        : minimap !== false && minimap !== "off",
    minimapSlider: own.get<unknown>("minimapSlider", defaultEditorPreferences.minimapSlider),
    tableMinWidth: own.get<unknown>("tableMinWidth", defaultEditorPreferences.tableMinWidth),
    tableMaxWidth: own.get<unknown>("tableMaxWidth", defaultEditorPreferences.tableMaxWidth),
    tableBandSize: own.get<unknown>("tableBandSize", defaultEditorPreferences.tableBandSize),
    compactSpacing: own.get<unknown>("compactSpacing", defaultEditorPreferences.compactSpacing),
    structuralGap: own.get<unknown>("structuralGap", defaultEditorPreferences.structuralGap),
    linkHoverDelay: own.get<unknown>("linkHoverDelay", defaultEditorPreferences.linkHoverDelay),
    imageKeepHeight: own.get<unknown>("imageKeepHeight", defaultEditorPreferences.imageKeepHeight),
  });
}
