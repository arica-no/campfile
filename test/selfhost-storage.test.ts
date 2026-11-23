// The self-hosted stand-ins for the bucket and the OAuth library's key-value store (selfhost/storage.ts): the parts of both that the code uses.
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthAuthorizationServer } from '@cloudflare/workers-oauth-provider';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileBucket, FileKv } from '../selfhost/storage.ts';
import { CONNECTOR_IDLE_DAYS } from '../src/connector.ts';
import type { AppEnv } from '../src/env.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'campfile-storage-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (body: ReadableStream<Uint8Array>) => new Response(body).text();
/** Every file under the directory: the KV keeps one directory per kind of key, and a directory outlives its last file. */
const files = async () => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

it('stores an object under its key and reads it back with its size and upload time', async () => {
  const bucket = new FileBucket(dir);
  await bucket.put('pages/abc/1.html', bytes('<p>hi</p>'));
  await bucket.put('pages/abc/1.html', bytes('<p>hello</p>')); // the same key again replaces it
  const object = await bucket.get('pages/abc/1.html');
  expect(await text(object!.body)).toBe('<p>hello</p>');
  expect(object).toMatchObject({ size: 12, range: undefined });
  expect(Date.now() - object!.uploaded.getTime()).toBeLessThan(60_000);
  expect(await bucket.get('pages/abc/2.html')).toBeNull();
  expect(await bucket.get('pages/abc')).toBeNull(); // a directory is no object
  expect(await readdir(join(dir, 'pages/abc'))).toEqual(['1.html']); // no temporary file left behind
});

it.each([
  ['bytes=2-4', 'cde', { offset: 2, length: 3 }],
  ['bytes=7-', 'hij', { offset: 7, length: 3 }],
  ['bytes=-3', 'hij', { offset: 7, length: 3 }],
  ['bytes=8-99', 'ij', { offset: 8, length: 2 }],
  ['bytes=0-0', 'a', { offset: 0, length: 1 }],
  ['bytes=20-30', 'abcdefghij', undefined],
  ['bytes=5-2', 'abcdefghij', undefined],
  ['bytes=0-1,3-4', 'abcdefghij', undefined],
  ['items=1-2', 'abcdefghij', undefined],
])('reads Range %s like the bucket does', async (range, expected, resolved) => {
  const bucket = new FileBucket(dir);
  await bucket.put('static/ten.txt', bytes('abcdefghij'));
  const object = await bucket.get('static/ten.txt', { range: new Headers({ Range: range }) });
  expect(await text(object!.body)).toBe(expected);
  expect(object).toMatchObject({ size: 10, range: resolved });
});

it('lists the objects under a prefix, whatever depth, and nothing for a prefix with none', async () => {
  const bucket = new FileBucket(dir);
  expect(await bucket.list({ prefix: '' })).toEqual({ objects: [], truncated: false }); // before anything is stored
  for (const key of ['pages/a/1.html', 'pages/a/2.html', 'pages/b/1.html', 'previews/p/1.jpg', 'static/x.mp4']) await bucket.put(key, bytes('x'));
  const keys = async (prefix: string) => (await bucket.list({ prefix })).objects.map((object) => object.key).sort();
  expect(await keys('pages/')).toEqual(['pages/a/1.html', 'pages/a/2.html', 'pages/b/1.html']);
  expect(await keys('pages/a/')).toEqual(['pages/a/1.html', 'pages/a/2.html']);
  expect(await keys('pages/a/1')).toEqual(['pages/a/1.html']);
  expect(await keys('pages/a')).toEqual(['pages/a/1.html', 'pages/a/2.html']);
  expect(await keys('pages')).toHaveLength(3); // a prefix with no slash lists from the root, not from a directory with a chopped name
  expect(await keys('pa')).toHaveLength(3);
  expect(await keys('previews/')).toEqual(['previews/p/1.jpg']);
  expect(await keys('')).toHaveLength(5);
  expect(await keys('nothing/')).toEqual([]);
  expect((await bucket.list({ prefix: 'static/' })).objects[0].uploaded).toBeInstanceOf(Date);
});

it('deletes one key or several, tolerates keys that are gone, and removes a directory with its last file', async () => {
  const bucket = new FileBucket(dir);
  for (const key of ['pages/a/1.html', 'pages/a/2.html', 'pages/b/1.html']) await bucket.put(key, bytes('x'));
  await bucket.delete('pages/a/1.html');
  expect(await readdir(join(dir, 'pages/a'))).toEqual(['2.html']);
  await bucket.delete(['pages/a/2.html', 'pages/a/2.html', 'pages/c/never.html']);
  expect((await readdir(join(dir, 'pages'))).sort()).toEqual(['b']);
  await bucket.delete([]);
  expect(await bucket.get('pages/b/1.html')).not.toBeNull();
});

it('never leaves its directory, whatever the key says', async () => {
  const bucket = new FileBucket(join(dir, 'files'));
  for (const key of ['../escape.txt', 'pages/../../escape.txt', '/etc/passwd', 'pages//x', 'pages/./x', '', 'pages/']) {
    await expect(bucket.put(key, bytes('x')), key).rejects.toThrow('Not a storage key');
    await expect(bucket.get(key), key).rejects.toThrow('Not a storage key');
    await expect(bucket.delete(key), key).rejects.toThrow('Not a storage key');
  }
  expect(await readdir(dir)).toEqual([]);
});

it('keeps KV entries as text or JSON by how they are read, with any key', async () => {
  const kv = new FileKv(dir);
  const long = `grant:${'x'.repeat(2000)}/../ü:1`;
  await kv.put('grant:user1:abc', JSON.stringify({ a: 1 }));
  await kv.put(long, 'long');
  expect(await kv.get('grant:user1:abc')).toBe('{"a":1}');
  expect(await kv.get('grant:user1:abc', 'text')).toBe('{"a":1}');
  expect(await kv.get('grant:user1:abc', 'json')).toEqual({ a: 1 });
  expect(await kv.get('grant:user1:abc', { type: 'json' })).toEqual({ a: 1 });
  expect(await kv.get(long)).toBe('long');
  expect(await kv.get('grant:user1:nope')).toBeNull();
  await kv.put('grant:user1:abc', 'replaced');
  expect(await kv.get('grant:user1:abc')).toBe('replaced');
  await kv.delete('grant:user1:abc');
  await kv.delete('grant:user1:abc');
  expect(await kv.get('grant:user1:abc')).toBeNull();
});

it('expires entries at their TTL or expiration time, for readers and lists, and deletes them from disk', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const kv = new FileKv(dir);
  await kv.put('ttl', 'a', { expirationTtl: 60 });
  await kv.put('at', 'b', { expiration: Date.now() / 1000 + 120 });
  await kv.put('forever', 'c');
  vi.setSystemTime(Date.now() + 61_000);
  expect(await kv.get('ttl')).toBeNull();
  expect(await files()).toHaveLength(2); // the expired file went when it was read
  expect(await kv.get('at')).toBe('b');
  vi.setSystemTime(Date.now() + 60_000);
  expect((await kv.list()).keys.map((key) => key.name)).toEqual(['forever']);
  expect(await files()).toHaveLength(1);
});

it('purges expired entries nobody asked for, and keeps the rest', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const kv = new FileKv(dir);
  await kv.put('grant:7:gone', 'a', { expirationTtl: 1 });
  await kv.put('token:7:g1:kept', 'b', { expirationTtl: 3600 });
  vi.setSystemTime(Date.now() + 5000);
  await kv.purge();
  expect(await files()).toHaveLength(1);
  expect(await kv.get('token:7:g1:kept')).toBe('b');
  await new FileKv(join(dir, 'not-yet-made')).purge(); // a directory that does not exist yet
});

it('lists by prefix in key order, a page at a time, with each key’s expiration and metadata', async () => {
  const kv = new FileKv(dir);
  expect(await new FileKv(join(dir, 'empty')).list()).toEqual({ keys: [], list_complete: true, cursor: undefined });
  for (const n of [3, 1, 5, 2, 4]) await kv.put(`grant:u1:${n}`, `v${n}`, n === 2 ? { expiration: 4_102_444_800, metadata: { n } } : undefined);
  await kv.put('grant:u2:1', 'other user');
  await kv.put('token:u1:1', 'not a grant');

  const all = await kv.list({ prefix: 'grant:u1:' });
  expect(all.keys.map((key) => key.name)).toEqual(['grant:u1:1', 'grant:u1:2', 'grant:u1:3', 'grant:u1:4', 'grant:u1:5']);
  expect(all).toMatchObject({ list_complete: true, cursor: undefined });
  expect(all.keys[1]).toEqual({ name: 'grant:u1:2', expiration: 4_102_444_800, metadata: { n: 2 } });
  expect((await kv.list()).keys).toHaveLength(7);

  const first = await kv.list({ prefix: 'grant:u1:', limit: 2 });
  expect(first).toMatchObject({ list_complete: false, cursor: 'grant:u1:2' });
  const second = await kv.list({ prefix: 'grant:u1:', limit: 2, cursor: first.cursor });
  expect(second.keys.map((key) => key.name)).toEqual(['grant:u1:3', 'grant:u1:4']);
  const last = await kv.list({ prefix: 'grant:u1:', limit: 2, cursor: second.cursor });
  expect(last).toMatchObject({ list_complete: true, cursor: undefined });
  expect(last.keys.map((key) => key.name)).toEqual(['grant:u1:5']);
});

it('lists a kind of key without opening the files of the others, and more entries than one batch', async () => {
  const kv = new FileKv(dir);
  await Promise.all(Array.from({ length: 130 }, (_, n) => kv.put(`grant:u1:${String(n).padStart(3, '0')}`, 'g')));
  await kv.put('token:u1:1', 't');
  expect((await kv.list({ prefix: 'to' })).keys.map((key) => key.name)).toEqual(['token:u1:1']); // no ':' in the prefix: every kind is searched

  for (const file of await files()) if ((await readFile(file, 'utf8')).includes('token:u1:1')) await writeFile(file, 'not json'); // a token that cannot be read
  const grants = await kv.list({ prefix: 'grant:' });
  expect(grants.keys).toHaveLength(130);
  expect([grants.keys[0].name, grants.keys[129].name]).toEqual(['grant:u1:000', 'grant:u1:129']);
  await expect(kv.list()).rejects.toThrow(); // which is what listing every kind would trip over
});

it('lists the grants and tokens of the user in the prefix from that user’s directory, and 7 is never 70', async () => {
  const kv = new FileKv(dir);
  for (const key of ['grant:7:g1', 'grant:7:g2', 'grant:70:g1', 'token:7:g1:t1', 'token:7:g2:t1', 'token:70:g1:t1', 'client:c1', 'transaction:x']) await kv.put(key, 'v');
  const names = async (prefix: string) => (await kv.list({ prefix })).keys.map((key) => key.name);
  expect(await names('grant:7:')).toEqual(['grant:7:g1', 'grant:7:g2']);
  expect(await names('grant:70:')).toEqual(['grant:70:g1']);
  expect(await names('token:7:g1:')).toEqual(['token:7:g1:t1']);
  expect(await names('token:7:')).toEqual(['token:7:g1:t1', 'token:7:g2:t1']);
  expect(await names('grant:8:')).toEqual([]);
  expect(await names('grant:7')).toEqual(['grant:70:g1', 'grant:7:g1', 'grant:7:g2']); // 70 starts with 7: every user's directory is read
  expect(await names('grant:')).toEqual(['grant:70:g1', 'grant:7:g1', 'grant:7:g2']);
  expect(await names('token:')).toEqual(['token:70:g1:t1', 'token:7:g1:t1', 'token:7:g2:t1']);
  expect(await names('client:')).toEqual(['client:c1']);
  expect(await names('')).toHaveLength(8);
  await kv.delete('grant:7:g1');
  expect(await kv.get('grant:7:g1')).toBeNull();
  expect(await kv.get('grant:70:g1')).toBe('v');
});

it('reads no file of another user when a user’s grants are listed, so a file that cannot be read breaks only the lists that need it', async () => {
  const kv = new FileKv(dir);
  await kv.put('grant:7:g1', 'a');
  await kv.put('grant:70:g1', 'b');
  await kv.put('token:70:g1:t1', 'c');
  for (const file of await files()) if (/"key":"(grant|token):70:/.test(await readFile(file, 'utf8'))) await writeFile(file, 'not json');
  expect((await kv.list({ prefix: 'grant:7:' })).keys.map((key) => key.name)).toEqual(['grant:7:g1']);
  expect(await kv.list({ prefix: 'token:7:' })).toMatchObject({ keys: [], list_complete: true });
  await expect(kv.list({ prefix: 'grant:7' })).rejects.toThrow(); // which could be user 70's
  await expect(kv.list({ prefix: 'grant:' })).rejects.toThrow();
});

it('works under the OAuth library: two users of one app stay apart, a new authorization replaces the grant with its tokens, and a grant nobody refreshes expires', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const idle = CONNECTOR_IDLE_DAYS * 24 * 60 * 60;
  const grantTtl = 30 * 24 * 60 * 60; // the library's default refreshTokenTTL: a grant has it from the trade of the code until the first refresh
  const kv = new FileKv(dir);
  const issuer = 'https://auth.test';
  const resource = `${issuer}/mcp`;
  const server = new OAuthAuthorizationServer<AppEnv>({ issuer, resources: [resource], refreshTokenIdleTTL: idle });
  const env = { OAUTH_KV: kv } as unknown as AppEnv;
  const api = server.getOAuthApi(env);
  const redirectUri = 'https://claude.test/callback';
  const { clientId } = await api.createClient({ redirectUris: [redirectUri], clientName: 'Claude', tokenEndpointAuthMethod: 'none' });
  const verifier = 'x'.repeat(43);

  /** What the app does for a signed-in user: authorize, then trade the code for tokens, as Claude does. Returns the access token. */
  async function connect(userId: string) {
    const { redirectTo } = await api.completeAuthorization({
      request: { responseType: 'code', clientId, redirectUri, scope: [], state: 's', codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256', resource },
      userId,
      metadata: {},
      scope: [],
      props: { tester: Number(userId) },
    });
    const form = { grant_type: 'authorization_code', code: new URL(redirectTo).searchParams.get('code')!, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource };
    const answer = await server.fetch(new Request(`${issuer}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }), env, { waitUntil() {}, passThroughOnException() {}, props: {} });
    expect(answer.status).toBe(200);
    const tokens = (await answer.json()) as { access_token: string }; // the library's token response
    return tokens.access_token;
  }
  const grantsOf = async (userId: string) => (await api.listUserGrants(userId)).items.map((grant) => grant.id);
  const valid = async (token: string) => (await server.validateToken(resource, token, env)) !== null;

  const [seven, seventy] = [await connect('7'), await connect('70')];
  const [first] = await grantsOf('7');
  expect([(await grantsOf('7')).length, (await grantsOf('70')).length]).toEqual([1, 1]);
  expect([await valid(seven), await valid(seventy)]).toEqual([true, true]);
  expect((await kv.list({ prefix: 'grant:7:' })).keys[0].expiration).toBe(Date.now() / 1000 + grantTtl);

  for (const file of await files()) if (/"key":"(grant|token):70:/.test(await readFile(file, 'utf8'))) await writeFile(file, 'not json'); // nothing of user 7's may need a file of user 70's
  const again = await connect('7');
  const grants = await grantsOf('7');
  expect(grants).toHaveLength(1);
  expect(grants[0]).not.toBe(first);
  expect([await valid(seven), await valid(again)]).toEqual([false, true]);
  expect((await kv.list({ prefix: 'token:7:' })).keys).toHaveLength(1);

  vi.setSystemTime(Date.now() + (grantTtl + 60) * 1000);
  expect((await kv.list({ prefix: 'grant:7:' })).keys).toEqual([]); // nobody refreshed it
});
