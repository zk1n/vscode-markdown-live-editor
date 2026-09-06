import { describe, expect, it } from "vitest";

import {
  MarkdownEditorStatusBarManager,
  type ActiveStatusSessionIdentity,
  type StatusActionCallbacks,
  type StatusBarEol,
  type StatusBarItemFactory,
  type StatusBarItemLike,
  type StatusCommandRegistry,
  type StatusDocumentPresentationReader,
} from "../../src/extension/status/MarkdownEditorStatusBarManager.js";
import { MarkdownEditorSessionRegistry } from "../../src/extension/editor/MarkdownEditorSessionRegistry.js";

describe("MarkdownEditorStatusBarManager", () => {
  it("renders status from the strict active controller session", () => {
    const registry = readyRegistry("session-1", "controller-1", editorState());
    const items = new RecordingStatusBarItems();
    const commands = new RecordingCommands();
    const manager = new MarkdownEditorStatusBarManager(
      registry,
      new RecordingPresentation(),
      completeActions(),
      items,
      commands,
    );

    expect(items.item("lineColumn")).toMatchObject({ text: "Ln 4, Col 7 (3 selected)" });
    expect(items.item("indentation")).toMatchObject({ text: "Spaces: 2" });
    expect(items.item("encoding")).toMatchObject({ text: "UTF-8" });
    expect(items.item("eol")).toMatchObject({ text: "CRLF" });
    expect(items.item("language")).toMatchObject({ text: "Markdown" });
    expect(items.item("eol").command).toBe("vscodeMarkdownLiveEditor.status.changeEol");
    expect(items.item("indentation").command).toBe(
      "vscodeMarkdownLiveEditor.status.changeIndentation",
    );
    expect(items.item("encoding").command).toBeUndefined();
    expect(items.item("encoding").tooltip).toContain("not inferred from document bytes");

    manager.dispose();
    expect(items.all.every((item) => item.disposed)).toBe(true);
  });

  it("hides for inactive panels, controller replacement, and a same-URI split until that split reports", () => {
    const registry = readyRegistry("session-1", "controller-1", editorState());
    const items = new RecordingStatusBarItems();
    const manager = new MarkdownEditorStatusBarManager(
      registry,
      new RecordingPresentation(),
      {},
      items,
      new RecordingCommands(),
    );
    const second = registry.register(session("session-2"), false);
    registry.replaceController("session-2", "controller-2");
    registry.markViewState("session-2", true);

    expect(items.all.every((item) => !item.visible)).toBe(true);
    expect(registry.reportEditorState("session-2", "controller-1", editorState())).toBe(false);
    expect(
      registry.reportEditorState("session-2", "controller-2", editorState({ reportSequence: 2 })),
    ).toBe(true);
    expect(items.item("lineColumn").visible).toBe(true);

    registry.replaceController("session-2", "controller-3");
    expect(items.all.every((item) => !item.visible)).toBe(true);
    registry.markViewState("session-2", false);
    expect(items.all.every((item) => !item.visible)).toBe(true);

    second.dispose();
    manager.dispose();
  });

  it("revalidates identity after an awaited EOL choice and does not mutate a stale panel", async () => {
    const registry = readyRegistry("session-1", "controller-1", editorState());
    const items = new RecordingStatusBarItems();
    const commands = new RecordingCommands();
    let resolveChoice: ((value: StatusBarEol | undefined) => void) | undefined;
    const requests: ActiveStatusSessionIdentity[] = [];
    const manager = new MarkdownEditorStatusBarManager(
      registry,
      new RecordingPresentation(),
      {
        chooseEol: async () =>
          await new Promise<StatusBarEol | undefined>((resolve): void => {
            resolveChoice = resolve;
          }),
        requestEolChange: (context): void => {
          requests.push(context.identity);
        },
      },
      items,
      commands,
    );

    const action = commands.run("vscodeMarkdownLiveEditor.status.changeEol");
    registry.markViewState("session-1", false);
    resolveChoice?.("lf");
    await action;

    expect(requests).toEqual([]);
    expect(items.all.every((item) => !item.visible)).toBe(true);
    manager.dispose();
  });

  it("permits an awaited indentation change only for the same identity and document version", async () => {
    const registry = readyRegistry("session-1", "controller-1", editorState());
    const commands = new RecordingCommands();
    const requests: { readonly tabSize: number }[] = [];
    const manager = new MarkdownEditorStatusBarManager(
      registry,
      new RecordingPresentation(),
      {
        chooseIndentation: () => Promise.resolve({ insertSpaces: false, tabSize: 4 }),
        requestIndentationChange: (_context, target): void => {
          requests.push(target);
        },
      },
      new RecordingStatusBarItems(),
      commands,
    );

    await commands.run("vscodeMarkdownLiveEditor.status.changeIndentation");
    expect(requests).toEqual([{ insertSpaces: false, tabSize: 4 }]);

    registry.reportEditorState(
      "session-1",
      "controller-1",
      editorState({ reportSequence: 2, documentVersion: 8 }),
    );
    expect(
      manager.isCurrent({
        identity: {
          documentUri: "file:///note.md",
          sessionId: "session-1",
          controllerId: "controller-1",
        },
        documentVersion: 7,
        editorState: editorState(),
      }),
    ).toBe(false);
    manager.dispose();
  });

  it("keeps display information visible but disables mutation actions in recovery", () => {
    const registry = readyRegistry(
      "session-1",
      "controller-1",
      editorState({ recoveryActive: true }),
    );
    const items = new RecordingStatusBarItems();
    const manager = new MarkdownEditorStatusBarManager(
      registry,
      new RecordingPresentation(),
      completeActions(),
      items,
      new RecordingCommands(),
    );

    expect(items.item("lineColumn").visible).toBe(true);
    expect(items.item("eol").command).toBeUndefined();
    expect(items.item("indentation").command).toBeUndefined();
    manager.dispose();
  });

  it("hides stale Webview state until it matches the authoritative TextDocument version", () => {
    const registry = readyRegistry("session-1", "controller-1", editorState());
    const items = new RecordingStatusBarItems();
    const presentation = new RecordingPresentation(8);
    const manager = new MarkdownEditorStatusBarManager(
      registry,
      presentation,
      completeActions(),
      items,
      new RecordingCommands(),
    );

    expect(items.all.every((item) => !item.visible)).toBe(true);
    registry.reportEditorState(
      "session-1",
      "controller-1",
      editorState({ reportSequence: 2, documentVersion: 8 }),
    );
    expect(items.item("lineColumn").visible).toBe(true);
    manager.dispose();
  });
});

function readyRegistry(
  sessionId: string,
  controllerId: string,
  state: ReturnType<typeof editorState>,
): MarkdownEditorSessionRegistry {
  const registry = new MarkdownEditorSessionRegistry();
  registry.register(session(sessionId), true);
  registry.replaceController(sessionId, controllerId);
  expect(registry.reportEditorState(sessionId, controllerId, state)).toBe(true);
  return registry;
}

function session(sessionId: string): {
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

function editorState(
  overrides: Partial<{
    readonly reportSequence: number;
    readonly documentVersion: number;
    readonly recoveryActive: boolean;
  }> = {},
): {
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
    reportSequence: overrides.reportSequence ?? 1,
    documentVersion: overrides.documentVersion ?? 7,
    selectionAnchor: 3,
    selectionHead: 6,
    line: 4,
    column: 7,
    focused: true,
    composing: false,
    recoveryActive: overrides.recoveryActive ?? false,
    barrierActive: false,
    insertSpaces: true,
    tabSize: 2,
  };
}

function completeActions(): StatusActionCallbacks {
  return {
    chooseEol: () => Promise.resolve("lf"),
    requestEolChange: (): void => undefined,
    chooseIndentation: () => Promise.resolve({ insertSpaces: true, tabSize: 2 }),
    requestIndentationChange: (): void => undefined,
  };
}

class RecordingPresentation implements StatusDocumentPresentationReader {
  public constructor(private readonly documentVersion = 7) {}

  public read(
    identity: ActiveStatusSessionIdentity,
  ):
    | { readonly documentVersion: number; readonly eol: "crlf"; readonly encoding: string }
    | undefined {
    return identity.documentUri === "file:///note.md"
      ? { documentVersion: this.documentVersion, eol: "crlf", encoding: "utf8" }
      : undefined;
  }
}

class RecordingStatusBarItems implements StatusBarItemFactory {
  public readonly all: RecordingStatusBarItem[] = [];

  public create(id: string, priority: number): StatusBarItemLike {
    const item = new RecordingStatusBarItem(id, priority);
    this.all.push(item);
    return item;
  }

  public item(suffix: string): RecordingStatusBarItem {
    const item = this.all.find((candidate) => candidate.id.endsWith(suffix));
    if (item === undefined) {
      throw new Error(`No item ending in '${suffix}'.`);
    }
    return item;
  }
}

class RecordingStatusBarItem implements StatusBarItemLike {
  public text = "";
  public tooltip: string | undefined;
  public command: string | undefined;
  public visible = false;
  public disposed = false;

  public constructor(
    public readonly id: string,
    public readonly priority: number,
  ) {}

  public show(): void {
    this.visible = true;
  }

  public hide(): void {
    this.visible = false;
  }

  public dispose(): void {
    this.disposed = true;
  }
}

class RecordingCommands implements StatusCommandRegistry {
  private readonly callbacks = new Map<string, () => Promise<void>>();

  public register(command: string, callback: () => Promise<void>): { dispose(): void } {
    this.callbacks.set(command, callback);
    return { dispose: (): void => void this.callbacks.delete(command) };
  }

  public async run(command: string): Promise<void> {
    const callback = this.callbacks.get(command);
    if (callback === undefined) {
      throw new Error(`No command '${command}'.`);
    }
    await callback();
  }
}
