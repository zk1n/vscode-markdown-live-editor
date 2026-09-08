import { describe, expect, it, vi } from "vitest";

import {
  CustomCssSession,
  type CustomCssSnapshot,
  type CustomCssDisposable,
  type CustomCssHost,
  type CustomCssUri,
  type CustomCssWatcher,
} from "../../src/extension/styles/customCss.js";

describe("CustomCssSession", () => {
  it("reloads for create/change/delete with monotonically increasing revisions and disposes listeners", async () => {
    const host = new SessionHost();
    const updates: string[] = [];
    const session = new CustomCssSession(host, {
      documentUri: uri("file:///workspace/note.md"),
      getUserCss: (): string => ".user {}",
      onDidUpdate: (snapshot): void => {
        updates.push(`${String(snapshot.revision)}:${snapshot.css}`);
      },
    });

    await session.start();
    host.file = ".created {}";
    await host.watcher.fireCreate();
    host.file = ".changed {}";
    await host.watcher.fireChange();
    host.file = undefined;
    await host.watcher.fireDelete();
    session.dispose();
    await host.watcher.fireChange();

    expect(updates).toEqual([
      "1:.user {}",
      "2:.created {}\n.user {}",
      "3:.changed {}\n.user {}",
      "4:.user {}",
    ]);
    expect(host.watcher.disposed).toBe(true);
  });

  it("rejects a stale asynchronous read and post-disposal completion", async () => {
    const host = new SessionHost();
    const updates = vi.fn<(snapshot: CustomCssSnapshot) => void>();
    const session = new CustomCssSession(host, {
      documentUri: uri("file:///workspace/note.md"),
      getUserCss: (): undefined => undefined,
      onDidUpdate: updates,
    });
    const first = host.deferNextRead();
    const pendingFirst = session.reload();
    const second = session.reload();
    first.resolve(bytes(".stale {}"));
    await pendingFirst;
    await second;
    expect(updates).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls[0]?.[0].css).toBe("");

    const finalRead = host.deferNextRead();
    const pendingFinal = session.reload();
    session.dispose();
    finalRead.resolve(bytes(".after-dispose {}"));
    await pendingFinal;
    expect(updates).toHaveBeenCalledTimes(1);
  });
});

function uri(value: string): CustomCssUri {
  return { scheme: "file", toString: (): string => value };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

class NotFoundError extends Error {}

class DeferredRead {
  private resolveRead: ((value: Uint8Array) => void) | undefined;
  public readonly promise = new Promise<Uint8Array>((resolve): void => {
    this.resolveRead = resolve;
  });

  public resolve(value: Uint8Array): void {
    this.resolveRead?.(value);
  }
}

class SessionWatcher implements CustomCssWatcher {
  private readonly changeListeners = new Set<() => void>();
  private readonly createListeners = new Set<() => void>();
  private readonly deleteListeners = new Set<() => void>();
  public disposed = false;

  public readonly onDidChange = (listener: () => void): CustomCssDisposable =>
    this.add(this.changeListeners, listener);
  public readonly onDidCreate = (listener: () => void): CustomCssDisposable =>
    this.add(this.createListeners, listener);
  public readonly onDidDelete = (listener: () => void): CustomCssDisposable =>
    this.add(this.deleteListeners, listener);

  public async fireChange(): Promise<void> {
    await this.fire(this.changeListeners);
  }

  public async fireCreate(): Promise<void> {
    await this.fire(this.createListeners);
  }

  public async fireDelete(): Promise<void> {
    await this.fire(this.deleteListeners);
  }

  public dispose(): void {
    this.disposed = true;
    this.changeListeners.clear();
    this.createListeners.clear();
    this.deleteListeners.clear();
  }

  private add(listeners: Set<() => void>, listener: () => void): CustomCssDisposable {
    listeners.add(listener);
    return { dispose: (): void => void listeners.delete(listener) };
  }

  private async fire(listeners: ReadonlySet<() => void>): Promise<void> {
    for (const listener of listeners) {
      listener();
    }
    await Promise.resolve();
    await Promise.resolve();
  }
}

class SessionHost implements CustomCssHost {
  public file: string | undefined;
  public readonly watcher = new SessionWatcher();
  private nextDeferred: DeferredRead | undefined;

  public readonly isWorkspaceTrusted = (): boolean => true;
  public readonly getWorkspaceFolder = (): { readonly uri: CustomCssUri } => ({
    uri: uri("file:///workspace"),
  });
  public readonly joinPath = (base: CustomCssUri, ...segments: readonly string[]): CustomCssUri =>
    uri(`${base.toString()}/${segments.join("/")}`);
  public readonly readFile = async (): Promise<Uint8Array> => {
    const deferred = this.nextDeferred;
    this.nextDeferred = undefined;
    if (deferred !== undefined) {
      return await deferred.promise;
    }
    if (this.file === undefined) {
      throw new NotFoundError();
    }
    return bytes(this.file);
  };
  public readonly createWatcher = (): CustomCssWatcher => this.watcher;
  public readonly isFileNotFound = (error: unknown): boolean => error instanceof NotFoundError;

  public deferNextRead(): DeferredRead {
    const deferred = new DeferredRead();
    this.nextDeferred = deferred;
    return deferred;
  }
}
