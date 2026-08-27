export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
  readonly readyState: number;
}

export interface Platform {
  md5(input: string): Uint8Array;
  /**
   * May be asynchronous: the Node platform loads its ESM-only `eventsource`
   * dependency with a dynamic `import()`, which is what keeps the SDK's
   * `engines.node` floor at 20.19 (see platform/node.ts). Implementations that
   * need nothing loaded — the browser's global `EventSource` — may still return
   * the instance directly; the core awaits either shape.
   */
  createEventSource(
    url: string,
    headers: Record<string, string>,
  ): EventSourceLike | Promise<EventSourceLike>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Extra headers the platform can inject (e.g. User-Agent on Node). */
  readonly extraHeaders?: Record<string, string>;
  /** Whether the platform's EventSource implementation supports custom headers. */
  readonly sseSupportsHeaders?: boolean;
}
