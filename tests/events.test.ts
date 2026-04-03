import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventProcessor } from '../src/core/events.js';
import type { EventSender } from '../src/core/events.js';
import type { SdkEventDto } from '../src/core/types.js';

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
