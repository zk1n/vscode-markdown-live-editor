import { describe, expect, it, vi } from "vitest";

import { MarkdownEditorSessionRegistry } from "../../src/extension/editor/MarkdownEditorSessionRegistry.js";

describe("MarkdownEditorSessionRegistry", () => {
  it("activates the first session by default and updates when active session switches", () => {
    const registry = new MarkdownEditorSessionRegistry();
    const first = createSession("session-1");
    const second = createSession("session-2");

    registry.register(first, false);
    registry.register(second, false);

    expect(registry.activeSession?.sessionId).toBe("session-1");

    registry.markActive("session-2");
    expect(registry.activeSession?.sessionId).toBe("session-2");
  });

  it("falls back to the most recently active session when the active one closes", () => {
    const registry = new MarkdownEditorSessionRegistry();
    const first = createSession("session-1");
    const second = createSession("session-2");
    const third = createSession("session-3");

    registry.register(first, true);
    registry.register(second, false);
    registry.markActive("session-2");
    const thirdDisposable = registry.register(third, true);

    expect(registry.activeSession?.sessionId).toBe("session-3");
    thirdDisposable.dispose();

    expect(registry.activeSession?.sessionId).toBe("session-2");
  });

  it("discards stale sessions and prefers most recently opened among equal lastActive values", () => {
    const registry = new MarkdownEditorSessionRegistry();
    const first = createSession("session-1");
    const second = createSession("session-2");
    const third = createSession("session-3");

    registry.register(first, true);
    registry.register(second, false);
    const thirdDisposable = registry.register(third, false);
    thirdDisposable.dispose();

    expect(registry.activeSession?.sessionId).toBe("session-1");
    registry.register(createSession("session-4"), true);

    registry.register(createSession("session-5"), true);
    registry.markActive("session-4");
    expect(registry.activeSession?.sessionId).toBe("session-4");
  });

  it("notifies listeners on register, active change, and disposal", () => {
    const registry = new MarkdownEditorSessionRegistry();
    const listener = vi.fn();
    const disposable = registry.onDidChange(listener);
    const first = createSession("session-1");
    const second = createSession("session-2");

    registry.register(first, true);
    expect(listener).toHaveBeenCalledTimes(1);

    registry.markActive("session-2");
    expect(listener).toHaveBeenCalledTimes(1);

    const secondDisposable = registry.register(second, false);
    expect(listener).toHaveBeenCalledTimes(2);

    secondDisposable.dispose();
    expect(listener).toHaveBeenCalledTimes(3);

    disposable.dispose();
    registry.markActive("session-1");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("prevents duplicate session registration and ignores marking unknown sessions", () => {
    const registry = new MarkdownEditorSessionRegistry();
    const first = createSession("session-1");

    registry.register(first, true);
    expect(() => registry.register(first, false)).toThrow("already registered");
    expect(registry.activeSession?.sessionId).toBe("session-1");

    registry.markActive("does-not-exist");
    expect(registry.activeSession?.sessionId).toBe("session-1");
  });
});

function createSession(sessionId: string): {
  readonly documentUri: string;
  readonly sessionId: string;
  readonly reveal: () => undefined;
  readonly postMessage: () => true;
} {
  return {
    documentUri: "file:///note.md",
    sessionId,
    reveal: () => undefined,
    postMessage: () => true,
  };
}
