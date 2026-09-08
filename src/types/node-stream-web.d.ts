// @types/node 24 does not yet export this Node 25-compatible helper type,
// while the test-only happy-dom declaration references it. The runtime never
// consumes this declaration; it only keeps `skipLibCheck: false` viable.
declare module "node:stream/web" {
  export interface UnderlyingDefaultSource<R = unknown> {
    readonly autoAllocateChunkSize?: never;
    cancel?: (reason?: unknown) => void | PromiseLike<void>;
    pull?: (controller: ReadableStreamDefaultController<R>) => void | PromiseLike<void>;
    start?: (controller: ReadableStreamDefaultController<R>) => void | PromiseLike<void>;
    readonly type?: never;
  }
}
