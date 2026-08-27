import type { SdkEventDto, RecordEventsRequest } from './types.js';

export interface EventSender {
  sendEvents(request: RecordEventsRequest): Promise<void>;
}

/**
 * Upper bound on buffered events.
 *
 * Only reachable once the events endpoint fails for long enough that re-queued
 * batches pile up. Past the bound the OLDEST events are shed, which caps memory
 * and keeps the freshest analytics — and means a long outage sheds the stale
 * re-queued batches rather than starving new events.
 */
export const DEFAULT_MAX_QUEUE_SIZE = 10_000;

/**
 * Raised when the events endpoint answers with a non-success status.
 *
 * `fetch` does not reject on an HTTP error status, so without an explicit check
 * a 503 was indistinguishable from success and the batch was discarded as
 * "sent" — no log, no counter, nothing (#2456).
 */
export class EventSendError extends Error {
  constructor(readonly status: number) {
    super(`Events endpoint responded ${status}.`);
    this.name = 'EventSendError';
  }

  /**
   * Whether the same batch could succeed if sent again: any 5xx (the production
   * edge answers this endpoint with a 503 at a low constant rate) and 429, where
   * the server is explicitly asking the caller to come back later.
   */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

/**
 * Anything that is not an explicit non-retryable status is treated as transient:
 * a rejection from `fetch` itself is a transport fault (DNS, TLS, reset), which a
 * later flush may well get past. A 401/403 (key rejected) or 400 (malformed body)
 * will fail identically next time, and retrying it forever would pin the queue at
 * its bound and starve every later event.
 */
function isRetryableSendFailure(err: unknown): boolean {
  return err instanceof EventSendError ? err.retryable : true;
}

/**
 * Guarantees an event is JSON-serializable before it enters the queue, so one
 * poison event can't make the batch-level `JSON.stringify` throw and silently
 * drop up to `flushBatchSize` unrelated valid events (see #1918).
 *
 * The SDK builds every top-level field from primitives, so caller-supplied
 * `metadata` (arbitrary values via `track()`/`identify()` — a BigInt, a
 * circular graph, a DOM node) is the only value that can fail to serialize.
 * When it does, strip just the metadata and keep the event — its key is the
 * analytics signal worth preserving — and warn so the failure isn't silent.
 */
function sanitizeEvent(event: SdkEventDto): SdkEventDto {
  if (event.metadata === undefined) return event;
  try {
    JSON.stringify(event.metadata);
    return event;
  } catch (err) {
    console.warn(
      `[featureflip] dropping non-serializable metadata on event "${event.flagKey}":`,
      err,
    );
    return { ...event, metadata: undefined };
  }
}

export class EventProcessor {
  private queue: SdkEventDto[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private flushPromise: Promise<void> | null = null;
  private readonly flushBatchSize: number;

  private readonly maxQueueSize: number;

  /**
   * Epoch ms before which the batch-size trigger must not start another flush.
   *
   * A re-queued batch leaves the queue at or above `flushBatchSize`, so without this
   * gate every subsequent `enqueue` would start another flush — turning a failing
   * endpoint into one request per event, which is worse for the server than the
   * dropping it replaces. The interval timer is the retry vehicle; this only
   * suppresses the size trigger between its ticks. (Concurrent starts are already
   * coalesced by `flushPromise`; this handles the gap AFTER a failed flush settles.)
   */
  private nextAutoFlushAt = 0;

  constructor(
    private readonly sender: EventSender,
    private readonly flushInterval: number,
    flushBatchSize: number,
    maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE,
  ) {
    this.maxQueueSize = maxQueueSize >= 1 ? maxQueueSize : DEFAULT_MAX_QUEUE_SIZE;
    // Defence-in-depth against a non-positive batch size: splice(0, n) with
    // n < 1 removes nothing, so flush() would loop forever on a non-empty
    // queue (see #1917). resolveConfig already rejects such values, but this
    // class is constructed directly too — clamp to >= 1 so it can never spin.
    this.flushBatchSize = flushBatchSize >= 1 ? flushBatchSize : 1;
  }

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
  }

  enqueue(event: SdkEventDto): void {
    if (this.closed) return;
    this.queue.push(sanitizeEvent(event));
    this.trimToBound();
    if (this.queue.length >= this.flushBatchSize && Date.now() >= this.nextAutoFlushAt) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    if (this.flushPromise) {
      return this.flushPromise;
    }

    this.flushPromise = (async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.flushBatchSize);
        try {
          await this.sender.sendEvents({ events: batch });
          this.nextAutoFlushAt = 0;
        } catch (err) {
          if (isRetryableSendFailure(err)) {
            // Back at the FRONT so the next flush retries it ahead of newer
            // events. Returning rather than continuing the loop is essential:
            // the batch is back in the queue the loop is draining, so carrying
            // on would re-send it immediately and spin for as long as the
            // endpoint stays down.
            this.requeue(batch);
            this.nextAutoFlushAt = Date.now() + this.flushInterval;
            return;
          }
          console.warn(
            `[featureflip] dropping ${batch.length} analytics event(s) the events endpoint rejected permanently:`,
            err,
          );
        }
      }
    })().finally(() => {
      this.flushPromise = null;
    });

    return this.flushPromise;
  }

  /** Returns a batch that failed to send to the front of the queue. */
  private requeue(batch: SdkEventDto[]): void {
    // After close() nothing will flush again, so buffering here would only leak.
    if (this.closed || batch.length === 0) return;
    this.queue = batch.concat(this.queue);
    this.trimToBound();
  }

  /** Sheds oldest-first until the queue fits the bound. */
  private trimToBound(): void {
    const overflow = this.queue.length - this.maxQueueSize;
    if (overflow <= 0) return;
    this.queue.splice(0, overflow);
    console.warn(
      `[featureflip] event queue is full; dropped ${overflow} of the oldest analytics event(s)`,
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // One last attempt, then let go. Looping until the queue empties would hang
    // shutdown for as long as the endpoint stayed down, and nothing will flush
    // after this, so whatever is left is discarded rather than retried.
    await this.flush();
    this.queue.length = 0;
  }
}
