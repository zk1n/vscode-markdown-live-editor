import { StateEffect, StateField } from "@codemirror/state";

/** Presentation only. Search may reveal hidden source without enabling raw editing. */
export const revealSearchMatch = StateEffect.define<{ from: number; to: number } | undefined>();
/** A saved editor selection is not an editing intent while the search form owns focus. */
export const setSearchPresentation = StateEffect.define<boolean>();
export const searchPresentation = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setSearchPresentation)) value = effect.value;
    return value;
  },
});
export const searchReveal = StateField.define<{ from: number; to: number } | undefined>({
  create: () => undefined,
  update(value, transaction) {
    let next = transaction.docChanged ? undefined : value;
    for (const effect of transaction.effects) if (effect.is(revealSearchMatch)) next = effect.value;
    return next;
  },
});
