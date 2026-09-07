import type { HostToWebviewMessage } from "../../protocol/messages.js";
import type { HostPresentationMessage } from "../../protocol/presentationMessages.js";

export interface DisposableLike {
  dispose(): void;
}

export interface MarkdownEditorSessionHandle {
  readonly documentUri: string;
  readonly sessionId: string;
  readonly reveal: () => void;
  readonly postMessage: (message: HostToWebviewMessage) => boolean | PromiseLike<boolean>;
  readonly postPresentationMessage?: (
    message: HostPresentationMessage,
  ) => boolean | PromiseLike<boolean>;
}

/** Presentation-only state reported by one Webview controller generation. */
export interface MarkdownEditorStateReport {
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
}

/**
 * The sole status/action authority for the panel that is currently active in
 * VS Code. `handle` supplies the document and session identities.
 */
export interface ActiveStatusSession {
  readonly handle: MarkdownEditorSessionHandle;
  readonly controllerId: string;
  readonly editorState: MarkdownEditorStateReport;
}

interface SessionRecord {
  readonly handle: MarkdownEditorSessionHandle;
  readonly openedOrdinal: number;
  lastActiveOrdinal: number;
  controllerId: string | undefined;
  editorState: MarkdownEditorStateReport | undefined;
}

/** Tracks live custom-editor panels independently from Side Bar focus. */
export class MarkdownEditorSessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Set<() => void>();
  private nextOrdinal = 1;
  private activeSessionId: string | undefined;
  private activePanelSessionId: string | undefined;

  public get activeSession(): MarkdownEditorSessionHandle | undefined {
    return this.activeSessionId === undefined
      ? undefined
      : this.sessions.get(this.activeSessionId)?.handle;
  }

  /**
   * The Live Editor panel in the currently active editor tab. Unlike
   * `activeSession`, this deliberately has no last-active fallback: callers
   * that represent the current editor (rather than a retained session) must
   * become empty after focus moves to another editor.
   */
  public get activeCustomEditorSession(): MarkdownEditorSessionHandle | undefined {
    return this.activePanelSessionId === undefined
      ? undefined
      : this.sessions.get(this.activePanelSessionId)?.handle;
  }

  /**
   * Unlike `activeSession`, this is undefined as soon as no Live Editor panel
   * is active. It never falls back to a merely last-used panel.
   */
  public get activeStatusSession(): ActiveStatusSession | undefined {
    const handle = this.activeCustomEditorSession;
    if (handle === undefined) {
      return undefined;
    }
    const session = this.sessions.get(handle.sessionId);
    if (session?.controllerId === undefined || session.editorState === undefined) {
      return undefined;
    }
    return {
      handle: session.handle,
      controllerId: session.controllerId,
      editorState: session.editorState,
    };
  }

  public register(handle: MarkdownEditorSessionHandle, active: boolean): DisposableLike {
    if (this.sessions.has(handle.sessionId)) {
      throw new Error(`Markdown editor session '${handle.sessionId}' is already registered.`);
    }
    const ordinal = this.nextOrdinal;
    this.nextOrdinal += 1;
    this.sessions.set(handle.sessionId, {
      handle,
      openedOrdinal: ordinal,
      lastActiveOrdinal: active ? ordinal : 0,
      controllerId: undefined,
      editorState: undefined,
    });
    if (active || this.activeSessionId === undefined) {
      this.activeSessionId = handle.sessionId;
    }
    if (active) {
      this.activePanelSessionId = handle.sessionId;
    }
    this.emitChange();

    let disposed = false;
    return {
      dispose: (): void => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.close(handle.sessionId);
      },
    };
  }

  /** @deprecated Prefer `markViewState` so inactive panel events are tracked too. */
  public markActive(sessionId: string): void {
    this.markViewState(sessionId, true);
  }

  /** Records a VS Code custom-editor panel becoming active or inactive. */
  public markViewState(sessionId: string, active: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }

    if (!active) {
      if (this.activePanelSessionId === sessionId) {
        this.activePanelSessionId = undefined;
        this.emitChange();
      }
      return;
    }

    session.lastActiveOrdinal = this.nextOrdinal;
    this.nextOrdinal += 1;
    const outlineActiveChanged = this.activeSessionId !== sessionId;
    const statusActiveChanged = this.activePanelSessionId !== sessionId;
    this.activeSessionId = sessionId;
    this.activePanelSessionId = sessionId;
    if (outlineActiveChanged || statusActiveChanged) {
      this.emitChange();
    }
  }

  /**
   * Binds a new controller generation to a session. A replacement invalidates
   * the old controller's state before it can be exposed to status/actions.
   */
  public replaceController(sessionId: string, controllerId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.controllerId === controllerId) {
      return;
    }
    session.controllerId = controllerId;
    session.editorState = undefined;
    this.emitChange();
  }

  /**
   * Accepts only reports from the currently bound controller and only when
   * their sequence advances. Session identity keeps same-URI split panels
   * independent.
   */
  public reportEditorState(
    sessionId: string,
    controllerId: string,
    report: MarkdownEditorStateReport,
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return false;
    }
    if (
      session.controllerId !== controllerId ||
      report.reportSequence <= (session.editorState?.reportSequence ?? -1)
    ) {
      return false;
    }
    session.editorState = report;
    this.emitChange();
    return true;
  }

  public onDidChange(listener: () => void): DisposableLike {
    this.listeners.add(listener);
    return { dispose: (): void => void this.listeners.delete(listener) };
  }

  private close(sessionId: string): void {
    const wasActive = this.activeSessionId === sessionId;
    const wasActivePanel = this.activePanelSessionId === sessionId;
    if (!this.sessions.delete(sessionId)) {
      return;
    }
    if (wasActive) {
      this.activeSessionId = this.mostRecentSessionId();
    }
    if (wasActivePanel) {
      this.activePanelSessionId = undefined;
    }
    this.emitChange();
  }

  private mostRecentSessionId(): string | undefined {
    let selected: SessionRecord | undefined;
    for (const session of this.sessions.values()) {
      if (
        selected === undefined ||
        session.lastActiveOrdinal > selected.lastActiveOrdinal ||
        (session.lastActiveOrdinal === selected.lastActiveOrdinal &&
          session.openedOrdinal > selected.openedOrdinal)
      ) {
        selected = session;
      }
    }
    return selected?.handle.sessionId;
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
