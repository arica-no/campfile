import { afterEach, expect, it, vi } from 'vitest';
import { PREVIEW_WAIT_MS, within } from '../src/preview.ts';

afterEach(() => vi.useRealTimers());

it('stops waiting at the limit, to the millisecond, and leaves the work running', async () => {
  vi.useFakeTimers();
  const work = Promise.withResolvers<string>();
  let stopped = false;
  const waiting = within(PREVIEW_WAIT_MS, work.promise).then(() => (stopped = true));

  await vi.advanceTimersByTimeAsync(PREVIEW_WAIT_MS - 1);
  expect(stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await waiting;
  expect(stopped).toBe(true);

  work.resolve('done');
  expect(await work.promise).toBe('done'); // the work was not cancelled
});

it('returns as soon as the work is done, and leaves no timer behind', async () => {
  vi.useFakeTimers();
  await within(PREVIEW_WAIT_MS, Promise.resolve());
  expect(vi.getTimerCount()).toBe(0);
});
