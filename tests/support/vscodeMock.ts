export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export class TreeItem {
  public id: string | undefined;
  public contextValue: string | undefined;
  public command: unknown;

  public constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  public readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: (): void => void this.listeners.delete(listener) };
  };

  public fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  public dispose(): void {
    this.listeners.clear();
  }
}

const openDocuments: unknown[] = [];

export const workspace = {
  textDocuments: openDocuments,
};

export const window = {
  showQuickPick: (): Promise<unknown> => Promise.resolve(undefined),
};

export function setTextDocuments(documents: readonly unknown[]): void {
  openDocuments.splice(0, openDocuments.length, ...documents);
}
