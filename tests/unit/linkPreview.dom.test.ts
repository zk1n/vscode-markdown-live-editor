// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView, activateHover, hasHoverTooltips, keymap } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../src/protocol/messages.js";
import { RichClient } from "../../src/webview/richClient.js";
import { linkPreview } from "../../src/webview/livePreview/linkPreview.js";
import { createFloatingSearch } from "../../src/webview/search/floatingSearch.js";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
};

describe("link preview Escape priority", () => {
  it("closes the hover preview before search or a table Escape keymap", async () => {
    let requests = 0;
    const client = new RichClient((request) => {
      requests++;
      client.receive({
        kind: "rich-response",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///review.md",
        sessionId: "session",
        controllerId: "controller",
        documentVersion: 0,
        requestId: request.requestId,
        ok: true,
        title: "Preview",
        text: "Preview text",
      });
    });
    const search = createFloatingSearch({
      isReady: () => true,
      isEditable: () => true,
      save: () => undefined,
    });
    let tableEscapes = 0;
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "[link](target.md)",
        extensions: [
          search.extension,
          linkPreview({
            client,
            isEditable: () => true,
            synchronize: () => Promise.resolve(true),
            notify: () => undefined,
          }),
          keymap.of([{ key: "Escape", run: () => (++tableEscapes, true) }]),
        ],
      }),
    });
    views.push(view);
    // happy-dom has no rendered text geometry; this test covers Escape ordering.
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 20, right: 28, top: 120, bottom: 140 });
    search.open(view, false);
    view.focus();
    await settle();
    activateHover(view, 2, 1);
    await settle();
    expect(requests).toBe(1);
    expect(hasHoverTooltips(view.state)).toBe(true);

    const first = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(tableEscapes).toBe(0);
    expect(hasHoverTooltips(view.state)).toBe(false);
    expect(document.querySelector(".cm-floating-search")).not.toBeNull();

    const second = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
    expect(document.querySelector(".cm-floating-search")).toBeNull();
    expect(tableEscapes).toBe(0);
  });
});
