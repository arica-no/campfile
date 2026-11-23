import type { Browser } from './env.ts';

// The size social apps show for a link preview (og:image:width and og:image:height in src/viewer.ts).
export const PREVIEW_WIDTH = 1200;
export const PREVIEW_HEIGHT = 630;
/** How long publish and update wait for the screenshot before answering without it. The work then finishes in the background. */
export const PREVIEW_WAIT_MS = 8000;
/** The drawn title card's ?v=: an FNV-1a hash of the title, so a retitled page's card is fetched again (src/viewer.ts and the wall). */
export function cardVersion(title: string): string {
  let hash = 0x811c9dc5;
  for (const unit of title) hash = Math.imul(hash ^ unit.codePointAt(0)!, 0x01000193);
  return (hash >>> 0).toString(16);
}
/**
 * The drawn title card's sizes at 1200 px wide, by the title's length: short titles big, long ones smaller, so that up to about 120 characters show whole and a longer one ends in "…".
 * `balance` evens the lines out, only where the title surely fits: on a title that gets cut it would narrow every line. The PNG (selfhost/title-card.ts) and the wall's card in CSS (src/wall-style.ts) both follow it.
 */
export const CARD_TIERS = [
  { upTo: 20, size: 112, lines: 3, balance: true },
  { upTo: 44, size: 92, lines: 3, balance: true },
  { upTo: 80, size: 72, lines: 3, balance: true },
  { upTo: Infinity, size: 56, lines: 4, balance: false },
];
export const cardTier = (text: string) => CARD_TIERS.findIndex((tier) => [...text].length <= tier.upTo);

/** The screenshot service refused for lack of capacity right now: over its limit (429) or busy (503). No fault of the page, so it is not counted as a failed try (src/pages.ts makePreview). */
export class BrowserBusy extends Error {}

/**
 * A JPEG of the page as the viewer serves it, from the screenshot service, to a browser holding cookie `login` if given. Throws if it does not return one: BrowserBusy when it has no capacity (429, 503), else Error.
 * Quality 80 at this size is normally well below the 300 KB some apps (WhatsApp) accept for a preview image. It is not enforced.
 */
export async function takeScreenshot(browser: Browser, url: string, login?: { name: string; value: string }): Promise<Uint8Array<ArrayBuffer>> {
  const response = await browser.quickAction('screenshot', {
    url,
    viewport: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
    gotoOptions: { waitUntil: 'load', timeout: 10_000 },
    waitForTimeout: 2500, // time for the page's JavaScript to draw, entrance animations included
    actionTimeout: 10_000,
    cacheTTL: 0, // the service's default 5 s cache could hand a quick update the shot of the version before
    screenshotOptions: { type: 'jpeg', quality: 80 },
    // Host-only, like the viewer's own Set-Cookie: a __Host- cookie is refused with a domain.
    ...(login && { cookies: [{ ...login, url: new URL(url).origin, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' as const }] }),
  });
  if (!response.ok) throw new (response.status === 429 || response.status === 503 ? BrowserBusy : Error)(`The screenshot service answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const type = response.headers.get('Content-Type');
  if (!type?.startsWith('image/jpeg')) throw new Error(`The screenshot service answered with ${type ?? 'no content type'}, not a JPEG`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Resolves when `work` settles or after `ms`, whichever is first. `work` is not cancelled; it keeps running. */
export async function within(ms: number, work: Promise<unknown>): Promise<void> {
  const { promise: elapsed, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  try {
    await Promise.race([work, elapsed]);
  } finally {
    clearTimeout(timer);
  }
}
