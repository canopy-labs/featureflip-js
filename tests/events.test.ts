import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventProcessor, EventSendError } from '../src/core/events.js';
import type { EventSender } from '../src/core/events.js';
import type { SdkEventDto, RecordEventsRequest } from '../src/core/types.js';

function makeEvent(overrides: Partial<SdkEventDto> = {}): SdkEventDto {
  return {
    type: 'Evaluation',
    flagKey: 'test-flag',
    userId: 'user-1',
    variation: 'on',
    timestamp: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('EventProcessor', () => {
  let sender: EventSender;

  beforeEach(() => {
    vi.useFakeTimers();
    sender = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes when batch size reached', async () => {
    const processor = new EventProcessor(sender, 30_000, 3);
    processor.start();

    processor.enqueue(makeEvent());
    processor.enqueue(makeEvent());
    expect(sender.sendEvents).not.toHaveBeenCalled();

    processor.enqueue(makeEvent()); // batch size = 3
    // flush is async, give it a tick
    await vi.advanceTimersByTimeAsync(0);

    expect(sender.sendEvents).toHaveBeenCalledTimes(1);
    expect(sender.sendEvents).toHaveBeenCalledWith({
      events: [makeEvent(), makeEvent(), makeEvent()],
    });

    await processor.close();
  });

  it('flushes on interval', async () => {
    const processor = new EventProcessor(sender, 1000, 100);
    processor.start();

    processor.enqueue(makeEvent());
    expect(sender.sendEvents).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(sender.sendEvents).toHaveBeenCalledTimes(1);

    await processor.close();
  });

  it('flushes remaining events on close', async () => {
    const processor = new EventProcessor(sender, 30_000, 100);
    processor.start();

    processor.enqueue(makeEvent());
    processor.enqueue(makeEvent());

    await processor.close();
    expect(sender.sendEvents).toHaveBeenCalledTimes(1);
    expect(sender.sendEvents).toHaveBeenCalledWith({
      events: [makeEvent(), makeEvent()],
    });
  });

  it('does not enqueue after close', async () => {
    const processor = new EventProcessor(sender, 30_000, 100);
    processor.start();
    await processor.close();

    processor.enqueue(makeEvent());
    expect(sender.sendEvents).toHaveBeenCalledTimes(0);
  });

  it('drops events silently on send failure', async () => {
    const failSender: EventSender = {
      sendEvents: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const processor = new EventProcessor(failSender, 30_000, 1);
    processor.start();

    processor.enqueue(makeEvent());
    // Should not throw
    await vi.advanceTimersByTimeAsync(0);

    await processor.close();
  });

  it('handles empty flush gracefully', async () => {
    const processor = new EventProcessor(sender, 30_000, 100);
    await processor.flush();
    expect(sender.sendEvents).not.toHaveBeenCalled();
  });

  it('does not spin forever when constructed with a non-positive batch size', async () => {
    // A non-positive batch size makes splice(0, size) remove nothing, so the
    // flush loop would hot-spin forever posting empty batches. The processor
    // must clamp the batch size to >= 1 so a single event drains in one send.
    // Real timers + a macrotask-yielding sender ensure a regression fails via
    // the per-test timeout rather than hard-wedging the event loop.
    vi.useRealTimers();
    const yieldingSender: EventSender = {
      sendEvents: vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      ),
    };
    const processor = new EventProcessor(yieldingSender, 30_000, 0);

    processor.enqueue(makeEvent());
    await processor.flush();

    expect(yieldingSender.sendEvents).toHaveBeenCalledTimes(1);
    expect(yieldingSender.sendEvents).toHaveBeenCalledWith({
      events: [makeEvent()],
    });

    await processor.close();
  }, 2000);

  it('isolates a non-serializable metadata value so valid events in the same batch still send (#1918)', async () => {
    // The production sender JSON.stringifies the WHOLE batch at once. A single
    // event whose metadata JSON.stringify can't handle (a BigInt, a circular
    // graph) used to make that throw, and flush()'s batch-level try/catch then
    // dropped the entire batch — up to flushBatchSize unrelated valid events.
    // Reproduce with a sender that serializes exactly like production does.
    const received: SdkEventDto[] = [];
    const serializingSender: EventSender = {
      sendEvents: vi.fn(async (request: RecordEventsRequest) => {
        JSON.stringify(request); // throws on a poison event, as production does
        received.push(...request.events);
      }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const processor = new EventProcessor(serializingSender, 30_000, 100);
    processor.enqueue(
      makeEvent({ type: 'Custom', flagKey: 'good_1', metadata: { amount: 5 } }),
    );
    processor.enqueue(
      makeEvent({ type: 'Custom', flagKey: 'poison', metadata: { count: 10n } }),
    );
    processor.enqueue(
      makeEvent({ type: 'Custom', flagKey: 'good_2', metadata: { amount: 7 } }),
    );

    await processor.flush();

    // Both valid events must reach the network — no collateral loss.
    const keys = received.map((e) => e.flagKey);
    expect(keys).toContain('good_1');
    expect(keys).toContain('good_2');
    // The failure must be surfaced, not silently swallowed.
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    await processor.close();
  });

  it('keeps the offending event but strips its unserializable metadata (#1918)', async () => {
    const received: SdkEventDto[] = [];
    const serializingSender: EventSender = {
      sendEvents: vi.fn(async (request: RecordEventsRequest) => {
        JSON.stringify(request);
        received.push(...request.events);
      }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const processor = new EventProcessor(serializingSender, 30_000, 1);
    processor.enqueue(
      makeEvent({ type: 'Custom', flagKey: 'poison', metadata: { count: 10n } }),
    );
    await processor.flush();

    // The event itself is still recorded (its key is the analytics signal);
    // only the unserializable metadata is dropped.
    expect(received).toHaveLength(1);
    expect(received[0]?.flagKey).toBe('poison');
    expect(received[0]?.metadata).toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    await processor.close();
  });

  it('leaves serializable metadata untouched', async () => {
    const received: SdkEventDto[] = [];
    const serializingSender: EventSender = {
      sendEvents: vi.fn(async (request: RecordEventsRequest) => {
        JSON.stringify(request);
        received.push(...request.events);
      }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const processor = new EventProcessor(serializingSender, 30_000, 1);
    const metadata = { amount: 5, nested: { ok: true }, tags: ['a', 'b'] };
    processor.enqueue(makeEvent({ type: 'Custom', flagKey: 'ok', metadata }));
    await processor.flush();

    expect(received).toHaveLength(1);
    expect(received[0]?.metadata).toEqual(metadata);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
    await processor.close();
  });

  it('flushes events enqueued during an in-progress flush', async () => {
    let resolveFlush!: () => void;
    const slowSender: EventSender = {
      sendEvents: vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { resolveFlush = resolve; }),
      ),
    };
    const processor = new EventProcessor(slowSender, 30_000, 100);
    processor.start();

    // Enqueue first event and start flushing
    processor.enqueue(makeEvent({ flagKey: 'first' }));
    const firstFlush = processor.flush();

    // While first flush is in-progress, enqueue another event and call flush
    processor.enqueue(makeEvent({ flagKey: 'second' }));
    const secondFlush = processor.flush();

    // Complete the first send — the loop should pick up the second event
    resolveFlush();
    // Let the loop iteration start, then resolve the second send
    await Promise.resolve();
    resolveFlush();

    await firstFlush;
    await secondFlush;

    // Both events should have been flushed
    expect(slowSender.sendEvents).toHaveBeenCalledTimes(2);
    expect(slowSender.sendEvents).toHaveBeenCalledWith({
      events: [makeEvent({ flagKey: 'first' })],
    });
    expect(slowSender.sendEvents).toHaveBeenCalledWith({
      events: [makeEvent({ flagKey: 'second' })],
    });

    await processor.close();
  });
});

/**
 * Regression guard for #2456: the flush splices the batch out of the queue before
 * sending it, so until this was fixed any rejection discarded those events. In
 * production the public edge answers /v1/sdk/events with a 503 at a low but constant
 * rate, so evaluation analytics were being lost steadily rather than during incidents.
 */
describe('EventProcessor failure handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the batch for the next flush when the send fails transiently', async () => {
    const sendEvents = vi
      .fn<(request: RecordEventsRequest) => Promise<void>>()
      .mockRejectedValueOnce(new EventSendError(503))
      .mockResolvedValue(undefined);
    const processor = new EventProcessor({ sendEvents }, 30_000, 100);

    processor.enqueue(makeEvent({ flagKey: 'flag-a' }));
    await processor.flush();

    // The 503 must not have consumed the event.
    await processor.flush();

    expect(sendEvents).toHaveBeenCalledTimes(2);
    expect(sendEvents.mock.calls[1][0].events.map((e) => e.flagKey)).toEqual(['flag-a']);
  });

  it('treats a network rejection as retryable', async () => {
    const sendEvents = vi
      .fn<(request: RecordEventsRequest) => Promise<void>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(undefined);
    const processor = new EventProcessor({ sendEvents }, 30_000, 100);

    processor.enqueue(makeEvent({ flagKey: 'flag-a' }));
    await processor.flush();
    await processor.flush();

    expect(sendEvents.mock.calls[1][0].events.map((e) => e.flagKey)).toEqual(['flag-a']);
  });

  it('drops the batch when the endpoint rejects it permanently', async () => {
    const sendEvents = vi
      .fn<(request: RecordEventsRequest) => Promise<void>>()
      .mockRejectedValue(new EventSendError(401));
    const processor = new EventProcessor({ sendEvents }, 30_000, 100);

    processor.enqueue(makeEvent({ flagKey: 'flag-a' }));
    await processor.flush();
    await processor.flush();

    // Retrying a rejected SDK key forever would pin the queue at its bound.
    expect(sendEvents).toHaveBeenCalledTimes(1);
  });

  it('does not spin while the endpoint is failing', async () => {
    const sendEvents = vi
      .fn<(request: RecordEventsRequest) => Promise<void>>()
      .mockRejectedValue(new EventSendError(503));
    const processor = new EventProcessor({ sendEvents }, 30_000, 1);

    processor.enqueue(makeEvent({ flagKey: 'flag-a' }));
    processor.enqueue(makeEvent({ flagKey: 'flag-b' }));

    // A re-queue at the head of a queue the loop is draining must not become an
    // infinite loop: one flush makes exactly one attempt before giving up.
    await processor.flush();

    expect(sendEvents).toHaveBeenCalledTimes(1);
  });

  it('sheds the oldest events beyond the queue bound', async () => {
    const sendEvents = vi.fn<(request: RecordEventsRequest) => Promise<void>>().mockResolvedValue(undefined);
    const processor = new EventProcessor({ sendEvents }, 30_000, 100, 3);

    for (let i = 0; i < 5; i++) processor.enqueue(makeEvent({ flagKey: `flag-${i}` }));
    await processor.flush();

    expect(sendEvents.mock.calls[0][0].events.map((e) => e.flagKey)).toEqual([
      'flag-2',
      'flag-3',
      'flag-4',
    ]);
  });

  it('close() returns even when the endpoint is down', async () => {
    const sendEvents = vi
      .fn<(request: RecordEventsRequest) => Promise<void>>()
      .mockRejectedValue(new EventSendError(503));
    const processor = new EventProcessor({ sendEvents }, 30_000, 100);
    processor.start();
    processor.enqueue(makeEvent({ flagKey: 'flag-a' }));

    // Nothing will flush after close, so a still-failing endpoint must not hang shutdown.
    await expect(processor.close()).resolves.toBeUndefined();
  });
});

describe('EventProcessor flush amplification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not flush on every event while the endpoint is failing', async () => {
    const sendEvents = vi
      .fn<(request: RecordEventsRequest) => Promise<void>>()
      .mockRejectedValue(new EventSendError(503));
    // batchSize 1: every enqueue trips the size trigger.
    const processor = new EventProcessor({ sendEvents }, 30_000, 1);

    processor.enqueue(makeEvent({ flagKey: 'flag-0' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sendEvents).toHaveBeenCalledTimes(1);

    // Events arriving AFTER that failure has settled are the amplification path:
    // `flushPromise` coalesces starts within one tick, so only a separate tick shows
    // it. The re-queue leaves the queue above the batch size, so without the backoff
    // each of these would start its own flush and a failing endpoint would get one
    // request per event.
    for (let i = 1; i < 10; i++) {
      processor.enqueue(makeEvent({ flagKey: `flag-${i}` }));
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(sendEvents).toHaveBeenCalledTimes(1);
  });

  it('resumes flushing on the batch trigger once a send succeeds', async () => {
    const sendEvents = vi
      .fn<(request: RecordEventsRequest) => Promise<void>>()
      .mockResolvedValue(undefined);
    const processor = new EventProcessor({ sendEvents }, 30_000, 1);

    processor.enqueue(makeEvent({ flagKey: 'flag-a' }));
    await vi.advanceTimersByTimeAsync(0);
    processor.enqueue(makeEvent({ flagKey: 'flag-b' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(sendEvents).toHaveBeenCalledTimes(2);
  });
});
