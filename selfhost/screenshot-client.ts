// The app's side of the screenshot service (selfhost/screenshot/): a `Browser` (src/env.ts) that sends the options of src/preview.ts takeScreenshot to the service and hands back its answer.
// The service answers 503 when it is busy, which takeScreenshot already reads as "no capacity, try later"; so nothing here maps statuses.
import type { Browser } from '../src/env.ts';

/** `url` is the service's origin (SCREENSHOT_URL), `secret` the one both sides hold. fetch is read at each call: server.ts has swapped it for the guarded one (selfhost/outbound.ts) by the time one is taken. */
export function screenshotService(url: string, secret: string): Browser {
  return {
    quickAction: (action, options) =>
      fetch(`${url}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
        // The service's own limits, then a margin for the queue and the encoding.
        signal: AbortSignal.timeout(options.gotoOptions.timeout + options.waitForTimeout + options.actionTimeout + 10_000),
      }),
  };
}
