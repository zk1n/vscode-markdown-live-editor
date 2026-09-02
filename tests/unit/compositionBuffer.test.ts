import { describe, expect, it } from "vitest";

import { CompositionBuffer } from "../../src/webview/compositionBuffer.js";

describe("CompositionBuffer", () => {
  it("turns multiple preedit updates into one final commit", () => {
    const buffer = new CompositionBuffer();
    buffer.begin(10, "abc");
    buffer.update("abck");
    buffer.update("abcka");
    buffer.update("abcか");

    expect(buffer.finish("abcか")).toEqual({
      baseDocumentVersion: 10,
      baseText: "abc",
      finalText: "abcか",
    });
    expect(buffer.isActive).toBe(false);
  });

  it("keeps sequential compositions as separate persistent commit candidates", () => {
    const buffer = new CompositionBuffer();
    buffer.begin(3, "");
    buffer.update("かき");
    const first = buffer.finish("かき");

    buffer.begin(4, "かき");
    buffer.update("かきくけ");
    const second = buffer.finish("かきくけ");

    expect(first).toMatchObject({ baseText: "", finalText: "かき" });
    expect(second).toMatchObject({ baseText: "かき", finalText: "かきくけ" });
  });

  it("can abandon a composition when recovery is required", () => {
    const buffer = new CompositionBuffer();
    buffer.begin(7, "authoritative");
    buffer.update("authoritative local preedit");
    buffer.abandon();

    expect(buffer.isActive).toBe(false);
    expect(buffer.finish("authoritative local preedit")).toBeUndefined();
  });
});
