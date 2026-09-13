import { StateEffect, StateField } from "@codemirror/state";

/** Presentation only. Search may reveal hidden source without enabling raw editing. */
export const revealSearchMatch = StateEffect.define<{ from: number; to: number } | undefined>();
export const searchReveal = StateField.define<{ from: number; to: number } | undefined>({
  create: () => undefined,
  update(value, transaction) {
    let next = transaction.docChanged ? undefined : value;
    for (const effect of transaction.effects) if (effect.is(revealSearchMatch)) next = effect.value;
    return next;
  },
});
