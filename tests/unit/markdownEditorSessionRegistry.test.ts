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

    registry.markViewState("session-2", true);
    expect(registry.activeSession?.sessionId).toBe("session-2");
  });

  it("falls back to the most recently active session when the active one closes", () => {
    const registry = new MarkdownEditorSessionRegistry();
    const first = createSession("session-1");
    const second = createSession("session-2");
    const third = createSession("session-3");

    registry.register(first, true);
    registry.register(second, false);
    registry.markViewState("session-2", true);
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
    registry.markViewState("session-4", true);
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

    registry.markViewState("session-2", true);
    expect(listener).toHaveBeenCalledTimes(1);

    const secondDisposable = registry.register(second, false);
    expect(listener).toHaveBeenCalledTimes(2);

    secondDisposable.dispose();
    expect(listener).toHaveBeenCalledTimes(3);

    disposable.dispose();
    registry.markViewState("session-1", true);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("prevents duplicate session registration and ignores marking unknown sessions", () => {
    const registry = new MarkdownEditorSessionRegistry();
    const first = createSession("session-1");

    registry.register(first, true);
    expect(() => registry.register(first, false)).toThrow("already registered");
    expect(registry.activeSession?.sessionId).toBe("session-1");

    registry.markViewState("does-not-exist", true);
    expect(registry.activeSession?.sessionId).toBe("session-1");
  });

  it("keeps status authority only while a Live Editor panel is active", () => {
    const registry = new MarkdownEditorSessionRegistry();
    registry.register(createSession("session-1"), true);

    registry.replaceController("session-1", "controller-1");
    expect(registry.activeStatusSession).toBeUndefined();

    expect(registry.reportEditorState("session-1", "controller-1", editorState(1))).toBe(true);
    expect(registry.activeStatusSession).toMatchObject({
      handle: { documentUri: "file:///note.md", sessionId: "session-1" },
      controllerId: "controller-1",
      editorState: { reportSequence: 1 },
    });

    registry.markViewState("session-1", false);
    expect(registry.activeStatusSession).toBeUndefined();
    expect(registry.activeCustomEditorSession).toBeUndefined();
    expect(registry.activeSession?.sessionId).toBe("session-1");
  });

  it("keeps last-active session separate from the current custom-editor tab", () => {
    const registry = new MarkdownEditorSessionRegistry();
    registry.register(createSession("session-1"), true);

    // Switching to normal Markdown, Preview, a non-Markdown editor, or Welcome
    // makes the current Custom Editor absent. Side Bar/Chat focus does not emit
    // this transition, so the current panel remains available in that case.
    expect(registry.activeCustomEditorSession?.sessionId).toBe("session-1");
    expect(registry.activeSession?.sessionId).toBe("session-1");
    registry.markViewState("session-1", false);
    expect(registry.activeCustomEditorSession).toBeUndefined();
    expect(registry.activeSession?.sessionId).toBe("session-1");
  });

  it("ignores inactive notifications from panels that are not currently active", () => {
    const registry = new MarkdownEditorSessionRegistry();
    registry.register(createSession("session-1"), true);
    registry.register(createSession("session-2"), false);

    // An inactive panel may report false without changing the current panel.
    registry.markViewState("session-2", false);
    expect(registry.activeCustomEditorSession?.sessionId).toBe("session-1");

    // VS Code may deliver A=false after B=true during a split switch. The
    // delayed notification for A must not clear B's current-panel authority.
    registry.markViewState("session-2", true);
    registry.markViewState("session-1", false);
    expect(registry.activeCustomEditorSession?.sessionId).toBe("session-2");
  });

  it("clears state when a controller is replaced and rejects stale reports", () => {
    const registry = new MarkdownEditorSessionRegistry();
    registry.register(createSession("session-1"), true);
    registry.replaceController("session-1", "controller-1");
    expect(registry.reportEditorState("session-1", "controller-1", editorState(4))).toBe(true);
    expect(registry.reportEditorState("session-1", "controller-1", editorState(4))).toBe(false);
    expect(registry.reportEditorState("session-1", "controller-1", editorState(3))).toBe(false);

    registry.replaceController("session-1", "controller-2");
    expect(registry.activeStatusSession).toBeUndefined();
    expect(registry.reportEditorState("session-1", "controller-1", editorState(5))).toBe(false);
    expect(registry.reportEditorState("session-1", "controller-2", editorState(1))).toBe(true);
    expect(registry.activeStatusSession?.editorState.reportSequence).toBe(1);
  });

  it("keeps same-URI split panels independent and never closes into inactive status authority", () => {
    const registry = new MarkdownEditorSessionRegistry();
    const first = registry.register(createSession("session-1"), true);
    registry.replaceController("session-1", "controller-1");
    registry.reportEditorState("session-1", "controller-1", editorState(1));

    const second = registry.register(createSession("session-2"), false);
    registry.replaceController("session-2", "controller-2");
    registry.reportEditorState("session-2", "controller-2", editorState(9));
    expect(registry.activeStatusSession?.handle.sessionId).toBe("session-1");

    registry.markViewState("session-2", true);
    expect(registry.activeStatusSession?.handle.sessionId).toBe("session-2");
    expect(registry.activeStatusSession?.editorState.reportSequence).toBe(9);

    registry.markViewState("session-2", false);
    expect(registry.activeStatusSession).toBeUndefined();
    second.dispose();
    expect(registry.activeSession?.sessionId).toBe("session-1");
    expect(registry.activeStatusSession).toBeUndefined();
    first.dispose();
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

function editorState(reportSequence: number): {
  readonly reportSequence: number;
  readonly documentVersion: number;
  readonly selectionAnchor: number;
  readonly selectionHead: number;
  readonly line: number;
  readonly column: number;
  readonly focused: boolean;
  readonly composing: boolean;
  readonly recoveryActive: boolean;
  readonly barrierActive: boolean;
  readonly insertSpaces: boolean;
  readonly tabSize: number;
} {
  return {
    reportSequence,
    documentVersion: 7,
    selectionAnchor: 3,
    selectionHead: 3,
    line: 1,
    column: 2,
    focused: true,
    composing: false,
    recoveryActive: false,
    barrierActive: false,
    insertSpaces: true,
    tabSize: 2,
  };
}
