import { describe, expect, it } from "vitest";

import { PendingEditQueue } from "../../src/webview/pendingEditQueue.js";

describe("PendingEditQueue", () => {
  it("retains a pending-only exact target until the controller takes it in flight", () => {
    const queue = new PendingEditQueue("- ");

    queue.queue("- a");

    expect(queue.hasPending).toBe(true);
    expect(queue.hasInFlight).toBe(false);
    expect(queue.pendingTarget).toBe("- a");
    expect(queue.inFlightTarget).toBeUndefined();

    expect(queue.takeNext()).toBe("- a");
    expect(queue.hasPending).toBe(false);
    expect(queue.hasInFlight).toBe(true);
    expect(queue.inFlightTarget).toBe("- a");
  });
});
