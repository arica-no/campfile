// What a self-hosted server may fetch (selfhost/outbound.ts): public addresses only. The tests use a CANARY, a server on this machine that counts the connections it accepts: a request counts as refused only when the canary saw nothing.
import type * as Dns from 'node:dns';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardedFetch, guardOutbound, isPublic, resolveHosts } from '../selfhost/outbound.ts';

// Two names with two addresses each, one the tests count as public (127.0.0.2) and one not (127.0.0.1). No name on this machine has both, and a name that does is how an attacker gets a check of one address followed by a connection to the other.
// own.test is the server's own name (resolveHosts) and gone.test has no address.
vi.mock('node:dns', async (importOriginal) => {
  const real = await importOriginal<typeof Dns>();
  const names: Record<string, string[]> = { 'public-first.test': ['127.0.0.2', '127.0.0.1'], 'public-last.test': ['127.0.0.1', '127.0.0.2'], 'own.test': ['127.0.0.2'], 'gone.test': [] };
  const lookup = (host: string, options: Dns.LookupAllOptions, callback: (error: Error | null, addresses: Dns.LookupAddress[]) => void) =>
    host in names ? callback(names[host].length ? null : new Error(`getaddrinfo ENOTFOUND ${host}`), names[host].map((address) => ({ address, family: 4 }))) : real.lookup(host, options, callback);
  return { ...real, lookup, default: { ...real, lookup } };
});

let connections = 0;
const canary = createTcpServer((socket) => {
  connections++;
  socket.destroy();
});
// '::' takes IPv4 and IPv6 on one port, so 127.0.0.1, localhost and [::1] all end up at the canary. A machine without IPv6 has only 127.0.0.1.
const ipv6 = await once(canary.listen(0, '::'), 'listening').then(() => true, () => false);
if (!ipv6) await once(canary.listen(0, '127.0.0.1'), 'listening');
const { port } = canary.address() as AddressInfo;

// `home` is an origin of ours on loopback, like the app of a local install. `away` plays an attacker's server at a public address, which the tests say 127.0.0.2 is (every 127.x.x.x is this machine on Linux, not on macOS).
const seen: string[] = [];
const route = (status: number, headers: Record<string, string> = {}, body?: string | Buffer) => (res: ServerResponse) => void res.writeHead(status, headers).end(body);
const routes: Record<string, (res: ServerResponse) => void> = {
  '/hello': route(200, { 'Content-Type': 'text/html', 'X-Hello': 'yes' }, 'hello'),
  '/gzip': route(200, { 'Content-Encoding': 'gzip' }, gzipSync('zipped')),
  '/to-ip': route(302, { Location: `http://127.0.0.1:${port}/` }),
  '/to-name': route(302, { Location: `http://localhost:${port}/` }),
  '/to-hello': route(302, { Location: '/hello' }),
  '/forever': route(302, { Location: '/forever' }),
  '/to-home': (res) => route(302, { Location: `${homeOrigin}/hello` })(res),
  '/hang': () => {},
  '/stall': (res) => void res.write('begin'), // the headers and a first chunk, then nothing
};
const serve = (name: string) =>
  createServer((req, res) => {
    seen.push(`${name} ${req.method} ${req.url}`);
    (routes[req.url ?? ''] ?? route(404))(res);
  });
const home = serve('home');
const away = serve('away');
await once(home.listen(0, '127.0.0.1'), 'listening');
const hasAway = await once(away.listen(0, '127.0.0.2'), 'listening').then(() => true, () => false);
const homeOrigin = `http://127.0.0.1:${(home.address() as AddressInfo).port}`;
const awayOrigin = `http://127.0.0.2:${hasAway ? (away.address() as AddressInfo).port : 0}`;
routes['/bounce'] = route(302, { Location: `http://127.0.0.1:${port}/` }); // an open redirect of ours, like /authorize to an app's registered address

const guard = guardedFetch({ allow: [homeOrigin], isPublic: (address) => address === '127.0.0.2' || isPublic(address) });

beforeEach(() => {
  connections = 0;
  seen.length = 0;
});
afterAll(() => {
  for (const server of [home, away]) {
    server.closeAllConnections();
    server.close();
  }
  canary.close();
});

/** The request fails the way a fetch with no answer does, and the cause names the address that was refused. */
const refused = (request: Promise<unknown>, cause: string | RegExp) => expect(request).rejects.toMatchObject({ name: 'TypeError', message: 'fetch failed', cause: { message: expect.stringMatching(cause) } });
/** The canary saw nothing, not even a connection cut at once: the kernel hands those to the canary a moment later. */
const silent = async () => {
  await sleep(50);
  expect(connections).toBe(0);
};

it('sees a connection when the request is allowed, which is what makes the zeros below mean something', async () => {
  await guardedFetch({ allow: [`http://127.0.0.1:${port}`] })(`http://127.0.0.1:${port}/`).catch(() => {}); // the canary answers nothing
  await sleep(50);
  expect(connections).toBe(1);
});

const direct: [string, string, string | RegExp][] = [
  ['an IPv4 address', `http://127.0.0.1:${port}/`, '127.0.0.1'],
  ['localhost', `http://localhost:${port}/`, /127\.0\.0\.1|::1/],
  ['localhost over https', `https://localhost:${port}/`, /127\.0\.0\.1|::1/],
  ['an IPv4-mapped IPv6 address', `http://[::ffff:127.0.0.1]:${port}/`, '::ffff:7f00:1'],
  ['an address in decimal', `http://2130706433:${port}/`, '127.0.0.1'],
  ['an address in hex', `http://0x7f.1:${port}/`, '127.0.0.1'],
  ['0.0.0.0, which is this machine too', `http://0.0.0.0:${port}/`, '0.0.0.0'],
];
if (ipv6) direct.push(['an IPv6 address', `http://[::1]:${port}/`, '::1']);
it.each(direct)('refuses %s: the canary sees no connection', async (_, url, address) => {
  await refused(guard(url), address);
  await silent();
});

it('refuses the metadata address of the clouds without connecting to it', async () => {
  await refused(guard('http://169.254.169.254/latest/meta-data/', { signal: AbortSignal.timeout(3000) }), '169.254.169.254'); // a connect attempt would time out instead
});

it('fetches only over http and https', async () => {
  await refused(guard('ftp://example.com/file'), 'ftp:');
  await refused(guard('file:///etc/hostname'), 'file:');
});

it('reaches an origin of ours on loopback, with POST too', async () => {
  expect(await (await guard(`${homeOrigin}/hello`)).text()).toBe('hello');
  expect((await guard(`${homeOrigin}/hello`, { method: 'POST', body: 'x' })).status).toBe(200);
  expect(seen).toEqual(['home GET /hello', 'home POST /hello']);
});

it('does not follow a redirect of an origin of ours into the network', async () => {
  const bounced = await guard(`${homeOrigin}/bounce`, { redirect: 'manual' });
  expect([bounced.status, bounced.headers.get('location')]).toEqual([302, `http://127.0.0.1:${port}/`]);
  await refused(guard(`${homeOrigin}/bounce`), '127.0.0.1');
  await silent();
});

it('does not follow a redirect of an origin of ours for a POST either', async () => {
  await expect(guard(`${homeOrigin}/bounce`, { method: 'POST', body: 'x' })).rejects.toMatchObject({ name: 'TypeError', message: 'fetch failed' });
  expect(seen).toEqual(['home POST /bounce']); // the first hop was made, the second was not
  await silent();
});

it('resolves a name through its own lookup and reaches it when every address it has is accepted', async () => {
  const open = guardedFetch({ allow: [], isPublic: () => true });
  expect(await (await open(`http://localhost:${new URL(homeOrigin).port}/hello`)).text()).toBe('hello');
});

it('replaces the global fetch', async () => {
  const plain = globalThis.fetch;
  guardOutbound({ allow: [] });
  try {
    expect(globalThis.fetch).not.toBe(plain);
    await refused(fetch(`http://127.0.0.1:${port}/`), '127.0.0.1');
    await silent();
  } finally {
    globalThis.fetch = plain;
  }
});

it('resolves the names of the origins to the addresses that are the server’s own, and warns about a name that has none', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await resolveHosts(['https://own.test', 'https://gone.test', 'http://[::1]:8788', 'http://127.0.0.1:8787'])).toEqual(['127.0.0.2', '::1', '127.0.0.1']);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

// Another port at the server's own public address is the operator's own network, which `source_url` must not reach through the server's public name.
it('refuses an address of the server itself although it is public, by number or by name, and still reaches the origins it allows', async () => {
  const itself = guardedFetch({ allow: [homeOrigin], ownAddresses: ['127.0.0.2'], isPublic: (address) => address === '127.0.0.2' || isPublic(address) });
  await refused(itself(`http://127.0.0.2:${port}/`), '127.0.0.2');
  await refused(itself(`http://own.test:${port}/`), '127.0.0.2');
  await silent();
  expect(await (await itself(`${homeOrigin}/hello`)).text()).toBe('hello');
});

describe.skipIf(!hasAway)('against a public server', () => {
  it.each(['/to-ip', '/to-name'])('does not follow its redirect %s to the canary', async (path) => {
    await refused(guard(`${awayOrigin}${path}`), /127\.0\.0\.1|::1/);
    expect(seen).toEqual([`away GET ${path}`]); // the first hop was made, the second was not
    await silent();
  });

  it.each(['public-first.test', 'public-last.test'])('refuses the name %s, which has a private address too, whichever address comes first', async (name) => {
    await refused(guard(`http://${name}:${new URL(awayOrigin).port}/hello`), '127.0.0.1');
    expect(seen).toEqual([]);
    await silent();
  });

  it('returns the status, the headers and the body of its answer', async () => {
    const response = await guard(`${awayOrigin}/hello`, { headers: { Accept: 'text/html' } });
    expect([response.status, response.ok, response.headers.get('x-hello'), response.headers.get('content-type')]).toEqual([200, true, 'yes', 'text/html']);
    expect(await response.text()).toBe('hello');
    expect((await guard(`${awayOrigin}/missing`)).status).toBe(404);
  });

  it('answers a HEAD without a body, and decodes a gzipped body', async () => {
    const head = await guard(`${awayOrigin}/hello`, { method: 'HEAD' });
    expect([head.status, head.headers.get('x-hello'), head.body]).toEqual([200, 'yes', null]);
    expect(await (await guard(`${awayOrigin}/gzip`)).text()).toBe('zipped');
  });

  it('follows its redirects, also into an origin of ours, and gives up after 20', async () => {
    expect(await (await guard(`${awayOrigin}/to-hello`)).text()).toBe('hello');
    expect(await (await guard(`${awayOrigin}/to-home`)).text()).toBe('hello');
    seen.length = 0;
    await expect(guard(`${awayOrigin}/forever`)).rejects.toMatchObject({ message: 'fetch failed', cause: { message: 'it redirected more than 20 times' } });
    expect(seen).toHaveLength(21);
  });

  it('hands a redirect back untouched with redirect "manual", and refuses it with "error"', async () => {
    const response = await guard(`${awayOrigin}/to-ip`, { redirect: 'manual' });
    expect([response.status, response.headers.get('location')]).toEqual([302, `http://127.0.0.1:${port}/`]);
    await expect(guard(`${awayOrigin}/to-hello`, { redirect: 'error' })).rejects.toMatchObject({ name: 'TypeError', message: 'fetch failed' });
    await silent();
  });

  it('sends only GET and HEAD: a POST is refused before it leaves', async () => {
    await refused(guard(`${awayOrigin}/hello`, { method: 'POST', body: 'x' }), 'POST');
    expect(seen).toEqual([]);
  });

  it('ends with the reason of an abort, which is how src/pages.ts tells a timeout from other failures', async () => {
    await expect(guard(`${awayOrigin}/hang`, { signal: AbortSignal.timeout(100) })).rejects.toMatchObject({ name: 'TimeoutError' });
    const stalled = await guard(`${awayOrigin}/stall`, { signal: AbortSignal.timeout(200) });
    await expect(stalled.text()).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

const addresses: [string, boolean][] = [
  ...['0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.255', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.7', '224.0.0.1', '240.0.0.1', '255.255.255.255'].map((address): [string, boolean] => [address, false]),
  ...['100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.169.0.1', '198.17.255.255', '198.20.0.1', '8.8.8.8', '93.184.216.34'].map((address): [string, boolean] => [address, true]),
  ...['::', '::1', '::808:808', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', '64:ff9b::7f00:1', '64:ff9b:1::1', '100::1', '2001::1', '2001:db8::1', '2002::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1'].map((address): [string, boolean] => [address, false]),
  ...['::ffff:8.8.8.8', '2001:4860:4860::8888', '2606:4700:4700::1111', '2a00:1450:4001::'].map((address): [string, boolean] => [address, true]),
  ...['localhost', '', '127.0.0.1.5'].map((address): [string, boolean] => [address, false]), // not addresses at all
];
it.each(addresses)('judges %s: public is %s', (address, expected) => {
  expect(isPublic(address)).toBe(expected);
});
