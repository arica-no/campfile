import postgres from 'postgres';
import { expect, it } from 'vitest';
import { sha256Hex } from '../src/keys.ts';
import { arrive, arriveAi, authorName, clearTree, countryOf, deviceOf, hasEntry, SHARE_CAP, shareTree, validCode } from '../src/sharing.ts';
import { addTester, api, createPage, sql, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

const page = async (owner = 'amy') => (await createPage(await addTester(owner))).id as string;
const key = (name: string) => name.padEnd(22, '0');
const reader = (id: string, name: string, via: string | null = null, label: string | null = null) =>
  arrive(sql, { page: id, via, key: key(name), label, country: null, device: null });
const own = async (id: string, name: string, via: string | null = null) => (await reader(id, name, via)).code as string;
const links = async (id: string) =>
  sql<{ code: string; parent: string | null; label: string | null; ai: string | null }[]>`select code, parent, label, ai from share_links where page = ${id} order by created_at, code`;

it('gives a browser one entry for its key, whichever link it comes back through', async () => {
  const id = await page();
  const first = await arrive(sql, { page: id, via: null, key: key('anna'), label: ' Anna@Example.COM ', country: 'DE', device: 'phone' });
  expect(first).toEqual({ code: expect.stringMatching(/^[A-Za-z0-9]{4}$/), created: true });
  const bob = await own(id, 'bob');
  expect(await arrive(sql, { page: id, via: bob, key: key('anna'), label: 'other@example.com', country: 'FR', device: 'computer' })).toEqual({ code: first.code, created: false });
  // Parallel loads of one new browser still make one entry.
  const pool = postgres(process.env.DATABASE_URL ?? '', { max: 10 });
  const loads = await Promise.all(Array.from({ length: 10 }, () => arrive(pool, { page: id, via: first.code, key: key('cleo'), label: null, country: null, device: null })));
  await pool.end();
  const cleo = loads[0].code;
  expect(new Set(loads.map((load) => load.code))).toEqual(new Set([cleo]));
  expect(loads.filter((load) => load.created)).toHaveLength(1);
  expect(await sql`select code, parent, key_hash, label, country, device from share_links where page = ${id} order by created_at`).toEqual([
    { code: first.code, parent: null, key_hash: await sha256Hex(key('anna')), label: 'anna@example.com', country: 'DE', device: 'phone' },
    { code: bob, parent: null, key_hash: await sha256Hex(key('bob')), label: null, country: null, device: null },
    { code: cleo, parent: first.code, key_hash: await sha256Hex(key('cleo')), label: null, country: null, device: null },
  ]);
  expect(await hasEntry(sql, id, key('anna'))).toBe(true);
  expect(await hasEntry(sql, id, key('dora'))).toBe(false);
  expect(await hasEntry(sql, await page('bob'), key('anna'))).toBe(false);
});

it('draws another code when the drawn one is taken on the page', async () => {
  const id = await page();
  expect(await arrive(sql, { page: id, via: null, key: key('a'), label: null, country: null, device: null }, () => 'AAAA')).toEqual({ code: 'AAAA', created: true });
  const draws = ['AAAA', 'AAAA', 'BBBB'];
  expect(await arrive(sql, { page: id, via: 'AAAA', key: key('b'), label: null, country: null, device: null }, () => draws.shift() as string)).toEqual({ code: 'BBBB', created: true });
  expect(draws).toEqual([]);
  const aiDraws = ['BBBB', 'CCCC'];
  expect(await arriveAi(sql, { page: id, via: null, ai: 'Claude', country: null }, () => aiDraws.shift() as string)).toBe('CCCC');
  expect(await links(id)).toEqual([
    { code: 'AAAA', parent: null, label: null, ai: null },
    { code: 'BBBB', parent: 'AAAA', label: null, ai: null },
    { code: 'CCCC', parent: null, label: null, ai: 'Claude' },
  ]);
});

it('never finds an entry by its email: the same email from another browser is another entry', async () => {
  const id = await page();
  const a = await reader(id, 'one', null, 'anna@example.com');
  const b = await reader(id, 'two', a.code, 'Anna@example.com');
  expect(b).toEqual({ code: expect.not.stringMatching(a.code as string), created: true });
  expect((await links(id)).map((link) => [link.parent, link.label])).toEqual([
    [null, 'anna@example.com'],
    [a.code, 'anna@example.com'],
  ]);
});

it('counts an unknown code or another page’s code as the author’s link', async () => {
  const id = await page();
  const other = await page('bob');
  const foreign = await own(other, 'x');
  expect(await validCode(sql, other, foreign)).toBe(foreign);
  expect(await validCode(sql, id, foreign)).toBeNull();
  expect(await validCode(sql, id, 'nope')).toBeNull();
  expect(await validCode(sql, id, null)).toBeNull();
  await reader(id, 'a', foreign);
  await reader(id, 'b', 'ZZZZ');
  await reader(id, 'c', "' or 1=1");
  await arriveAi(sql, { page: id, via: foreign, ai: 'Claude', country: null });
  expect((await links(id)).map((link) => link.parent)).toEqual([null, null, null, null]);
});

it('keeps one AI entry per link it came through, per UTC day', async () => {
  const id = await page();
  const a = await own(id, 'a');
  const b = await own(id, 'b');
  const viaA = await arriveAi(sql, { page: id, via: a, ai: 'Claude', country: 'US' });
  const viaB = await arriveAi(sql, { page: id, via: b, ai: 'Claude', country: 'US' });
  expect(viaA).not.toBe(viaB);
  expect(await arriveAi(sql, { page: id, via: a, ai: 'Claude', country: 'US' })).toBe(viaA);
  const chatgpt = await arriveAi(sql, { page: id, via: a, ai: 'ChatGPT', country: null });
  expect([viaA, viaB]).not.toContain(chatgpt);
  // The next day is a new entry.
  await sql`update share_links set created_at = created_at - interval '1 day' where page = ${id} and code = ${viaA}`;
  const tomorrow = await arriveAi(sql, { page: id, via: a, ai: 'Claude', country: 'US' });
  expect(tomorrow).not.toBe(viaA);
  expect(await sql`select parent, ai, key_hash, label, device from share_links where page = ${id} and ai is not null order by created_at, code`).toEqual(
    expect.arrayContaining([
      { parent: a, ai: 'Claude', key_hash: null, label: null, device: null },
      { parent: b, ai: 'Claude', key_hash: null, label: null, device: null },
      { parent: a, ai: 'ChatGPT', key_hash: null, label: null, device: null },
    ]),
  );
  expect(await sql`select 1 from share_links where page = ${id} and ai is not null`).toHaveLength(4);
});

it('makes no entry past the cap, under parallel arrivals', async () => {
  const id = await page();
  await sql`insert into share_links (page, code, key_hash) select ${id}, 'c' || n, 'h' || n from generate_series(2, ${SHARE_CAP}) n`;
  // Ten browsers at once for the last free entry: exactly one gets it.
  const pool = postgres(process.env.DATABASE_URL ?? '', { max: 10 });
  const got = await Promise.all(Array.from({ length: 10 }, (_, n) => arrive(pool, { page: id, via: null, key: key(`r${n}`), label: null, country: null, device: null })));
  await pool.end();
  const winners = got.filter((result) => result.code !== null);
  expect(winners).toHaveLength(1);
  expect(got.filter((result) => result.code === null)).toEqual(Array(9).fill({ code: null, created: false }));
  // The winner still gets its link; a new browser or AI gets none.
  const winner = got.indexOf(winners[0]);
  expect(await reader(id, `r${winner}`)).toEqual({ code: winners[0].code, created: false });
  expect(await reader(id, 'late')).toEqual({ code: null, created: false });
  expect(await arriveAi(sql, { page: id, via: null, ai: 'Claude', country: null })).toBeNull();
  expect(await shareTree(sql, id)).toMatchObject({ entries: SHARE_CAP, capped: true });
});

it('nests the tree, counts each branch, and shows no codes or keys', async () => {
  const id = await page();
  const a = (await arrive(sql, { page: id, via: null, key: key('a'), label: 'a@example.com', country: 'NL', device: 'phone' })).code as string;
  const b = await own(id, 'b');
  const a1 = (await arriveAi(sql, { page: id, via: a, ai: 'Claude', country: 'US' })) as string;
  await own(id, 'a11', a1);
  await own(id, 'a2', a);
  await own(id, 'b1', b);
  const tree = await shareTree(sql, id);
  const shape = (entries: typeof tree.children): unknown[] =>
    entries.map((entry) => ({ label: entry.label, ai: entry.ai, country: entry.country, device: entry.device, brought: entry.brought, reached: entry.reached, children: shape(entry.children) }));
  const plain = { label: null, ai: null, country: null, device: null, brought: 0, reached: 0, children: [] };
  expect({ ...tree, children: shape(tree.children) }).toEqual({
    sharing: 'off',
    entries: 6,
    capped: false,
    brought: 2,
    children: [
      {
        label: 'a@example.com',
        ai: null,
        country: 'NL',
        device: 'phone',
        brought: 2,
        reached: 3,
        children: [{ label: null, ai: 'Claude', country: 'US', device: null, brought: 1, reached: 1, children: [plain] }, plain],
      },
      { ...plain, brought: 1, reached: 1, children: [plain] },
    ],
  });
  expect(tree.children[0].first_opened).toMatch(/^\d{4}-\d\d-\d\dT/);
  const text = JSON.stringify(tree);
  for (const code of [a, b, a1]) expect(text).not.toContain(`"${code}"`);
  expect(text).not.toContain(await sha256Hex(key('a')));
});

it('clears the tree, and deletes it with the page', async () => {
  const testerKey = await addTester('amy');
  const { id } = await createPage(testerKey);
  const a = await own(id, 'a');
  await own(id, 'b', a);
  await arriveAi(sql, { page: id, via: a, ai: 'Claude', country: null });
  expect(await clearTree(sql, id)).toBe(3);
  expect(await clearTree(sql, id)).toBe(0);
  // After clearing, an old code opens as the author's link.
  expect(await validCode(sql, id, a)).toBeNull();
  await own(id, 'c', a);
  expect((await links(id)).map((link) => link.parent)).toEqual([null]);
  expect((await api(testerKey, 'DELETE', `/api/pages/${id}`)).status).toBe(200);
  expect(await sql`select 1 from share_links`).toHaveLength(0);
});

it('reads the device from the User-Agent and the country from Campfile-Client-Country', () => {
  expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('phone');
  expect(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36')).toBe('phone');
  expect(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15')).toBe('computer');
  expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')).toBe('computer');
  expect(deviceOf('')).toBeNull();
  expect(countryOf('DE')).toBe('DE');
  expect(countryOf('XX')).toBeNull();
  expect(countryOf('T1')).toBeNull();
  expect(countryOf('')).toBeNull();
  expect(countryOf(undefined)).toBeNull();
});

it('names the author by their chosen name, else from their email, never as an email', () => {
  const author = (display_name: string | null, email: string | null, name = 'amy') => authorName({ display_name, email, name });
  expect(author(null, 'amy.rivera@x.com')).toBe('Amy Rivera');
  expect(author(null, 'jdoe42@x')).toBe('Jdoe42');
  expect(author(null, 'a_b-c+d..2024@x')).toBe('A B C D');
  expect(author(null, '123@x', '123@x')).toBeNull();
  // Declined ('') falls back to the derived name; a chosen one wins.
  expect(author('', 'amy.rivera@x.com')).toBe('Amy Rivera');
  expect(author('  ', 'amy.rivera@x.com')).toBe('Amy Rivera');
  expect(author(' Amy R. ', 'amy.rivera@x.com')).toBe('Amy R.');
  // An account named by its email, with no email column; an account with neither.
  expect(author(null, null, 'bob.stone@example.com')).toBe('Bob Stone');
  expect(author(null, null, 'Bob')).toBe('Bob');
  expect(author(null, '99@x', 'beta-tester')).toBe('beta-tester');
  expect(author(null, null, '')).toBeNull();
});
