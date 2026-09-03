/**
 * Keeps the exact local text that is intended for the next authoritative
 * replacement.  It never reads EditorView state itself: callers must provide
 * the stable text they intend to commit.
 */
export class PendingEditQueue {
  private pendingText: string | undefined;
  private inFlightText: string | undefined;

  public constructor(private authoritativeText: string) {}

  public get authority(): string {
    return this.authoritativeText;
  }

  public get hasPending(): boolean {
    return this.pendingText !== undefined;
  }

  public get hasInFlight(): boolean {
    return this.inFlightText !== undefined;
  }

  public get inFlightTarget(): string | undefined {
    return this.inFlightText;
  }

  public queue(targetText: string): void {
    if (this.inFlightText === targetText) {
      if (this.pendingText === targetText) {
        this.pendingText = undefined;
      }
      return;
    }
    if (this.inFlightText === undefined && targetText === this.authoritativeText) {
      this.pendingText = undefined;
      return;
    }
    this.pendingText = targetText;
  }

  /** Marks the next explicit target as sent, if no edit is already in flight. */
  public takeNext(): string | undefined {
    if (this.inFlightText !== undefined || this.pendingText === undefined) {
      return undefined;
    }
    const targetText = this.pendingText;
    this.pendingText = undefined;
    if (targetText === this.authoritativeText) {
      return undefined;
    }
    this.inFlightText = targetText;
    return targetText;
  }

  public acknowledge(authoritativeText: string): void {
    this.inFlightText = undefined;
    this.authoritativeText = authoritativeText;
  }

  public replaceAuthority(authoritativeText: string): void {
    this.authoritativeText = authoritativeText;
  }

  public reset(authoritativeText: string): void {
    this.authoritativeText = authoritativeText;
    this.pendingText = undefined;
    this.inFlightText = undefined;
  }
}
