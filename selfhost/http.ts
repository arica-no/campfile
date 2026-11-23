// Node's http server speaking Fetch: it stands between the network and the code's `fetch(request, env, ctx)`.
// The one thing it must get right is who the client is: the code reads the CLIENT_IP header (src/client.ts) for its sign-in, approval and report limits and for visitor hashing,
// and a client that can write that header can dodge every limit. So the header is rebuilt here from the connection, never taken from the client.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BlockList, isIP, isIPv4 } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CLIENT_IP, SCREENSHOT } from '../src/client.ts';

/** The largest request body, by Content-Length or by bytes counted. The app's own largest limit is 20 MB (MAX_BODY_BYTES in src/pages.ts). */
const MAX_BODY = 32 * 2 ** 20;
/** What the connector's endpoints under /oauth/ are sent: a few fields of JSON or a form, by anyone, with no sign-in. */
const MAX_OAUTH_BODY = 64 * 2 ** 10;
/** /oauth/register is the one of them that stores what it is sent, for 90 days, so it takes the least. */
const MAX_REGISTER_BODY = 8 * 2 ** 10;

/** The memory left for request bodies, in bytes. A body is read whole before the app runs, so one budget for the whole process keeps many uploads at once from filling it. */
export interface Budget {
  free: number;
}
// A byte of body costs about three in memory (the chunks, the joined buffer, the Request's copy), and the container has 1 GiB (compose.yaml).
const shared: Budget = { free: 96 * 2 ** 20 };

/** Requests and cron runs the app is working on, against the most it takes on at once: each opens a database connection, and Postgres allows 200 (compose.yaml). */
export interface Slots {
  used: number;
  max: number;
}
export const inFlight: Slots = { used: 0, max: 150 };

/** Work the code handed to `ctx.waitUntil` that is still running. Shutdown waits for it. */
export const pending = new Set<Promise<unknown>>();

/** What the code's `ctx` is: the shape src/viewer.ts is handed with every request. */
export interface Context {
  waitUntil(work: Promise<unknown>): void;
  passThroughOnException(): void;
  props: object;
}

/** An execution context for one request or cron run. The OAuth library sets `props` and `auth` on it, so nothing shares one. `work` collects what `waitUntil` is given. */
export function newContext(work: Promise<unknown>[] = []): Context {
  return {
    waitUntil(task: Promise<unknown>) {
      work.push(task);
      const done = Promise.resolve(task).catch((error) => console.error(error));
      pending.add(done);
      void done.then(() => pending.delete(done));
    },
    passThroughOnException() {},
    props: {},
  };
}

/** The IP addresses and CIDR ranges (`10.0.0.0/8`, `fd00::/8`) of TRUSTED_PROXIES, a comma-separated list. Throws on anything else: a typo must not quietly change who is trusted. */
export function trustedProxies(list: string): BlockList {
  const trusted = new BlockList();
  for (const entry of list.split(',').map((item) => item.trim()).filter(Boolean)) {
    const [address, bits, ...extra] = entry.split('/');
    const family = isIP(address);
    const prefix = bits === undefined ? undefined : /^\d+$/.test(bits) ? Number(bits) : NaN; // "10.0.0.0/" is a typo, not /0
    const longest = family === 4 ? 32 : 128;
    if (!family || extra.length || (prefix !== undefined && !(Number.isInteger(prefix) && prefix >= 0 && prefix <= longest))) {
      throw new Error(`TRUSTED_PROXIES: "${entry}" is not an IP address or a range like 10.0.0.0/8.`);
    }
    const name = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) trusted.addAddress(address, name);
    else trusted.addSubnet(address, prefix, name);
  }
  return trusted;
}

/** Equal as secrets should be compared: hashed first, so the comparison takes the same time whatever the lengths. */
const sameSecret = (given: string | string[] | undefined, secret: string) => typeof given === 'string' && timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(secret).digest());

const plain = (ip: string) => ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1'); // an IPv4 client of a dual-stack socket
const trusts = (trusted: BlockList, ip: string) => isIP(ip) !== 0 && trusted.check(ip, isIPv4(ip) ? 'ipv4' : 'ipv6');

/** One X-Forwarded-For entry as an address: some proxies write `1.2.3.4:5678`, `[2001:db8::1]:443` or `[2001:db8::1]` rather than the bare address. */
const hopAddress = (hop: string) => plain(hop.trim().replace(/^\[(.+)\](?::\d+)?$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1'));

/**
 * The address a request counts under: its connection's `peer`. Only when the peer is a trusted proxy, the client the proxy saw: the last X-Forwarded-For entry that is not a trusted proxy itself.
 * Entries further left are whatever the client or earlier hops wrote, so they never count. The peer wins whenever the header gives no usable address.
 */
export function clientIp(peer: string, forwarded: string | undefined, trusted: BlockList): string {
  const address = plain(peer);
  if (!forwarded || !trusts(trusted, address)) return address;
  const hops = forwarded.split(',').map(hopAddress);
  const client = hops.findLast((hop) => !trusts(trusted, hop)) ?? hops[0]; // every hop trusted: the first one is the client
  return isIP(client) ? client : address;
}

const fail = (res: ServerResponse, status: number, text: string, headers?: Record<string, string>) => res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }).end(text);

/**
 * The whole body of `req`, or undefined when the request is over: answered with 413 (past `limit`) or 503 (`take` has no memory left for it), or the client left or took longer than `timeout` milliseconds.
 * A refused body is still read to its end and thrown away, so that the client gets the answer, not a reset connection.
 * Bytes are taken as they arrive, whatever Content-Length declares: a header alone must not hold memory that other uploads need.
 */
async function readBody(req: IncomingMessage, res: ServerResponse, limit: number, take: (bytes: number) => boolean, giveBack: () => void, timeout: number): Promise<Buffer | undefined> {
  const declared = Number(req.headers['content-length'] ?? 0); // 0 for a chunked body, which declares nothing
  const chunks: Buffer[] = [];
  let size = 0;
  let refused = false;
  const refuse = (tooBig: boolean) => {
    refused = true;
    chunks.length = 0;
    giveBack(); // the rest is read and thrown away, so nothing of this body is held any more
    if (tooBig) fail(res, 413, 'That request is too big.');
    else fail(res, 503, 'Too many uploads at once. Try again in a moment.', { 'Retry-After': '10' });
  };
  const leave = () => req.destroy(); // once the answer is sent, Node no longer ends `req` when the client goes
  const timer = setTimeout(leave, timeout);
  req.socket.once('close', leave);
  try {
    if (declared > limit) refuse(true);
    for await (const chunk of req) {
      if (refused) continue;
      size += chunk.length;
      if (size > limit) refuse(true);
      else if (!take(chunk.length)) refuse(false);
      else chunks.push(chunk);
    }
  } catch {
    return undefined; // the client left, or the timer cut it off
  } finally {
    clearTimeout(timer);
    req.socket.off('close', leave);
  }
  return refused ? undefined : Buffer.concat(chunks, size);
}

/** Waits until every promise has settled, or `limit` milliseconds have passed. The timer is cleared, so that no request leaves one behind. */
async function settled(promises: Promise<unknown>[], limit: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.allSettled(promises), new Promise((done) => (timer = setTimeout(done, limit)))]);
  clearTimeout(timer);
}

/**
 * A server whose requests are Fetch requests for `origin` + the path the client asked for. The Host header is ignored: the code builds its links, cookies and origin checks from the URL, and the URL is the configured one.
 * Every `Campfile-*` header is dropped: those names are the server's own (src/client.ts), and the code trusts them. The one exception is `Campfile-Screenshot`, kept (as `1`) only when it holds `screenshotSecret`, which the screenshot service (selfhost/screenshot/server.mjs) sends. Then CLIENT_IP is set from the connection (clientIp). Nothing sets the country here.
 * A request's body is read whole before the handler runs (readBody), so that no database connection of the app waits on a slow client. `budget` is the memory the bodies may take together; `slots` the requests the app works on at once, background work included (503 past that); `bodyTimeout` the milliseconds a client has to send a body, and to read the answer to it; `backgroundTimeout` the milliseconds a slot waits for the background work after the answer.
 * Nothing is logged per request: the privacy page promises no request logs.
 */
export function serve(options: { origin: string; trusted: BlockList; handler: (request: Request, ctx: Context) => Response | Promise<Response>; budget?: Budget; slots?: Slots; bodyTimeout?: number; backgroundTimeout?: number; screenshotSecret?: string }): Server {
  const { origin, trusted, handler, budget = shared, slots = inFlight, bodyTimeout = 30_000, backgroundTimeout = 600_000, screenshotSecret } = options;
  const warned = new Set<string>();
  // Longer than the idle time of the usual reverse proxies (Caddy 2 min, nginx 75 s), or they reuse connections this end has just closed and answer 502.
  return createServer({ keepAliveTimeout: 125_000, headersTimeout: 130_000 }, async (req, res) => {
    let held = 0; // what this request has taken from the budget
    const background: Promise<unknown>[] = []; // what the app hands to ctx.waitUntil
    const giveBack = () => {
      budget.free += held;
      held = 0;
    };
    try {
      const peer = req.socket.remoteAddress;
      if (!peer) return void req.destroy();
      const url = req.url?.startsWith('/') && URL.canParse(origin + req.url) ? new URL(origin + req.url) : undefined; // parsed once: the dot segments of `/./oauth/register` are gone before the body cap is chosen
      if (!url) return void fail(res, 400, 'Bad request.');
      const method = req.method ?? 'GET';

      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string' && !name.startsWith('campfile-')) headers.set(name, value);
      if (screenshotSecret && sameSecret(req.headers[SCREENSHOT.toLowerCase()], screenshotSecret)) headers.set(SCREENSHOT, '1');
      const forwarded = headers.get('x-forwarded-for') ?? undefined;
      const ip = clientIp(peer, forwarded, trusted);
      if (forwarded && !trusts(trusted, plain(peer)) && warned.size < 20 && !warned.has(plain(peer))) {
        warned.add(plain(peer));
        console.warn(`${plain(peer)} sent X-Forwarded-For but is not in TRUSTED_PROXIES, so all its requests count as coming from ${plain(peer)}. If it is your reverse proxy, add it to TRUSTED_PROXIES.`);
      }
      headers.set(CLIENT_IP, ip);

      const take = (bytes: number) => {
        if (bytes > budget.free) return false;
        budget.free -= bytes;
        held += bytes;
        return true;
      };
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const limit = url.pathname === '/oauth/register' ? MAX_REGISTER_BODY : url.pathname.startsWith('/oauth/') ? MAX_OAUTH_BODY : MAX_BODY;
      const body = hasBody ? await readBody(req, res, limit, take, giveBack, bodyTimeout) : undefined;
      if (hasBody && !body) return; // answered, or the client is gone

      let request: Request;
      try {
        request = new Request(url, { method, headers, body });
      } catch {
        return void fail(res, 400, 'Bad request.');
      }
      if (slots.used >= slots.max) return void fail(res, 503, 'Too many requests at once. Try again in a moment.', { 'Retry-After': '5' });
      slots.used++;
      let response: Response;
      try {
        response = await handler(request, newContext(background));
      } finally {
        void settled(background, backgroundTimeout).then(() => slots.used--); // the app's database connection stays open until its background work settles (src/db.ts); the limit, above anything the app waits for, is for work that never settles
      }
      const sent: string[] = []; // the set-cookie headers come out one by one
      for (const [name, value] of response.headers) sent.push(name, value);
      res.writeHead(response.status, sent);
      if (method === 'HEAD' || !response.body) {
        void response.body?.cancel();
        res.end();
      } else await pipeline(Readable.fromWeb(response.body), res, { signal: held ? AbortSignal.timeout(bodyTimeout) : undefined }); // the answer to an upload must be read in time too: until then its bytes are held
    } catch (error) {
      if (!res.destroyed) console.error(error); // a client that went away mid-response is no error
      if (!res.headersSent) fail(res, 500, 'Internal Server Error.');
      else res.destroy();
    } finally {
      giveBack();
    }
  });
}
