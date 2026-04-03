import type { SdkEventDto, RecordEventsRequest } from './types.js';

export interface EventSender {
  sendEvents(request: RecordEventsRequest): Promise<void>;
}

export class EventProcessor {
  private queue: SdkEventDto[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private flushPromise: Promise<void> | null = null;

  constructor(
    private readonly sender: EventSender,
    private readonly flushInterval: number,
    private readonly flushBatchSize: number,
  ) {}

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
  }

  enqueue(event: SdkEventDto): void {
    if (this.closed) return;
    this.queue.push(event);
    if (this.queue.length >= this.flushBatchSize) {
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
        } catch {
          // Events are best-effort — drop on failure
        }
      }
    })().finally(() => {
      this.flushPromise = null;
    });

    return this.flushPromise;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush of remaining events
    while (this.queue.length > 0) {
      await this.flush();
    }
  }
}
