import type { KeyBinding } from "@codemirror/view";

import type { BarrierAction } from "./barrierInputGate.js";

/**
 * The webview owns these four physical shortcut routes. A handled binding must
 * not bubble into the VS Code webview wrapper, which independently forwards
 * trusted key events to the workbench keybinding service.
 */
export function createBarrierKeymap(
  requestBarrier: (action: BarrierAction) => void,
): readonly KeyBinding[] {
  const request =
    (action: BarrierAction): (() => boolean) =>
    () => {
      requestBarrier(action);
      return true;
    };
  return [
    { key: "Mod-s", preventDefault: true, stopPropagation: true, run: request("save") },
    { key: "Mod-z", preventDefault: true, stopPropagation: true, run: request("undo") },
    { key: "Mod-y", preventDefault: true, stopPropagation: true, run: request("redo") },
    { key: "Mod-Shift-z", preventDefault: true, stopPropagation: true, run: request("redo") },
  ];
}
