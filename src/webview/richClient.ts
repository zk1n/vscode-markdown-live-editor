import type { RichOperation, RichRequest, RichResponse } from "../protocol/richMessages.js";

/** Request correlation has no editing authority; only the controller supplies identity/version. */
export class RichClient {
  private nextRequest = 1;
  private disposed = false;
  private readonly pending = new Map<number, (response: RichResponse | undefined) => void>();
  public constructor(
    private readonly post: (
      request: Pick<RichRequest, "requestId" | "operation" | "target" | "name" | "data">,
    ) => void,
  ) {}
  public request(
    operation: RichOperation,
    fields: { target?: string; name?: string; data?: string } = {},
  ): Promise<RichResponse | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.post({ requestId, operation, ...fields });
    });
  }
  public receive(response: RichResponse): void {
    const resolve = this.pending.get(response.requestId);
    this.pending.delete(response.requestId);
    resolve?.(response);
  }
  public dispose(): void {
    this.disposed = true;
    for (const resolve of this.pending.values()) resolve(undefined);
    this.pending.clear();
  }
}
