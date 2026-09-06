export type BarrierAction = "save" | "undo" | "redo" | "set-eol";

export interface BarrierRequest {
  readonly action: BarrierAction;
  readonly shortcutAttemptId: string;
  readonly eol?: "lf" | "crlf";
}

/**
 * Preserves barrier FIFO without preventing the completion of the composition
 * that was already active when the first barrier was requested.
 */
export class BarrierInputGate {
  private readonly queue: BarrierRequest[] = [];
  private inputFrozen = false;
  private inFlightSequence: number | undefined;
  private allowedCompositionGeneration: number | undefined;

  public get isFrozen(): boolean {
    return this.inputFrozen;
  }

  public get queueLength(): number {
    return this.queue.length;
  }

  public get nextAction(): BarrierAction | undefined {
    return this.queue[0]?.action;
  }

  public get nextRequest(): BarrierRequest | undefined {
    return this.queue[0];
  }

  public get barrierInFlightSequence(): number | undefined {
    return this.inFlightSequence;
  }

  public enqueue(
    action: BarrierAction,
    activeCompositionGeneration: number | undefined,
    shortcutAttemptId = "untraced",
    eol?: "lf" | "crlf",
  ): void {
    if (!this.inputFrozen) {
      this.allowedCompositionGeneration = activeCompositionGeneration;
      this.inputFrozen = true;
    }
    this.queue.push({ action, shortcutAttemptId, ...(eol === undefined ? {} : { eol }) });
  }

  public acceptsLocalTransaction(activeCompositionGeneration: number | undefined): boolean {
    return (
      !this.inputFrozen ||
      (activeCompositionGeneration !== undefined &&
        activeCompositionGeneration === this.allowedCompositionGeneration)
    );
  }

  public markBarrierSent(sequence: number): void {
    this.inFlightSequence = sequence;
  }

  public acknowledgeBarrier(sequence: number): boolean {
    if (sequence !== this.inFlightSequence) {
      return false;
    }
    this.inFlightSequence = undefined;
    this.queue.shift();
    return true;
  }

  public completeIfIdle(): boolean {
    if (this.queue.length !== 0 || this.inFlightSequence !== undefined) {
      return false;
    }
    this.inputFrozen = false;
    this.allowedCompositionGeneration = undefined;
    return true;
  }

  public reset(): void {
    this.queue.length = 0;
    this.inFlightSequence = undefined;
    this.allowedCompositionGeneration = undefined;
    this.inputFrozen = false;
  }

  public hasDeterministicProgress(
    compositionActive: boolean,
    precedingEditInFlight: boolean,
  ): boolean {
    return (
      !this.inputFrozen ||
      this.inFlightSequence !== undefined ||
      compositionActive ||
      precedingEditInFlight
    );
  }
}
