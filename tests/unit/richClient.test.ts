import { afterEach, describe, expect, it, vi } from "vitest";
import { RichClient } from "../../src/webview/richClient.js";

afterEach(() => vi.useRealTimers());
describe("rich request lifetime", () => {
  it("waits for activation and cancels queued/detached requests without sending", async () => {
    const post = vi.fn();
    const client = new RichClient(post, false);
    const abort = new AbortController();
    const canceled = client.request("image-resolve", { target: "old.png" }, abort.signal);
    abort.abort();
    expect(await canceled).toBeUndefined();
    const current = client.request("image-resolve", { target: "new.png" });
    expect(post).not.toHaveBeenCalled();
    client.activate();
    client.activate();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({ target: "new.png" });
    client.dispose();
    expect(await current).toBeUndefined();
    expect(await client.request("image-resolve", { target: "later.png" })).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("settles missing responses and post failures, clears timers, never retries import", async () => {
    vi.useFakeTimers();
    const post = vi.fn();
    const client = new RichClient(post);
    const read = client.request("image-resolve", { target: "missing.png" });
    const sideEffect = client.request("image-import", { data: "bytes" });
    await vi.advanceTimersByTimeAsync(15000);
    expect(await read).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(2);
    client.dispose();
    expect(await sideEffect).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    const broken = new RichClient(() => {
      throw new Error("post failed");
    });
    expect(await broken.request("image-resolve", { target: "x.png" })).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
