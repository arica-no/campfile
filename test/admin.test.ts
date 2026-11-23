import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { SHOT_CRON } from '../selfhost/cron.ts';
import app from '../src/app.ts';
import { sha256Hex } from '../src/keys.ts';
import { MAX_NEW_PAGES_PER_DAY } from '../src/pages.ts';
import { api, callApp, callViewer, createPage, emails, env, getViewer, json, lastCode, publishedPage, sql, useCleanDatabase, viewerOwner } from './helpers.ts';

useCleanDatabase();

/** Runs the real CLI against DATABASE_URL, as `pnpm admin` does. */
function admin(...args: string[]) {
  return execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/admin.ts', ...args], {
    encoding: 'utf8',
    stdio: 'pipe', // keep the CLI's error output out of the test log; a failure's message still includes it
    env: { ...process.env, APP_ORIGIN: 'https://app.test/' },
  });
}

it('add-tester prints a working key, the connector URL and a curl example; disable-tester stops the key', async () => {
  const output = admin('add-tester', 'amy');
  const key = /Key:\s+([0-9a-f]{64})/.exec(output)?.[1];
  expect(key).toBeDefined();
  expect(output).toContain('Connector: https://app.test/mcp');
  expect(output).toContain('curl -sS -X POST https://app.test/api/pages');
  expect(output).toContain(`Authorization: Bearer ${key}`);

  const [credential] = await sql`select c.key_hash from credentials c join testers t on t.id = c.tester where t.name = 'amy'`;
  expect(credential.key_hash).toBe(await sha256Hex(key!));

  expect((await api(key!, 'GET', '/api/pages')).status).toBe(200);

  expect(admin('list-testers')).toMatch(/amy\s+-\s+active/);
  const { id } = await publishedPage(key!, 'Live', '<p>live</p>');
  admin('disable-tester', 'amy');
  expect((await api(key!, 'GET', '/api/pages')).status).toBe(401);
  expect(admin('list-testers')).toMatch(/amy\s+-\s+disabled/);
  for (const path of [`/${id}`, `/${id}/raw`]) expect((await callViewer(path)).status, path).toBe(404); // their pages go offline
});

it('refuses a tester name that already exists', () => {
  admin('add-tester', 'amy');
  expect(() => admin('add-tester', 'amy')).toThrow(/already exists/);
});

it('takedown takes one page offline for visitors and its owner; the other pages stay; restore brings it back', async () => {
  const key = /Key:\s+([0-9a-f]{64})/.exec(admin('add-tester', 'amy'))![1];
  const bad = await publishedPage(key, 'Bad', '<p>bad</p>');
  const good = await publishedPage(key, 'Good', '<p>good</p>');
  expect(admin('takedown', bad.id)).toContain(`pnpm admin restore ${bad.id}`);
  const owner = await viewerOwner(bad.id);
  for (const [path, cookie] of [[`/${bad.id}`, ''], [`/${bad.id}/raw`, ''], [`/${bad.id}`, owner], [`/${bad.id}/raw`, owner]]) {
    expect((await getViewer(path, cookie)).status, `${path} ${cookie}`).toBe(404);
  }
  expect((await callViewer(`/${good.id}`)).status).toBe(200);
  expect((await json(await api(key, 'GET', '/api/pages'))).pages.map((page: { id: string }) => page.id)).toEqual([good.id]);
  // Nor can the owner swap or delete what the admin is reviewing: restoring brings back the page as it was taken down.
  expect((await api(key, 'PUT', `/api/pages/${bad.id}`, { html: '<p>harmless</p>' })).status).toBe(404);
  expect((await api(key, 'DELETE', `/api/pages/${bad.id}`)).status).toBe(404);
  admin('restore', bad.id);
  expect(await (await callViewer(`/${bad.id}/raw`)).text()).toContain('<p>bad</p>');
  expect(() => admin('restore', bad.id)).toThrow(/no taken-down page/);
  admin('takedown', bad.id);
  expect(() => admin('takedown', bad.id)).toThrow(/no live page/);
});

it('set-email lets a beta tester sign in with their email into the workspace they already have', async () => {
  const key = /Key:\s+([0-9a-f]{64})/.exec(admin('add-tester', 'amy'))![1];
  const { id } = await createPage(key);
  admin('set-email', 'amy', ' Amy@Example.com ');
  expect(admin('list-testers')).toMatch(/amy\s+amy@example\.com\s+active/);

  await callApp('/api/signin', { method: 'POST', body: JSON.stringify({ email: 'amy@example.com' }) });
  const signedIn = await json(await callApp('/api/signin/verify', { method: 'POST', body: JSON.stringify({ email: 'amy@example.com', code: lastCode('amy@example.com') }) }));
  expect((await json(await api(signedIn.key, 'GET', '/api/pages'))).pages.map((page: { id: string }) => page.id)).toEqual([id]);
  expect((await api(key, 'GET', '/api/pages')).status).toBe(200); // the beta key still works
  expect(await sql`select id from testers`).toHaveLength(1);

  admin('add-tester', 'bob');
  expect(() => admin('set-email', 'bob', 'amy@example.com')).toThrow(/already belongs to "amy"/);
  expect(() => admin('set-email', 'nobody', 'x@example.com')).toThrow(/no tester named/);
  expect(() => admin('add-tester', 'eve@example.com')).toThrow(/not an email address/);
});

it('set-email moves a signed-up workspace to its new email, and the old email signs up afresh', async () => {
  const signIn = async (email: string) => {
    await callApp('/api/signin', { method: 'POST', body: JSON.stringify({ email }) });
    const response = await callApp('/api/signin/verify', { method: 'POST', body: JSON.stringify({ email, code: lastCode(email) }) });
    expect(response.status).toBe(200);
    return (await json(response)).key as string;
  };
  const { id } = await createPage(await signIn('old@example.com'));
  expect(admin('set-email', 'old@example.com', 'new@example.com')).toContain('"new@example.com" now signs in as new@example.com');
  expect((await json(await api(await signIn('new@example.com'), 'GET', '/api/pages'))).pages.map((page: { id: string }) => page.id)).toEqual([id]);
  expect((await json(await api(await signIn('old@example.com'), 'GET', '/api/pages'))).pages).toEqual([]);
});

it('set-limits gives one tester, found by name or email, no daily cap, and takes it back', async () => {
  const key = /Key:\s+([0-9a-f]{64})/.exec(admin('add-tester', 'amy'))![1];
  admin('set-email', 'amy', 'amy@example.com');
  admin('add-tester', 'bob');
  const fullDay = () => sql`update testers set writes = ${MAX_NEW_PAGES_PER_DAY}, writes_day = (now() at time zone 'utc')::date`;
  const create = async () => (await api(key, 'POST', '/api/pages', { title: 'P', html: '<p>p</p>' })).status;

  await fullDay();
  expect(await create()).toBe(429);
  admin('set-limits', ' Amy@Example.com ', 'unlimited');
  expect(admin('list-testers')).toMatch(/amy\s+amy@example\.com\s+active\s+unlimited/);
  expect(admin('list-testers')).toMatch(/bob\s+-\s+active\s+standard/); // only that one tester
  expect(await create()).toBe(201);
  admin('set-limits', 'amy', 'standard');
  await fullDay();
  expect(await create()).toBe(429);

  expect(() => admin('set-limits', 'amy', 'huge')).toThrow(/"standard" or "unlimited"/);
  expect(() => admin('set-limits', 'nobody', 'unlimited')).toThrow(/no tester named/);
});

it('set-limits changes nobody when the input is one tester\'s name and another\'s email', async () => {
  await sql`insert into testers (name) values ('kari@example.com')`; // an old beta name that looks like an email, with no email of its own (add-tester now refuses one)
  admin('add-tester', 'ola');
  admin('set-email', 'ola', 'kari@example.com');
  expect(() => admin('set-limits', 'kari@example.com', 'unlimited')).toThrow(/matches more than one tester.*Nothing changed/);
  const list = admin('list-testers');
  expect(list).toMatch(/kari@example\.com\s+-\s+active\s+standard/);
  expect(list).toMatch(/ola\s+kari@example\.com\s+active\s+standard/);
});

