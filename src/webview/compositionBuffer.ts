export interface CompositionCommit {
  readonly baseDocumentVersion: number;
  readonly baseText: string;
  readonly finalText: string;
}

interface ActiveComposition {
  readonly baseDocumentVersion: number;
  readonly baseText: string;
  latestText: string;
}

/** Keeps IME preedit outside the persistent document queue. */
export class CompositionBuffer {
  private active: ActiveComposition | undefined;

  public get isActive(): boolean {
    return this.active !== undefined;
  }

  public begin(baseDocumentVersion: number, baseText: string): void {
    if (this.active !== undefined) {
      return;
    }
    this.active = { baseDocumentVersion, baseText, latestText: baseText };
  }

  public update(localText: string): void {
    if (this.active !== undefined) {
      this.active.latestText = localText;
    }
  }

  public finish(localText: string): CompositionCommit | undefined {
    const active = this.active;
    if (active === undefined) {
      return undefined;
    }
    this.active = undefined;
    return {
      baseDocumentVersion: active.baseDocumentVersion,
      baseText: active.baseText,
      finalText: localText,
    };
  }

  public abandon(): void {
    this.active = undefined;
  }
}
