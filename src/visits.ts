import { CLIENT_COUNTRY, CLIENT_IP, SCREENSHOT } from './client.ts';
import type { DbVariables } from './db.ts';
import { newKey, sha256Hex } from './keys.ts';

/** What counting needs of a Hono context: the request's headers, and its database client and `waitUntil` (`withDb`, src/db.ts). */
interface Counting {
  req: { header(name: string): string | undefined };
  var: DbVariables;
}

// The browser that takes link-preview screenshots sends a normal Chrome User-Agent, so the server marks its requests (src/client.ts).
export const screenshotBrowser = (c: Counting) => Boolean(c.req.header(SCREENSHOT));
// Bots and link-preview fetchers that name no bot (Facebook's and iMessage's facebookexternalhit, WhatsApp, Teams' SkypeUriPreview, Mastodon's http.rb): never counted, never given an entry.
// Nor is the screenshot browser.
export const robot = (c: Counting) =>
  screenshotBrowser(c) ||
  /bot|crawl|spider|headless|facebookexternalhit|WhatsApp|SkypeUriPreview|Mastodon/i.test(c.req.header('User-Agent') ?? '');

/** docs/SPEC.md "Open counts": today's visitor of `scope` (what is counted: a page id for an open), as hex: sha256 of the day's salt, the scope, the IP and the User-Agent. */
async function visitorHash(c: Counting, scope: string): Promise<string> {
  // A day's first request makes its salt; in the same statement only `fresh` sees it, hence the union. When another request's salt wins,
  // this statement's snapshot sees neither and finds nothing, so it runs once more: a new statement sees the winner's salt, committed by then.
  const salt = () => c.var.sql<{ salt: string }[]>`
    with fresh as (insert into visit_salts (day, salt) values (current_date, ${newKey()}) on conflict do nothing returning salt)
    select salt from fresh union all select salt from visit_salts where day = current_date limit 1`;
  const row = (await salt())[0] ?? (await salt())[0];
  if (!row) throw new Error('No visit salt for today');
  return sha256Hex(`${row.salt} ${scope} ${c.req.header(CLIENT_IP) ?? ''} ${c.req.header('User-Agent') ?? ''}`);
}

/** Counts one load after the response is sent: a failure is logged and never thrown, so counting cannot slow or break what the visitor asked for. */
function count(c: Counting, scope: string, what: string, write: (hash: string, country: string | null) => PromiseLike<unknown>) {
  const counted = visitorHash(c, scope).then((hash) => write(hash, c.req.header(CLIENT_COUNTRY) || null));
  c.var.waitUntil(counted.catch((error) => console.error(`Counting ${what} failed:`, error)));
}

// docs/SPEC.md "Open counts": a visitor's browser loading the page into its frame, never its owner or a bot.
export function countOpen(c: Counting, id: string) {
  if (c.req.header('Sec-Fetch-Dest') !== 'iframe' || c.req.header('Sec-Fetch-Site') !== 'same-origin' || robot(c)) return;
  count(
    c,
    id,
    'an open',
    (hash, country) => c.var.sql`
      insert into page_visits (page, day, visitor, country) values (${id}, current_date, decode(${hash}, 'hex'), ${country})
      on conflict (page, day, visitor) do update set opens = page_visits.opens + 1`,
  );
}

