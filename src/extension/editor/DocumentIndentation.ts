export interface IndentationOptions {
  readonly insertSpaces: boolean;
  readonly tabSize: number;
  readonly indentSize?: number;
}

/** Transient options live as long as the open TextDocument, never in global settings. */
export class DocumentIndentation {
  private readonly options = new WeakMap<object, IndentationOptions>();
  private readonly listeners = new WeakMap<object, Set<() => void>>();

  public resolve(document: object, fallback: IndentationOptions): IndentationOptions {
    return this.options.get(document) ?? fallback;
  }

  public set(document: object, options: IndentationOptions): boolean {
    this.options.set(document, { ...options });
    const listeners = this.listeners.get(document);
    for (const listener of listeners ?? []) listener();
    return (listeners?.size ?? 0) > 0;
  }

  public subscribe(document: object, listener: () => void): { dispose(): void } {
    const listeners = this.listeners.get(document) ?? new Set<() => void>();
    this.listeners.set(document, listeners);
    listeners.add(listener);
    return {
      dispose: (): void => {
        listeners.delete(listener);
      },
    };
  }
}
