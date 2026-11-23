import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error: plain JavaScript, the screenshot service has no types
import { bounded } from '../selfhost/screenshot/bounded.mjs';

const MAX_SHOTS = 1;
const never = () => Promise.withResolvers<never>().promise;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** The screenshot service's slot count (selfhost/screenshot/server.mjs), around `bounded`: 20 ms a shot, 40 ms to close it. */
function service() {
  let running = 0;
  let peak = 0;
  const run = async (start: () => Promise<unknown>, options: { cleanup(): unknown; kill(): unknown }) => {
    if (running >= MAX_SHOTS) return 'busy';
    peak = Math.max(peak, ++running);
    try {
      return await bounded(start, { ms: 20, cleanupMs: 40, ...options });
    } catch (error) {
      return (error as Error).message;
    } finally {
      running--;
    }
  };
  return { run, peak: () => peak };
}

it('keeps a timed-out shot in its slot until its pages are closed, so the next shot cannot overlap it', async () => {
  const { run, peak } = service();
  const shot = Promise.withResolvers<never>();
  const closing = Promise.withResolvers<void>();
  const slow = run(() => shot.promise, { cleanup: () => closing.promise, kill() {} });
  await vi.advanceTimersByTimeAsync(30); // past its 20 ms, closing
  expect(await run(async () => 'next', { cleanup() {}, kill() {} })).toBe('busy');
  closing.resolve();
  shot.reject(new Error('closed'));
  expect(await slow).toBe('The shot took too long.');
  expect(await run(async () => 'next', { cleanup() {}, kill() {} })).toBe('next');
  expect(peak()).toBe(1);
});

it('kills the browser when a timed-out shot does not close, and only then frees the slot', async () => {
  const { run } = service();
  const events: string[] = [];
  const hung = run(never, { cleanup: never, kill: () => events.push('killed') });
  await vi.advanceTimersByTimeAsync(40); // timed out, cleanup still hanging
  expect(await run(async () => 'next', { cleanup() {}, kill() {} })).toBe('busy');
  expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(40);
  expect(await hung).toBe('The shot took too long.');
  expect(events).toEqual(['killed']);
});

it('answers a quick shot with its image and does not kill anything', async () => {
  const events: string[] = [];
  expect(await service().run(async () => 'jpeg', { cleanup: () => events.push('closed'), kill: () => events.push('killed') })).toBe('jpeg');
  expect(events).toEqual(['closed']);
});
