import { Facet } from "@codemirror/state";
import { defaultEditorPreferences, type EditorPreferences } from "../protocol/editorPreferences.js";
export const editorPreferences = Facet.define<EditorPreferences, EditorPreferences>({
  combine: (values) => values.at(-1) ?? defaultEditorPreferences,
});
