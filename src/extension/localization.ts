import * as vscode from "vscode";

/** Small injectable boundary around VS Code's runtime localization API. */
export interface Localizer {
  t(message: string, ...arguments_: readonly (string | number)[]): string;
}

export const vscodeLocalizer: Localizer = {
  t(message: string, ...arguments_: readonly (string | number)[]): string {
    const localizer = readRuntimeLocalizer(vscode);
    if (localizer !== undefined) {
      return localizer.t(message, ...arguments_);
    }
    // VS Code exposes l10n at runtime. The unit-test public API double does
    // not, so retain an English fallback without treating the typed API as an
    // optional production contract.
    return message.replace(/\{(\d+)\}/gu, (_whole, index: string): string => {
      const argument = arguments_[Number(index)];
      return argument === undefined ? `{${index}}` : String(argument);
    });
  },
};

function readRuntimeLocalizer(value: unknown): Localizer | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return isLocalizer(value["l10n"]) ? value["l10n"] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocalizer(value: unknown): value is Localizer {
  return isRecord(value) && typeof value["t"] === "function";
}
