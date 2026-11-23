// What keeps one client from using the self-hosted server up: a request body is read whole, within a size cap, a deadline and one memory budget for all uploads, and the requests in progress are capped (selfhost/http.ts); /oauth/register is rationed (selfhost/limit.ts).
import { once } from 'node:events';
import { Agent, request, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { newContext, serve, trustedProxies, type Budget, type Slots } from '../selfhost/http.ts';
import { limitPosts, type Handler, type PostLimit } from '../selfhost/limit.ts';
import { senderKey } from '../src/signin.ts';

// The app answers with the size of its body, which it can only know when the body was read whole.
const handler = async (req: Request) => Response.json({ size: (await req.arrayBuffer()).byteLength });
const tightBudget: Budget = { free: 1000 };
const quickBudget: Budget = { free: 1000 };
const make = (extra: { budget?: Budget; slots?: Slots; bodyTimeout?: number; backgroundTimeout?: number; handler?: Handler } = {}) => serve({ origin: 'https://app.test', trusted: trustedProxies(''), handler, ...extra });
const roomy = make(); // the real caps and the real budget
const tight = make({ budget: tightBudget });
const quick = make({ budget: quickBudget, bodyTimeout: 150 });
// Room for two requests at a time, and an app that answers when the test lets it.
const crowdedBudget: Budget = { free: 1000 };
const crowdedSlots: Slots = { used: 0, max: 2 };
let letGo = Promise.withResolvers<void>();
const crowded = make({
  budget: crowdedBudget,
  slots: crowdedSlots,
  handler: async () => {
    await letGo.promise;
    return new Response('ok');
  },
});
const brokenBudget: Budget = { free: 1000 };
const brokenSlots: Slots = { used: 0, max: 1 };
const broken = make({
  budget: brokenBudget,
  slots: brokenSlots,
  handler: () => {
    throw new Error('the app broke');
  },
});
const servers = [roomy, tight, quick, crowded, broken];
const agent = new Agent({ keepAlive: true }); // like a browser or Caddy: after an early answer the connection stays open while the sender goes on

beforeAll(async () => {
  for (const server of servers) server.listen(0, '127.0.0.1');
  await Promise.all(servers.map((server) => once(server, 'listening')));
});
afterAll(() => {
  agent.destroy();
  return Promise.all(
    servers.map((server) => {
      server.close();
      server.closeAllConnections();
      return once(server, 'close');
    }),
  );
});
afterEach(() => void vi.useRealTimers());

/** A POST that stays open until the test ends it: its Content-Length is in `headers`, or its body is chunked. */
function upload(server: Server, path: string, headers: Record<string, string> = {}) {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; headers: IncomingHttpHeaders; text: string }>();
  const sent = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, agent, method: 'POST', headers }, (res) => {
    let text = '';
    res.setEncoding('utf8').on('data', (chunk) => (text += chunk)).on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
  });
  sent.on('error', reject);
  promise.catch(() => {}); // a test that cuts the connection itself does not wait for the answer
  return { sent, done: promise };
}
const post = (server: Server, path: string, body: Buffer | string) => {
  const { sent, done } = upload(server, path);
  sent.end(body);
  return done;
};

const KIB = 1024;
it('answers 413 to a body over the cap: 64 KiB under /oauth/ and 32 MiB elsewhere, by its Content-Length or by the bytes that came', async () => {
  expect((await post(roomy, '/oauth/token', Buffer.alloc(64 * KIB))).status).toBe(200);
  expect((await post(roomy, '/oauth/token', Buffer.alloc(64 * KIB + 1))).status).toBe(413);
  expect((await post(roomy, '/api/pages', Buffer.alloc(64 * KIB + 1))).text).toBe('{"size":65537}'); // everything else takes more
  const declared = upload(roomy, '/api/pages', { 'Content-Length': String(32 * KIB * KIB + 1) });
  declared.sent.flushHeaders(); // the answer comes before a byte of the body
  expect((await declared.done).status).toBe(413);
  declared.sent.destroy();
});

it('answers 413 to a chunked body that grows past the cap, and the sender gets the answer, not a reset', async () => {
  const { sent, done } = upload(roomy, '/oauth/register');
  for (let n = 0; n < 5; n++) sent.write(Buffer.alloc(20_000)); // no Content-Length to check: the server counts
  sent.end();
  expect((await done).status).toBe(413);
  expect((await post(roomy, '/oauth/register', '{}')).status).toBe(200);
});

it('takes memory as the bytes come, not as Content-Length declares them, and answers 503 with Retry-After to a body that does not fit', async () => {
  const held = upload(tight, '/api/pages', { 'Content-Length': '600' });
  held.sent.write(Buffer.alloc(100));
  await vi.waitFor(() => expect(tightBudget.free).toBe(900)); // 100 have come; the 500 still to come hold nothing

  const refused = await post(tight, '/api/pages', Buffer.alloc(950));
  expect([refused.status, refused.headers['retry-after']]).toEqual([503, '10']);
  expect((await post(tight, '/api/pages', Buffer.alloc(900))).status).toBe(200); // all that is left

  held.sent.end(Buffer.alloc(500));
  expect(JSON.parse((await held.done).text)).toEqual({ size: 600 });
  await vi.waitFor(() => expect(tightBudget.free).toBe(1000));
});

it('lets requests that only declare a big body hold nothing, so they cannot starve the others', async () => {
  const arrived = vi.fn();
  tight.on('request', arrived);
  const mute = Array.from({ length: 3 }, () => upload(tight, '/api/pages', { 'Content-Length': '900' })); // 2700 declared, 1000 in the budget, not a byte sent
  for (const { sent } of mute) sent.flushHeaders();
  await vi.waitFor(() => expect(arrived).toHaveBeenCalledTimes(3));
  tight.off('request', arrived);

  expect(tightBudget.free).toBe(1000);
  expect((await post(tight, '/api/pages', Buffer.alloc(1))).status).toBe(200);
  for (const { sent } of mute) sent.destroy();
  await vi.waitFor(() => expect(tightBudget.free).toBe(1000));
});

it('gives the budget back the moment an upload is refused, not when its sender stops', async () => {
  const refused = upload(tight, '/api/pages');
  refused.sent.write(Buffer.alloc(700));
  await vi.waitFor(() => expect(tightBudget.free).toBe(300));
  refused.sent.write(Buffer.alloc(400)); // does not fit
  expect((await refused.done).status).toBe(503);
  expect(tightBudget.free).toBe(1000); // and the sender is still at it
  refused.sent.destroy();
});

it('stops reading a refused upload when its client leaves, instead of waiting for the deadline', async () => {
  let reading: IncomingMessage | undefined;
  tight.once('request', (req) => void (reading = req));
  const refused = upload(tight, '/api/pages');
  refused.sent.write(Buffer.alloc(1001)); // more than the whole budget
  expect((await refused.done).status).toBe(503);
  refused.sent.destroy();
  await vi.waitFor(() => expect(reading?.destroyed).toBe(true)); // the deadline of `tight` is 30 s, vi.waitFor gives up after 1 s
});

it('decides the cap under /oauth/ from the path the app gets, so a dot segment changes nothing: 8 KiB for /oauth/register, 64 KiB for the rest', async () => {
  for (const path of ['/oauth/register', '/./oauth/register', '/x/../oauth/register', '/%2e/oauth/register']) {
    expect((await post(roomy, path, Buffer.alloc(8 * KIB + 1))).status, path).toBe(413);
    expect((await post(roomy, path, Buffer.alloc(8 * KIB))).status, path).toBe(200);
  }
  expect((await post(roomy, '/oauth/token', Buffer.alloc(8 * KIB + 1))).status).toBe(200); // only registering stores what it is sent
  expect((await post(roomy, '/oauth/../api/pages', Buffer.alloc(64 * KIB + 1))).status).toBe(200); // that is /api/pages, which takes more
});

it('works on at most `max` requests at once, answers 503 with Retry-After to the next, and takes the slots back', async () => {
  letGo = Promise.withResolvers<void>();
  const working = [post(crowded, '/api/pages', '{}'), post(crowded, '/api/pages', '{}')];
  await vi.waitFor(() => expect(crowdedSlots.used).toBe(2));

  const refused = await post(crowded, '/api/pages', '{}');
  expect([refused.status, refused.headers['retry-after']]).toEqual([503, '5']);

  letGo.resolve();
  expect((await Promise.all(working)).map((answer) => answer.status)).toEqual([200, 200]);
  await vi.waitFor(() => expect([crowdedSlots.used, crowdedBudget.free]).toEqual([0, 1000]));
  expect((await post(crowded, '/api/pages', '{}')).status).toBe(200); // there is room again
});

it('gives back its slot and its bytes when the app throws', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {}); // selfhost/http.ts logs what the app throws
  try {
    expect((await post(broken, '/api/pages', Buffer.alloc(300))).status).toBe(500);
    await vi.waitFor(() => expect([brokenSlots.used, brokenBudget.free]).toEqual([0, 1000]));
    expect((await post(broken, '/api/pages', Buffer.alloc(300))).status).toBe(500); // with room for one, a slot that stayed taken would answer 503
  } finally {
    logged.mockRestore();
  }
});

it('keeps its slot while the app works in the background, because that holds the database connection, and answers 503 to the next', async () => {
  const budget: Budget = { free: 1000 };
  const slots: Slots = { used: 0, max: 1 };
  const background = Promise.withResolvers<void>();
  const server = make({
    budget,
    slots,
    handler: async (_req, ctx) => {
      ctx.waitUntil(background.promise);
      return new Response('ok');
    },
  });
  servers.push(server); // afterAll closes it
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  expect((await post(server, '/api/pages', '{}')).status).toBe(200); // answered, the background work goes on
  expect(slots.used).toBe(1);
  const refused = await post(server, '/api/pages', '{}');
  expect([refused.status, refused.headers['retry-after']]).toEqual([503, '5']);

  background.resolve();
  await vi.waitFor(() => expect(slots.used).toBe(0));
  expect((await post(server, '/api/pages', '{}')).status).toBe(200);
});

it('gives its slot back after `backgroundTimeout` when the background work never settles', async () => {
  const slots: Slots = { used: 0, max: 1 };
  const server = make({
    slots,
    backgroundTimeout: 300,
    handler: async (_req, ctx) => {
      ctx.waitUntil(new Promise(() => {})); // never settles
      return new Response('ok');
    },
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  expect((await post(server, '/api/pages', '{}')).status).toBe(200);
  expect(slots.used).toBe(1);
  await vi.waitFor(() => expect(slots.used).toBe(0));
  expect((await post(server, '/api/pages', '{}')).status).toBe(200); // not 503
});

it('cuts off a client that does not read the answer to its upload in time, and gives its bytes back', async () => {
  const budget: Budget = { free: 1000 };
  const slow = make({ budget, bodyTimeout: 150, handler: async (req) => new Response(Buffer.alloc((await req.arrayBuffer()).byteLength + 64 * 2 ** 20)) });
  servers.push(slow);
  slow.listen(0, '127.0.0.1');
  await once(slow, 'listening');
  const socket = connect((slow.address() as AddressInfo).port, '127.0.0.1').pause(); // never reads
  socket.on('error', () => {}).write(`POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 900\r\n\r\n${'x'.repeat(900)}`);
  await vi.waitFor(() => expect(budget.free).toBe(100)); // the answer is being written, the upload still counts
  await vi.waitFor(() => expect(budget.free).toBe(1000));
  socket.destroy();
});

it('gives the answer to a request without a body no deadline: a slow download is not cut off', async () => {
  const slow = make({ bodyTimeout: 150, handler: () => new Response(Buffer.alloc(64 * 2 ** 20)) });
  servers.push(slow);
  slow.listen(0, '127.0.0.1');
  await once(slow, 'listening');
  const socket = connect((slow.address() as AddressInfo).port, '127.0.0.1').pause(); // reads nothing at first
  let got = 0;
  socket.on('error', () => {}).on('data', (chunk) => (got += chunk.length)).write('GET /file HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  await new Promise((resolve) => setTimeout(resolve, 600)); // four deadlines of an upload
  socket.resume();
  await once(socket, 'close');
  expect(got).toBeGreaterThan(64 * 2 ** 20); // the whole answer came
});

it('takes chunked uploads out of the budget chunk by chunk: past it, 503 while the others go on, and every charge comes back', async () => {
  const [a, b, c] = [upload(tight, '/api/pages'), upload(tight, '/api/pages'), upload(tight, '/api/pages')];
  a.sent.write(Buffer.alloc(400));
  b.sent.write(Buffer.alloc(400));
  await vi.waitFor(() => expect(tightBudget.free).toBe(200));
  c.sent.write(Buffer.alloc(400)); // does not fit
  const refused = await c.done;
  expect([refused.status, refused.headers['retry-after']]).toEqual([503, '10']);
  c.sent.end();
  for (const open of [a, b]) {
    open.sent.end();
    expect(JSON.parse((await open.done).text)).toEqual({ size: 400 });
  }
  await vi.waitFor(() => expect(tightBudget.free).toBe(1000));
  expect((await post(tight, '/api/pages', Buffer.alloc(900))).status).toBe(200); // a normal request still works, and finds all of the budget
});

it('gives the bytes back when the client leaves in the middle of its body', async () => {
  const leaving = upload(tight, '/api/pages', { 'Content-Length': '600' });
  leaving.sent.write(Buffer.alloc(100));
  await vi.waitFor(() => expect(tightBudget.free).toBe(900));
  leaving.sent.destroy();
  await vi.waitFor(() => expect(tightBudget.free).toBe(1000));
});

it('cuts off a client that does not finish its body in time, and gives its bytes back', async () => {
  const slow = upload(quick, '/api/pages', { 'Content-Length': '600' });
  slow.sent.write(Buffer.alloc(100)); // the other 500 bytes never come
  await expect(slow.done).rejects.toThrow(); // the server closed the connection
  await vi.waitFor(() => expect(quickBudget.free).toBe(1000));
});

it('is back to normal the moment a flood of slow chunked uploads is over, with uploads refused while they held bytes and others cut off', async () => {
  const flood = Array.from({ length: 10 }, () => upload(tight, '/api/pages'));
  const answers: number[] = [];
  for (const { done } of flood) done.then((answer) => answers.push(answer.status), () => {});
  for (const { sent } of flood) sent.write(Buffer.alloc(150)); // 1500 against a budget of 1000: six fit, four are refused at once
  await vi.waitFor(() => expect(answers).toEqual([503, 503, 503, 503]));
  expect(tightBudget.free).toBe(100);
  for (const { sent } of flood) sent.write(Buffer.alloc(150)); // the six that fit hold 900 and their next chunk does not: refused while holding bytes
  await vi.waitFor(() => expect(answers.length).toBeGreaterThan(4));
  for (const { sent } of flood) sent.destroy(); // the flood is over, and the rest are cut off
  await vi.waitFor(async () => expect((await post(tight, '/api/pages', Buffer.alloc(900))).status).toBe(200)); // served at once, not after the 30 s deadline that the leak waited for
  await vi.waitFor(() => expect(tightBudget.free).toBe(1000));
});

// /oauth/register: no sign-in, and each call writes an entry that lives 90 days.
const register = (limited: Handler, ip: string, path = '/oauth/register', method = 'POST') => Promise.resolve(limited(new Request(`https://app.test${path}`, { method, headers: { 'Campfile-Client-IP': ip } }), newContext()));
const hour = 60 * 60 * 1000;
const rule: PostLimit = { path: '/oauth/register', perClient: 20, total: 500, windowMs: hour, keyOf: (ip) => ip };

it('lets one address POST to /oauth/register 20 times an hour, then answers 429 with the seconds to wait', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const app = vi.fn(() => new Response('ok'));
  const limited = limitPosts(app, rule);
  for (let n = 1; n <= 20; n++) expect((await register(limited, '203.0.113.1')).status, `call ${n}`).toBe(200);
  const over = await register(limited, '203.0.113.1');
  expect([over.status, over.headers.get('Retry-After')]).toEqual([429, '3600']);
  vi.setSystemTime(Date.now() + 30 * 60 * 1000);
  expect((await register(limited, '203.0.113.1')).headers.get('Retry-After')).toBe('1800');
  expect(app).toHaveBeenCalledTimes(20);

  expect((await register(limited, '203.0.113.2')).status).toBe(200); // another address has its own count
  expect((await register(limited, '203.0.113.1', '/oauth/register', 'GET')).status).toBe(200); // a GET is not a registration
  expect((await register(limited, '203.0.113.1', '/oauth/token')).status).toBe(200);

  vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1);
  expect((await register(limited, '203.0.113.1')).status).toBe(200); // the hour is over
});

it('counts an IPv6 address by its /64, like the limits of the app, so a whole prefix is one client', async () => {
  const limited = limitPosts(() => new Response('ok'), { ...rule, perClient: 2, keyOf: senderKey });
  expect((await register(limited, '2001:db8:1:2::1')).status).toBe(200);
  expect((await register(limited, '2001:db8:1:2:aaaa:bbbb:cccc:dddd')).status).toBe(200);
  expect((await register(limited, '2001:db8:1:2::3')).status).toBe(429); // the same /64
  expect((await register(limited, '2001:db8:1:3::1')).status).toBe(200); // the next /64 is another client
  expect((await register(limited, '203.0.113.1')).status).toBe(200); // IPv4 as it is
});

it('stops every POST once all clients together have made `total` in an hour, and counts only the POSTs it let through', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const app = vi.fn(() => new Response('ok'));
  const limited = limitPosts(app, { ...rule, perClient: 2, total: 5 });
  for (let n = 0; n < 4; n++) await register(limited, 'a'); // 2 get through; the 2 that its own limit refused use up nothing of the 5
  vi.setSystemTime(Date.now() + 40 * 60 * 1000);
  for (const ip of ['b', 'b', 'c']) expect((await register(limited, ip)).status, ip).toBe(200); // the 5th
  vi.setSystemTime(Date.now() + 10 * 60 * 1000);
  const over = await register(limited, 'c'); // far from its own limit, but the total is spent
  expect([over.status, over.headers.get('Retry-After')]).toEqual([429, '600']); // the seconds until the hour of the first POST ends
  expect((await register(limited, 'd')).status).toBe(429);
  expect(app).toHaveBeenCalledTimes(5);

  vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
  expect((await register(limited, 'd')).status).toBe(200); // that hour is over
});

it('forgets the oldest addresses past `keep`, so a flood of addresses cannot fill the memory', async () => {
  const limited = limitPosts(() => new Response('ok'), { ...rule, perClient: 1, keep: 2 });
  expect((await register(limited, 'a')).status).toBe(200);
  expect((await register(limited, 'a')).status).toBe(429);
  await register(limited, 'b');
  await register(limited, 'c'); // 'a' is the oldest of three, so it goes
  expect((await register(limited, 'a')).status).toBe(200); // counted afresh
});
