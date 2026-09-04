import type { HostToWebviewMessage } from "../../protocol/messages.js";

export interface DisposableLike {
  dispose(): void;
}

export interface MarkdownEditorSessionHandle {
  readonly documentUri: string;
  readonly sessionId: string;
  readonly reveal: () => void;
  readonly postMessage: (message: HostToWebviewMessage) => boolean | PromiseLike<boolean>;
}

interface SessionRecord {
  readonly handle: MarkdownEditorSessionHandle;
  readonly openedOrdinal: number;
  lastActiveOrdinal: number;
}

/** Tracks live custom-editor panels independently from Side Bar focus. */
export class MarkdownEditorSessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Set<() => void>();
  private nextOrdinal = 1;
  private activeSessionId: string | undefined;

  public get activeSession(): MarkdownEditorSessionHandle | undefined {
    return this.activeSessionId === undefined
      ? undefined
      : this.sessions.get(this.activeSessionId)?.handle;
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
    });
    if (active || this.activeSessionId === undefined) {
      this.activeSessionId = handle.sessionId;
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

  public markActive(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    session.lastActiveOrdinal = this.nextOrdinal;
    this.nextOrdinal += 1;
    if (this.activeSessionId !== sessionId) {
      this.activeSessionId = sessionId;
      this.emitChange();
    }
  }

  public onDidChange(listener: () => void): DisposableLike {
    this.listeners.add(listener);
    return { dispose: (): void => void this.listeners.delete(listener) };
  }

  private close(sessionId: string): void {
    const wasActive = this.activeSessionId === sessionId;
    if (!this.sessions.delete(sessionId)) {
      return;
    }
    if (wasActive) {
      this.activeSessionId = this.mostRecentSessionId();
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
