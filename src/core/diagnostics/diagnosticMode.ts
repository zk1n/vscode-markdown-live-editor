export const DIAGNOSTIC_MODES = ["off", "raw-cm6", "markdown", "sync", "preview"] as const;

export type DiagnosticMode = (typeof DIAGNOSTIC_MODES)[number];

export function decodeDiagnosticMode(value: unknown): DiagnosticMode {
  return isDiagnosticMode(value) ? value : "off";
}

export function isDiagnosticMode(value: unknown): value is DiagnosticMode {
  return typeof value === "string" && (DIAGNOSTIC_MODES as readonly string[]).includes(value);
}

export function usesMarkdownLanguage(mode: DiagnosticMode): boolean {
  return mode !== "raw-cm6";
}

export function usesDocumentSync(mode: DiagnosticMode): boolean {
  return mode === "off" || mode === "sync" || mode === "preview";
}

export function usesLivePreview(mode: DiagnosticMode): boolean {
  return mode === "off" || mode === "preview";
}

export function usesBarrierKeymap(mode: DiagnosticMode): boolean {
  return mode === "off" || mode === "preview";
}

export function recordsDiagnosticTrace(mode: DiagnosticMode): boolean {
  return mode !== "off";
}
