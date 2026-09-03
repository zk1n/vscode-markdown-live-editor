import { describe, expect, it } from "vitest";

import { BarrierInputGate } from "../../src/webview/barrierInputGate.js";
import { CompositionBuffer } from "../../src/webview/compositionBuffer.js";
import { PendingEditQueue } from "../../src/webview/pendingEditQueue.js";

describe("webview IME Save sequence state", () => {
  it("Case A: sends a completed composition before a later Save barrier", () => {
    const edits = new PendingEditQueue("A");
    const composition = new CompositionBuffer();
    const barriers = new BarrierInputGate();

    composition.begin(1, "A");
    composition.update("Aか");
    const commit = composition.finish("Aか");
    expect(commit).toMatchObject({ baseText: "A", finalText: "Aか" });
    edits.queue(commit?.finalText ?? "");
    expect(edits.takeNext()).toBe("Aか");
    edits.acknowledge("Aか");

    barriers.enqueue("save", undefined);
    expect(barriers.nextAction).toBe("save");
  });

  it("Case B: permits only the already-active composition to finish after Save", () => {
    const barriers = new BarrierInputGate();
    barriers.enqueue("save", 4);

    expect(barriers.isFrozen).toBe(true);
    expect(barriers.acceptsLocalTransaction(4)).toBe(true);
    expect(barriers.acceptsLocalTransaction(5)).toBe(false);
    expect(barriers.acceptsLocalTransaction(undefined)).toBe(false);

    barriers.markBarrierSent(7);
    expect(barriers.acknowledgeBarrier(7)).toBe(true);
    expect(barriers.completeIfIdle()).toBe(true);
    expect(barriers.isFrozen).toBe(false);
  });

  it("Case C: flushes a pending ordinary base without leaking composition preedit", () => {
    const edits = new PendingEditQueue("A");
    const composition = new CompositionBuffer();
    const sent: string[] = [];

    edits.queue("AB");
    sent.push(edits.takeNext() ?? "");
    composition.begin(1, "AB");
    // This is the controller's beginComposition path: it queues the captured
    // stable base. It must not queue the mutable current preedit text.
    edits.queue("AB");
    composition.update("ABk");
    composition.update("ABka");
    composition.update("ABか");

    edits.acknowledge("AB");
    const commit = composition.finish("ABか");
    expect(commit).toMatchObject({ baseText: "AB", finalText: "ABか" });
    edits.queue(commit?.finalText ?? "");
    sent.push(edits.takeNext() ?? "");

    expect(sent).toEqual(["AB", "ABか"]);
    expect(sent).not.toContain("ABk");
    expect(sent).not.toContain("ABka");
  });

  it("Case D: repeated immediate Saves each thaw after their acknowledgement", () => {
    const barriers = new BarrierInputGate();

    for (const sequence of [2, 4, 6]) {
      barriers.enqueue("save", undefined);
      barriers.markBarrierSent(sequence);
      expect(barriers.acknowledgeBarrier(sequence)).toBe(true);
      expect(barriers.completeIfIdle()).toBe(true);
      expect(barriers.isFrozen).toBe(false);
    }
  });

  it("Case E: keeps Save queued while a composition final edit acknowledgement is pending", () => {
    const edits = new PendingEditQueue("A");
    const barriers = new BarrierInputGate();

    edits.queue("Aか");
    expect(edits.takeNext()).toBe("Aか");
    barriers.enqueue("save", undefined);

    expect(barriers.nextAction).toBe("save");
    expect(barriers.hasDeterministicProgress(false, edits.hasInFlight)).toBe(true);
    expect(edits.hasInFlight).toBe(true);

    edits.acknowledge("Aか");
    barriers.markBarrierSent(2);
    expect(barriers.acknowledgeBarrier(2)).toBe(true);
    expect(barriers.completeIfIdle()).toBe(true);
    expect(barriers.hasDeterministicProgress(false, false)).toBe(true);
  });

  it("Case F: rejects a frozen queued barrier with no execution path", () => {
    const barriers = new BarrierInputGate();

    barriers.enqueue("save", undefined);

    expect(barriers.isFrozen).toBe(true);
    expect(barriers.queueLength).toBe(1);
    expect(barriers.barrierInFlightSequence).toBeUndefined();
    expect(barriers.hasDeterministicProgress(false, false)).toBe(false);
  });
});
