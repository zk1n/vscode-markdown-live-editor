import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type * as VSCode from "vscode";
import { PROTOCOL_VERSION } from "../../src/protocol/messages.js";
import type { SaveAsImageRequest } from "../../src/protocol/saveAsImageMessages.js";
const fake = vi.hoisted(() => {
  class Position {
    public constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Selection {
    public constructor(
      public anchor: Position,
      public active: Position,
    ) {}
  }
  const state = {
    editor: undefined as unknown,
    saved: undefined as unknown,
    saveResult: undefined as unknown,
    trusted: true,
  };
  const commands = { executeCommand: vi.fn(() => Promise.resolve()) };
  const window = {
    get activeTextEditor(): unknown {
      return state.editor;
    },
    showTextDocument: vi.fn((document: unknown, options: { selection: unknown }) => {
      const editor = { document, selection: options.selection, viewColumn: 1 };
      state.editor = editor;
      return Promise.resolve(editor);
    }),
    setStatusBarMessage: vi.fn(),
  };
  const workspace = {
    get isTrusted(): boolean {
      return state.trusted;
    },
    saveAs: vi.fn(() => Promise.resolve(state.saveResult)),
    openTextDocument: vi.fn(() => Promise.resolve(state.saved)),
  };
  return { Position, Selection, state, commands, window, workspace };
});
vi.mock("vscode", () => ({ ...fake, ViewColumn: { One: 1, Active: -1 } }));
import {
  NativeSearchBridge,
  protocolPosition,
} from "../../src/extension/editor/NativeSearchBridge.js";
import { SaveAsImageBridge } from "../../src/extension/editor/SaveAsImageBridge.js";

function doc(uri: string, text: string, untitled = false): VSCode.TextDocument {
  return {
    uri: { toString: () => uri, scheme: untitled ? "untitled" : "file" },
    version: 1,
    isUntitled: untitled,
    isClosed: false,
    languageId: "markdown",
    getText: () => text,
    lineAt: (line: number) => ({ text: text.split(/\r?\n/u)[line] ?? "" }),
  } as unknown as VSCode.TextDocument;
}
function panel(): {
  value: VSCode.WebviewPanel;
  postMessage: Mock<() => Promise<boolean>>;
  reveal: Mock;
} {
  const postMessage = vi.fn(() => Promise.resolve(true));
  const reveal = vi.fn();
  const value = {
    active: true,
    viewColumn: 1,
    webview: { postMessage },
    reveal,
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as VSCode.WebviewPanel;
  return { value, postMessage, reveal };
}
function request(uri = "untitled:Untitled-1"): SaveAsImageRequest {
  return {
    kind: "save-as-image",
    protocolVersion: PROTOCOL_VERSION,
    documentUri: uri,
    sessionId: "s",
    controllerId: "c",
    documentVersion: 1,
    anchor: 2,
    head: 2,
    name: "image.png",
    data: "iVBORw0KGgo=",
  };
}
const report = {
  reportSequence: 1,
  documentVersion: 1,
  selectionAnchor: 2,
  selectionHead: 2,
  line: 1,
  column: 3,
  focused: true,
  composing: false,
  recoveryActive: false,
  barrierActive: false,
  insertSpaces: true,
  tabSize: 4,
};
beforeEach(() => {
  vi.clearAllMocks();
  fake.state.editor = undefined;
  fake.state.saved = undefined;
  fake.state.saveResult = undefined;
  fake.state.trusted = true;
});

describe("native Search bridge", () => {
  it("maps LF protocol offsets over CRLF and searches the same dirty document in the same group", async () => {
    const document = doc("file:///sample.md", "日本\r\n本文");
    const webview = panel();
    expect(protocolPosition(document, 4)).toEqual(new fake.Position(1, 1));
    const bridge = new NativeSearchBridge();
    const session = bridge.register(document, webview.value, "s");
    session.ready("c");
    await session.search({
      ...request(document.uri.toString()),
      kind: "native-search",
      mode: "replace",
      anchor: 3,
      head: 5,
    });
    expect(fake.window.showTextDocument).toHaveBeenCalledWith(
      document,
      expect.objectContaining({ viewColumn: 1, preview: false }),
    );
    expect(fake.commands.executeCommand).toHaveBeenCalledWith(
      "editor.action.startFindReplaceAction",
    );
    await bridge.returnToLive();
    expect(webview.reveal).toHaveBeenCalledWith(1, false);
    session.report(report);
    expect(webview.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "native-search-return", anchor: 3, head: 5 }),
    );
  });
  it("does not open Find on stale or inactive document identity and releases the transition", async () => {
    const document = doc("file:///sample.md", "text");
    const webview = panel();
    const bridge = new NativeSearchBridge();
    const session = bridge.register(document, webview.value, "s");
    session.ready("c");
    await session.search({
      ...request(document.uri.toString()),
      kind: "native-search",
      mode: "find",
      documentVersion: 9,
    });
    expect(fake.window.showTextDocument).not.toHaveBeenCalled();
    expect(fake.commands.executeCommand).not.toHaveBeenCalled();
    expect(webview.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "native-search-finished",
        note: "文書の状態が変わったため検索への移動を取り消しました。",
      }),
    );
  });
});
describe("untitled image Save As bridge", () => {
  it("cancel does not replay an image and releases the original view", async () => {
    const bridge = new SaveAsImageBridge();
    const view = panel();
    const session = bridge.register(doc("untitled:Untitled-1", "本文", true), view.value, "s");
    session.ready("c");
    await session.receive(request());
    expect(fake.workspace.saveAs).toHaveBeenCalledTimes(1);
    expect(fake.commands.executeCommand).not.toHaveBeenCalled();
    expect(view.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "image-save-as-finished",
        note: "保存を取り消しました。画像は挿入していません。",
      }),
    );
  });
  it("replays exactly once only after the saved identity reports matching source/version", async () => {
    const bridge = new SaveAsImageBridge();
    const initial = bridge.register(doc("untitled:Untitled-1", "本文", true), panel().value, "s");
    initial.ready("c");
    const saved = doc("file:///outside/saved.md", "本文");
    fake.state.saved = saved;
    fake.state.saveResult = saved.uri;
    const view = panel();
    const continuation = bridge.register(saved, view.value, "saved");
    continuation.ready("new");
    await initial.receive(request());
    expect(view.postMessage).not.toHaveBeenCalled();
    continuation.report(report);
    continuation.report(report);
    expect(view.postMessage).toHaveBeenCalledTimes(1);
    expect(view.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "saved-image-continuation",
        documentUri: saved.uri.toString(),
        controllerId: "new",
        anchor: 2,
        data: request().data,
      }),
    );
  });
  it("rejects changed save output, stale requests and Restricted Mode without creating attachments", async () => {
    const bridge = new SaveAsImageBridge();
    const view = panel();
    const initial = bridge.register(doc("untitled:Untitled-1", "本文", true), view.value, "s");
    initial.ready("c");
    fake.state.saved = doc("file:///saved.md", "changed");
    fake.state.saveResult = (fake.state.saved as VSCode.TextDocument).uri;
    await initial.receive(request());
    expect(fake.commands.executeCommand).not.toHaveBeenCalled();
    fake.workspace.saveAs.mockClear();
    fake.state.trusted = false;
    await initial.receive(request());
    expect(fake.workspace.saveAs).not.toHaveBeenCalled();
    await initial.receive({ ...request(), documentVersion: 3 });
    expect(view.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "image-save-as-finished" }),
    );
  });
  it("releases a concurrent source and cancels continuation when its saved session closes", async () => {
    let finish: ((uri: unknown) => void) | undefined;
    fake.workspace.saveAs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const bridge = new SaveAsImageBridge();
    const first = bridge.register(doc("untitled:Untitled-1", "本文", true), panel().value, "s");
    first.ready("c");
    const running = first.receive(request());
    const laterPanel = panel();
    const later = bridge.register(doc("untitled:Untitled-2", "本文", true), laterPanel.value, "s");
    later.ready("c");
    await later.receive(request("untitled:Untitled-2"));
    expect(laterPanel.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "image-save-as-finished" }),
    );
    const saved = doc("file:///saved.md", "本文");
    fake.state.saved = saved;
    const savedPanel = panel();
    const target = bridge.register(saved, savedPanel.value, "saved");
    target.ready("new");
    finish?.(saved.uri);
    await running;
    target.dispose();
    const reopenedPanel = panel();
    const reopened = bridge.register(saved, reopenedPanel.value, "reopened");
    reopened.ready("again");
    reopened.report(report);
    expect(reopenedPanel.postMessage).not.toHaveBeenCalled();
  });
});
