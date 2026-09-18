/** Presentation only; these values never change Markdown or its history. */
export interface EditorPreferences {
  readonly wordWrap: boolean;
  readonly lineNumbers: boolean;
  readonly minimapEnabled: boolean;
  readonly minimapSlider: "mouseover" | "always";
  readonly tableMinWidth: number;
  readonly tableMaxWidth: number;
  readonly tableBandSize: number;
  readonly compactSpacing: boolean;
  readonly structuralGap: number;
  readonly linkHoverDelay: number;
  readonly imageKeepHeight: boolean;
}
export const defaultEditorPreferences: EditorPreferences = {
  wordWrap: true,
  lineNumbers: true,
  minimapEnabled: true,
  minimapSlider: "mouseover",
  tableMinWidth: 4.75,
  tableMaxWidth: 32,
  tableBandSize: 18,
  compactSpacing: true,
  structuralGap: 6,
  linkHoverDelay: 300,
  imageKeepHeight: true,
};
export function normalizeEditorPreferences(value: unknown): EditorPreferences {
  const source = typeof value === "object" && value !== null ? value : {};
  const get = (key: keyof EditorPreferences): unknown => Reflect.get(source, key);
  const flag = (key: keyof EditorPreferences, fallback: boolean): boolean =>
    typeof get(key) === "boolean" ? get(key) === true : fallback;
  const number = (
    key: keyof EditorPreferences,
    min: number,
    max: number,
    fallback: number,
  ): number => {
    const candidate = get(key);
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.min(max, Math.max(min, candidate))
      : fallback;
  };
  const tableMinWidth = number("tableMinWidth", 3, 16, 4.75);
  return {
    wordWrap: flag("wordWrap", true),
    lineNumbers: flag("lineNumbers", true),
    minimapEnabled: flag("minimapEnabled", true),
    minimapSlider: get("minimapSlider") === "always" ? "always" : "mouseover",
    tableMinWidth,
    tableMaxWidth: Math.max(tableMinWidth, number("tableMaxWidth", 8, 100, 32)),
    tableBandSize: number("tableBandSize", 10, 28, 18),
    compactSpacing: flag("compactSpacing", true),
    structuralGap: number("structuralGap", 2, 32, 6),
    linkHoverDelay: number("linkHoverDelay", 100, 2000, 300),
    imageKeepHeight: flag("imageKeepHeight", true),
  };
}
