// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView, activateHover, hasHoverTooltips, keymap } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../src/protocol/messages.js";
import { RichClient } from "../../src/webview/richClient.js";
import { editorPreferences } from "../../src/webview/editorPreferences.js";
import { defaultEditorPreferences } from "../../src/protocol/editorPreferences.js";
import { linkPreview } from "../../src/webview/livePreview/linkPreview.js";
import { createFloatingSearch } from "../../src/webview/search/floatingSearch.js";

const views: EditorView[] = [];
const TARGET_VERSION = "a".repeat(64);
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
};

describe("link preview mouse hover timing", () => {
  const createMouseHover = (
    hoverDelayMs: number,
    respondImmediately = true,
  ): {
    view: EditorView;
    post: (request: { readonly requestId: number }) => void;
    respond: () => void;
    client: RichClient;
  } => {
    let pendingRequestId = 0;
    const respond = (): void => {
      client.receive({
        kind: "rich-response",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///review.md",
        sessionId: "session",
        controllerId: "controller",
        documentVersion: 0,
        requestId: pendingRequestId,
        ok: true,
        title: "Preview",
        text: "Preview text",
      });
    };
    const post = vi.fn((request: { readonly requestId: number }) => {
      pendingRequestId = request.requestId;
      if (respondImmediately) respond();
    });
    const client = new RichClient(post);
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "[link](target.md)",
        extensions: [
          editorPreferences.of({ ...defaultEditorPreferences, linkHoverDelay: hoverDelayMs }),
          linkPreview({
            client,
            isEditable: () => true,
            synchronize: () => Promise.resolve(true),
            notify: () => undefined,
          }),
        ],
      }),
    });
    views.push(view);
    // Supply geometry absent in happy-dom; the event still uses CM's mouse
    // listener, dwell timer and hover source rather than activateHover.
    vi.spyOn(view, "posAtCoords").mockReturnValue(2);
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 20, right: 28, top: 120, bottom: 140 });
    const line = view.contentDOM.querySelector(".cm-line");
    if (line === null) throw new Error("editor line did not render");
    line.dispatchEvent(new MouseEvent("mousemove", { clientX: 24, clientY: 130, bubbles: true }));
    return { view, post, respond, client };
  };

  it.each([100, 300, 1000])(
    "displays after the configured %ims without another 300ms dwell",
    async (delay) => {
      vi.useFakeTimers();
      const { view, post } = createMouseHover(delay);
      await vi.advanceTimersByTimeAsync(5);
      expect(post).toHaveBeenCalledTimes(1);
      expect(hasHoverTooltips(view.state)).toBe(false);
      await vi.advanceTimersByTimeAsync(delay - 6);
      expect(hasHoverTooltips(view.state)).toBe(false);
      await vi.advanceTimersByTimeAsync(6);
      expect(hasHoverTooltips(view.state)).toBe(true);
      expect(document.querySelector(".cm-link-preview-body")?.textContent).toContain(
        "Preview text",
      );
    },
  );

  it("shows loading on time and fills a delayed response before Escape closes it", async () => {
    vi.useFakeTimers();
    const { view, respond } = createMouseHover(100, false);
    await vi.advanceTimersByTimeAsync(105);
    expect(hasHoverTooltips(view.state)).toBe(true);
    expect(document.querySelector(".cm-link-preview-loading")?.textContent).toBe("読み込み中…");
    respond();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector(".cm-link-preview-loading")).toBeNull();
    expect(document.querySelector(".cm-link-preview-body")?.textContent).toContain("Preview text");
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(hasHoverTooltips(view.state)).toBe(false);
    expect(document.querySelector(".cm-link-preview")).toBeNull();
  });

  it("does not revive a preview when a delayed response arrives after disposal", async () => {
    vi.useFakeTimers();
    const { view, respond, client } = createMouseHover(100, false);
    await vi.advanceTimersByTimeAsync(105);
    expect(document.querySelector(".cm-link-preview-loading")).not.toBeNull();
    view.destroy();
    views.splice(views.indexOf(view), 1);
    respond();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector(".cm-link-preview")).toBeNull();
    client.dispose();
  });

  it("does not display after the pointer leaves during the configured delay", async () => {
    vi.useFakeTimers();
    const { view } = createMouseHover(100);
    await vi.advanceTimersByTimeAsync(5);
    view.dom.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: document.body }));
    await vi.advanceTimersByTimeAsync(105);
    expect(hasHoverTooltips(view.state)).toBe(false);
    expect(document.querySelector(".cm-link-preview")).toBeNull();
  });
});

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
          editorPreferences.of({ ...defaultEditorPreferences, linkHoverDelay: 100 }),
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
    await new Promise<void>((resolve) => window.setTimeout(resolve, 110));
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

describe("link preview hover lifecycle", () => {
  it("uses the transparent transit wrapper and discards its cache after a document change", async () => {
    let requests = 0;
    const events: string[] = [];
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
        ...(request.targetVersion === TARGET_VERSION
          ? { unchanged: true, targetVersion: TARGET_VERSION }
          : { title: "Preview", text: "Preview text", targetVersion: TARGET_VERSION }),
      });
    });
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "[link](target.md)",
        extensions: [
          editorPreferences.of({ ...defaultEditorPreferences, linkHoverDelay: 10 }),
          linkPreview({
            client,
            isEditable: () => true,
            synchronize: () => Promise.resolve(true),
            notify: () => undefined,
            onPreviewEvent: (event) => events.push(event),
          }),
        ],
      }),
    });
    views.push(view);
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 20, right: 28, top: 120, bottom: 140 });
    activateHover(view, 2, 1);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
    await settle();
    expect(document.querySelector(".cm-link-preview-transit .cm-link-preview")).not.toBeNull();
    expect(requests).toBe(1);
    expect(events).toContain("display");
    expect(events).toContain("response");

    view.dispatch({ selection: { anchor: 0 } });
    activateHover(view, 2, 1);
    await settle();
    expect(requests).toBe(2);

    view.dispatch({ changes: { from: 0, insert: "x" } });
    activateHover(view, 3, 1);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
    await settle();
    expect(requests).toBe(3);
  });

  it("wraps a long URL/title within the viewport-constrained preview", async () => {
    const longTarget = `https://${"very-long-segment/".repeat(24)}end`;
    const client = new RichClient((request) => {
      client.receive({
        kind: "rich-response",
        protocolVersion: PROTOCOL_VERSION,
        documentUri: "file:///review.md",
        sessionId: "session",
        controllerId: "controller",
        documentVersion: 0,
        requestId: request.requestId,
        ok: true,
        title: longTarget,
        text: longTarget,
      });
    });
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: `[link](${longTarget})`,
        extensions: [
          editorPreferences.of({ ...defaultEditorPreferences, linkHoverDelay: 1 }),
          linkPreview({
            client,
            isEditable: () => true,
            synchronize: () => Promise.resolve(true),
            notify: () => undefined,
          }),
        ],
      }),
    });
    views.push(view);
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 20, right: 28, top: 120, bottom: 140 });
    activateHover(view, 2, 1);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 5));
    await settle();

    const card = document.querySelector<HTMLElement>(".cm-link-preview");
    const title = document.querySelector<HTMLElement>(".cm-link-preview-title");
    expect(card).not.toBeNull();
    expect(title).not.toBeNull();
    if (card === null || title === null) throw new Error("link preview did not render");
    expect(getComputedStyle(card).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(card).maxWidth).toContain("560px");
    expect(getComputedStyle(title).overflowWrap).toBe("anywhere");
  });

  it("removes only the generic tooltip border from the preview transit owner", async () => {
    const client = new RichClient((request) => {
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
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "[link](target.md)",
        extensions: [
          editorPreferences.of({ ...defaultEditorPreferences, linkHoverDelay: 1 }),
          linkPreview({
            client,
            isEditable: () => true,
            synchronize: () => Promise.resolve(true),
            notify: () => undefined,
          }),
        ],
      }),
    });
    views.push(view);
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 20, right: 28, top: 120, bottom: 140 });
    activateHover(view, 2, 1);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 5));
    await settle();

    const transit = document.querySelector<HTMLElement>(".cm-link-preview-transit");
    const card = document.querySelector<HTMLElement>(".cm-link-preview");
    const tooltip = transit?.closest<HTMLElement>(".cm-tooltip");
    expect(tooltip?.classList.contains("cm-link-preview-tooltip")).toBe(true);
    expect(getComputedStyle(tooltip ?? document.body).backgroundColor).toBe("transparent");
    expect(transit?.classList.contains("cm-tooltip-section")).toBe(true);
    expect(card?.classList.contains("cm-link-preview")).toBe(true);
  });
});
