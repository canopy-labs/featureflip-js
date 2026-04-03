export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
  readonly readyState: number;
}

export interface Platform {
  md5(input: string): Uint8Array;
  createEventSource(url: string, headers: Record<string, string>): EventSourceLike;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Extra headers the platform can inject (e.g. User-Agent on Node). */
  readonly extraHeaders?: Record<string, string>;
  /** Whether the platform's EventSource implementation supports custom headers. */
  readonly sseSupportsHeaders?: boolean;
}
