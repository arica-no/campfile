// The self-hosted server (selfhost/http.ts) must tell the app who the client is: the sign-in, approval and report limits and the visitor hashes all read Campfile-Client-IP.
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { clientIp, pending, serve, trustedProxies } from '../selfhost/http.ts';
import app from '../src/app.ts';
import { CODES_PER_IP_PER_DAY } from '../src/signin.ts';
import viewer from '../src/viewer.ts';
import { addTester, env, publishedPage, sql, useCleanDatabase } from './helpers.ts';

useCleanDatabase();
beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {})); // selfhost/http.ts warns about an untrusted X-Forwarded-For

const proxies = trustedProxies('10.0.0.0/8, 172.16.0.0/12, fd00::/8');
it.each([
  ['a connection with no X-Forwarded-For', '203.0.113.5', undefined, '203.0.113.5'],
  ['an untrusted peer: its X-Forwarded-For is ignored', '203.0.113.5', '6.6.6.6', '203.0.113.5'],
  ['a trusted proxy: the client it saw', '10.0.0.2', '203.0.113.50', '203.0.113.50'],
  ['a trusted proxy: entries the client wrote further left do not count', '10.0.0.2', '6.6.6.6, 203.0.113.50', '203.0.113.50'],
  ['two trusted proxies in a row: the last entry that is not one of them', '10.0.0.2', '203.0.113.50, 172.16.0.9', '203.0.113.50'],
  ['every entry a trusted proxy: the first', '10.0.0.2', '10.0.0.7, 10.0.0.8', '10.0.0.7'],
  ['an X-Forwarded-For that is no address: the peer', '10.0.0.2', 'not-an-ip', '10.0.0.2'],
  ['an empty X-Forwarded-For: the peer', '10.0.0.2', '', '10.0.0.2'],
  ['an IPv4 proxy on a dual-stack socket', '::ffff:10.0.0.2', '203.0.113.50', '203.0.113.50'],
  ['an IPv4 stranger on a dual-stack socket', '::ffff:203.0.113.5', '6.6.6.6', '203.0.113.5'],
  ['an IPv6 proxy and an IPv6 client', 'fd00::2', '2001:db8::7', '2001:db8::7'],
  ['an entry with a port: the address without it', '10.0.0.2', '203.0.113.50:51820', '203.0.113.50'],
  ['a trusted proxy written with a port is still a proxy', '10.0.0.2', '203.0.113.50, 10.0.0.9:443', '203.0.113.50'],
  ['an IPv6 client in brackets, with a port', '10.0.0.2', '[2001:db8::7]:443', '2001:db8::7'],
  ['an IPv6 client in brackets, without one', '10.0.0.2', '[2001:db8::7]', '2001:db8::7'],
  ['an IPv4-mapped client in brackets, with a port', '10.0.0.2', '[::ffff:203.0.113.50]:443', '203.0.113.50'],
  ['a name with a port is no address: the peer', '10.0.0.2', 'proxy.example:443', '10.0.0.2'],
])('counts under the right address for %s', (_, peer, forwarded, expected) => {
  expect(clientIp(peer, forwarded, proxies)).toBe(expected);
});

it('refuses a TRUSTED_PROXIES entry that is not an address or a range, and trusts nobody when it is empty', () => {
  for (const bad of ['10.0.0.0/33', '10.0.0.0/', '10.0.0.0/-1', '10.0.0.0/8/8', 'fd00::/129', 'nope', '10.0.0']) expect(() => trustedProxies(bad), bad).toThrow('TRUSTED_PROXIES');
  expect(trustedProxies(' ').check('10.0.0.1')).toBe(false);
  expect(trustedProxies('10.0.0.1, 192.168.0.0/16').check('192.168.4.4')).toBe(true);
});

// compose.yaml says it in three places that must agree, and the default must stay one address: a range would let any other machine on the network dodge the limits.
it('trusts by default only the bundled Caddy, at the fixed address compose.yaml gives it inside the network’s subnet', () => {
  const compose = readFileSync(new URL('../selfhost/compose.yaml', import.meta.url), 'utf8');
  const find = (pattern: RegExp) => compose.match(pattern)?.[0] ?? '';
  const caddy = find(/(?<=ipv4_address: )\S+/);
  expect(caddy).not.toBe('');
  expect(find(/(?<=TRUSTED_PROXIES: \$\{TRUSTED_PROXIES-)[^}]*/)).toBe(caddy);
  expect(trustedProxies(find(/(?<=- subnet: )\S+/)).check(caddy)).toBe(true);
  expect(readFileSync(new URL('../selfhost/.env.example', import.meta.url), 'utf8')).not.toMatch(/^TRUSTED_PROXIES=/m); // copied to .env, it would replace the default
});

// Real connections: the app behind serve(). Every 127.x.x.x address is this machine on Linux, which gives the clients their own addresses.
let open: Server; // nobody is a trusted proxy
let proxied: Server; // 127.0.0.1 is a trusted proxy
let probe: Server; // answers with the request the app would have got
let views: Server; // the viewer
const servers = () => [open, proxied, probe, views];

beforeAll(async () => {
  const origin = env.APP_ORIGIN;
  open = serve({ origin, trusted: trustedProxies(''), handler: (req, ctx) => app.fetch(req, env, ctx) });
  proxied = serve({ origin, trusted: trustedProxies('127.0.0.1'), handler: (req, ctx) => app.fetch(req, env, ctx) });
  probe = serve({ origin, trusted: trustedProxies(''), handler: (req) => Response.json({ url: req.url, headers: Object.fromEntries(req.headers) }) });
  views = serve({ origin: env.VIEWER_ORIGIN, trusted: trustedProxies(''), handler: (req, ctx) => viewer.fetch(req, env, ctx) });
  for (const server of servers()) server.listen(0);
  await Promise.all(servers().map((server) => once(server, 'listening')));
});
afterAll(() =>
  Promise.all(
    servers().map((server) => {
      server.close();
      server.closeAllConnections();
      return once(server, 'close');
    }),
  ),
);

/** One request on a fresh connection from the local address `from`. A body is sent as JSON with POST. */
function send(server: Server, from: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
  const sent = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, localAddress: from, path, agent: false, method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers } }, (res) => {
    let text = '';
    res.setEncoding('utf8').on('data', (chunk) => (text += chunk)).on('end', () => resolve({ status: res.statusCode ?? 0, text }));
  });
  sent.on('error', reject).end(body === undefined ? undefined : JSON.stringify(body));
  return promise;
}

const askCode = (server: Server, from: string, email: string, headers?: Record<string, string>) => send(server, from, '/api/signin', headers, { email });
const askUntilFull = async (server: Server, from: string, headers: (n: number) => Record<string, string> = () => ({})) => {
  for (let n = 1; n <= CODES_PER_IP_PER_DAY; n++) expect((await askCode(server, from, `person${n}@example.com`, headers(n))).status, `code ${n} from ${from}`).toBe(200);
  expect((await askCode(server, from, 'one-more@example.com')).status).toBe(429);
};

it('counts a client by its connection: Campfile-Client-IP and X-Forwarded-For sent by the client change nothing', async () => {
  await askUntilFull(open, '127.0.0.1', (n) => ({ 'Campfile-Client-IP': `198.51.100.${n}`, 'X-Forwarded-For': `192.0.2.${n}` })); // a different "sender" every time would never reach the limit
  expect(await sql`select distinct ip from signin_sends`).toEqual([{ ip: '127.0.0.1' }]);
});

// 127.0.0.3 is not configured on every system (macOS has only 127.0.0.1).
const neighbour = '127.0.0.3';
const probing = createServer().listen(0, neighbour);
const hasNeighbour = await once(probing, 'listening').then(() => true, () => false);
probing.close();
it.skipIf(!hasNeighbour)('counts two clients with different addresses separately: one reaching its limit does not block the other', async () => {
  await askUntilFull(open, '127.0.0.1');
  expect((await askCode(open, neighbour, 'neighbour@example.com')).status).toBe(200);
  expect(await sql`select ip from signin_sends where email = 'neighbour@example.com'`).toEqual([{ ip: neighbour }]);
});

it('takes the client from X-Forwarded-For only on a connection from a trusted proxy', async () => {
  const forwarded = { 'X-Forwarded-For': '6.6.6.6, 203.0.113.50' };
  expect((await askCode(proxied, '127.0.0.1', 'behind@example.com', forwarded)).status).toBe(200);
  expect((await askCode(open, '127.0.0.1', 'direct@example.com', forwarded)).status).toBe(200);
  expect(await sql`select email, ip from signin_sends order by email`).toEqual([
    { email: 'behind@example.com', ip: '203.0.113.50' },
    { email: 'direct@example.com', ip: '127.0.0.1' },
  ]);
});

it('says once in the log, per address, that a peer outside TRUSTED_PROXIES sent X-Forwarded-For', async () => {
  const lonely = serve({ origin: env.APP_ORIGIN, trusted: trustedProxies('10.0.0.0/8'), handler: () => new Response('ok') });
  lonely.listen(0);
  await once(lonely, 'listening');
  for (let n = 0; n < 2; n++) await send(lonely, '127.0.0.1', '/', { 'X-Forwarded-For': '203.0.113.50' });
  expect(console.warn).toHaveBeenCalledOnce();
  expect(vi.mocked(console.warn).mock.calls[0][0]).toContain('add it to TRUSTED_PROXIES');
  lonely.close();
  lonely.closeAllConnections();
});

it('hands the app a request for the configured origin with no Campfile-* header but the one made from the connection', async () => {
  const spoofed = { Host: 'evil.example', 'Campfile-Client-Country': 'NO', 'Campfile-Client-IP': '6.6.6.6', 'Campfile-Screenshot': '1', 'Campfile-Anything': 'x', 'X-Forwarded-For': '6.6.6.6' };
  const seen = JSON.parse((await send(probe, '127.0.0.1', '/some/path?x=1', spoofed)).text);
  expect(seen.url).toBe(`${env.APP_ORIGIN}/some/path?x=1`);
  expect(Object.keys(seen.headers).filter((name) => name.startsWith('campfile-'))).toEqual(['campfile-client-ip']);
  expect(seen.headers['campfile-client-ip']).toBe('127.0.0.1');

  // A path that looks like a host stays a path on the configured origin.
  expect(JSON.parse((await send(probe, '127.0.0.1', '//evil.example/x')).text).url).toBe(`${env.APP_ORIGIN}//evil.example/x`);
  // A request line that names another host is refused.
  expect((await send(probe, '127.0.0.1', 'http://evil.example/x')).status).toBe(400);
});

it('records no country for a visit: Campfile-Client-Country is dropped on the way in and nothing sets it', async () => {
  const { id } = await publishedPage(await addTester('amy'));
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const opened = await send(views, '127.0.0.1', `/${id}/raw`, { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'same-origin', 'Campfile-Client-Country': 'NO', 'User-Agent': chrome });
  expect(opened.status).toBe(200);
  await Promise.allSettled([...pending]); // the visit is counted after the response
  expect(await sql`select opens, country from page_visits`).toEqual([{ opens: 1, country: null }]);
});
