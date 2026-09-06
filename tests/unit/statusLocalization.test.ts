import { describe, expect, it } from "vitest";

import type { Localizer } from "../../src/extension/localization.js";

describe("status localization boundary", () => {
  it("keeps placeholders available to the localized runtime message", () => {
    const localizer: Localizer = {
      t(message: string, ...arguments_: readonly (string | number)[]): string {
        return `${message}:${arguments_.join(",")}`;
      },
    };

    expect(localizer.t("Ln {0}, Col {1}{2}", 4, 7, "（3 文字を選択）")).toBe(
      "Ln {0}, Col {1}{2}:4,7,（3 文字を選択）",
    );
  });
});
