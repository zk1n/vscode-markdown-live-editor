import type { RichOperation, RichRequest, RichResponse } from "../protocol/richMessages.js";

/** Request correlation has no editing authority; only the controller supplies identity/version. */
export class RichClient {
  private nextRequest = 1;
  private disposed = false;
  private readonly pending = new Map<
    number,
    {
      finish: (response: RichResponse | undefined) => void;
      send: () => void;
    }
  >();
  public constructor(
    private readonly post: (
      request: Pick<
        RichRequest,
        "requestId" | "operation" | "target" | "name" | "data" | "targetVersion"
      >,
    ) => void,
    private ready = true,
  ) {}
  /** Construction may render images before the host has activated this controller. */
  public activate(): void {
    if (this.disposed || this.ready) return;
    this.ready = true;
    for (const request of this.pending.values()) request.send();
  }
  public request(
    operation: RichOperation,
    fields: { target?: string; name?: string; data?: string; targetVersion?: string } = {},
    signal?: AbortSignal,
  ): Promise<RichResponse | undefined> {
    if (this.disposed || signal?.aborted === true) return Promise.resolve(undefined);
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sent = false;
      const finish = (response: RichResponse | undefined): void => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(response);
      };
      const abort = (): void => {
        finish(undefined);
      };
      const send = (): void => {
        if (sent) return;
        sent = true;
        try {
          this.post({ requestId, operation, ...fields });
        } catch {
          finish(undefined);
        }
      };
      this.pending.set(requestId, { finish, send });
      signal?.addEventListener("abort", abort, { once: true });
      // Never resend side effects; a picker may legitimately remain open.
      if (operation === "image-resolve" || operation === "link-preview")
        timer = setTimeout(abort, 15000);
      if (this.ready) send();
    });
  }
  public receive(response: RichResponse): void {
    this.pending.get(response.requestId)?.finish(response);
  }
  public dispose(): void {
    this.disposed = true;
    for (const request of this.pending.values()) request.finish(undefined);
    this.pending.clear();
  }
}
