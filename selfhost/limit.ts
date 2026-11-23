// /oauth/register needs no sign-in and writes an entry that lives 90 days, so without a limit anyone could fill the connector's directory.
import { CLIENT_IP } from '../src/client.ts';
import type { Context } from './http.ts';

export type Handler = (request: Request, ctx: Context) => Response | Promise<Response>;

/** What `limitPosts` limits: the POSTs to `path`, per client and for all clients together, in windows of `windowMs` milliseconds. */
export interface PostLimit {
  path: string;
  perClient: number;
  total: number;
  windowMs: number;
  /** The name a client counts under, from its CLIENT_IP header: `senderKey` of src/signin.ts counts an IPv6 client by its /64, like the app's own limits. */
  keyOf: (ip: string) => string;
  /** How many clients are remembered; past that the oldest are dropped. */
  keep?: number;
}

type Tally = { start: number; count: number };

/**
 * `handler`, except that a POST to `path` gets 429 and Retry-After once its client has made `perClient` of them in a window, or all clients together `total`: a spread over many addresses gets round the first limit only.
 * The counts are in memory: a restart forgets them. Only a POST that is let through counts, so a client over its own limit does not use up the total.
 */
export function limitPosts(handler: Handler, { path, perClient, total, windowMs, keyOf, keep = 10_000 }: PostLimit): Handler {
  const windows = new Map<string, Tally>(); // in the order they began, so the expired ones come first
  let all: Tally = { start: 0, count: 0 };
  return (request, ctx) => {
    if (request.method !== 'POST' || new URL(request.url).pathname !== path) return handler(request, ctx);
    const now = Date.now();
    for (const [key, window] of windows) {
      if (window.start + windowMs > now) break;
      windows.delete(key);
    }
    if (all.start + windowMs <= now) all = { start: now, count: 0 };
    const key = keyOf(request.headers.get(CLIENT_IP) ?? '');
    let window = windows.get(key);
    if (!window) {
      if (windows.size >= keep) windows.delete(windows.keys().next().value!);
      window = { start: now, count: 0 };
      windows.set(key, window);
    }
    const full = window.count >= perClient ? window : all.count >= total ? all : undefined;
    if (full) return new Response('Too many requests. Try again later.', { status: 429, headers: { 'Retry-After': String(Math.ceil((full.start + windowMs - now) / 1000)) } });
    window.count++;
    all.count++;
    return handler(request, ctx);
  };
}
