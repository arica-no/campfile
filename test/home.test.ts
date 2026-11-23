import { expect, it } from 'vitest';
import type { AppEnv } from '../src/env.ts';
import { addTester, callApp, createPage, env, form, lastCode, sessionCookie, sql, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

// docs/SPEC.md `GET /`, self-hosted: the install's own home page with its Get started list.

/** As selfhost/server.ts sets it up: with SMTP, or without (every email in the log). */
const selfHosted = (smtp: boolean): AppEnv => ({ ...env, SELF_HOSTED: true, EMAIL_IN_LOG: !smtp });
const home = async (cookie = '', bindings = selfHosted(false)) => (await callApp('/', { headers: { Accept: 'text/html', Cookie: cookie } }, bindings)).text();
const toggle = (hide: '0' | '1', cookie = '', bindings = selfHosted(false)) =>
  callApp('/setup/instructions', { method: 'POST', headers: { ...form, Cookie: cookie }, body: new URLSearchParams({ hide }) }, bindings);
/** A workspace that has signed in with an email, and its browser's Cookie header. */
async function amy() {
  const key = await addTester('amy');
  const [{ id }] = await sql<{ id: number }[]>`update testers set email = 'amy@example.com' where name = 'amy' returning id`;
  return { key, cookie: await sessionCookie(id) };
}
const open = (html: string) => (html.match(/<li><span class="n"/g) ?? []).length;
const done = (html: string) => (html.match(/<li class="done">/g) ?? []).length;

it('gives a self-hosted install its own home page, a bot too, and an AI the instructions', async () => {
  const page = await callApp('/', { headers: { Accept: 'text/html' } }, selfHosted(false));
  expect(page.headers.get('x-robots-tag')).toBe('noindex'); // an install stays out of search results
  const html = await page.text();
  expect(html).toContain('<a class="btn" href="/my">Log in</a>');
  expect(html).toContain('Get started');
  const bot = await callApp('/', { headers: { Accept: '*/*', 'User-Agent': 'WhatsApp/2.23' } }, selfHosted(false));
  expect(await bot.text()).toContain('Get started'); // a shared link's preview
  expect(bot.headers.get('cache-control')).toBe('no-store');
  const agent = await callApp('/', { headers: { Accept: '*/*' } }, selfHosted(false));
  expect(await agent.text()).toContain('curl -sS -X POST https://app.test/api/pages');
});

it('ticks each step once it is done, and drops the list when all are', async () => {
  let html = await home();
  expect([open(html), done(html)]).toEqual([3, 0]);

  const { key, cookie } = await amy();
  html = await home(cookie);
  expect([open(html), done(html)]).toEqual([2, 1]);
  expect(html).toContain('<a class="btn" href="/my">Your pages</a>');

  await createPage(key);
  expect(done(await home())).toBe(2);
  html = await home('', selfHosted(true));
  expect(html).not.toContain('Get started');
  expect(html).toContain('<a class="btn" href="/my">Log in</a>');
});

it('says how this install signs people in at the first login', async () => {
  expect(await home()).toContain('the 6&#8209;digit code in the server’s log (<b>docker compose logs campfile</b>)');
  expect(await home('', { ...selfHosted(false), OWNER_LOGIN: { email: 'me@example.com', password: 'a long password' } })).toContain('your password (<b>OWNER_PASSWORD</b>');
  expect(await home('', selfHosted(true))).toContain('Campfile emails you a link and a 6&#8209;digit code');
});

it('lets only someone logged in hide the list, for everyone, and show it again', async () => {
  const { cookie } = await amy();
  expect(await home()).not.toContain('Hide these instructions');
  expect((await toggle('1')).headers.get('location')).toBe('/signin?next=/');
  expect((await toggle('1', cookie, env)).status).toBe(404); // not self-hosted
  expect((await callApp('/setup/instructions', { method: 'POST', headers: { ...form, Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site', Cookie: cookie }, body: new URLSearchParams({ hide: '1' }) }, selfHosted(false))).status).toBe(403);
  expect(await home()).toContain('Get started');

  expect(await home(cookie)).toContain('Hide these instructions');
  expect((await toggle('1', cookie)).headers.get('location')).toBe('/');
  expect(await home()).not.toMatch(/Get started|setup instructions/);
  expect(await home(cookie)).toContain('Show the setup instructions');

  await toggle('0', cookie);
  expect(await home()).toContain('Get started');
});

it('sends someone logged out who hides the list through the login to their pages', async () => {
  const bindings = selfHosted(true);
  const login = (fields: Record<string, string>) => callApp('/signin', { method: 'POST', headers: form, body: new URLSearchParams({ email: 'amy@example.com', next: '/', ...fields }) }, bindings);
  expect((await toggle('1', '', bindings)).headers.get('location')).toBe('/signin?next=/');
  await login({});
  expect((await login({ code: lastCode('amy@example.com') })).headers.get('location')).toMatch(/\/my$/);
});

it('makes email optional in single-user mode: the list closes once steps 1 and 3 are done', async () => {
  const single = { ...selfHosted(false), OWNER_LOGIN: { email: 'amy@example.com', password: 'a long password' } };
  let html = await home('', single);
  expect(html).toContain('<h3>Connect email (optional)</h3>');
  expect(html).toContain('anyone who reaches this address can make an account');
  const { key } = await amy();
  expect(done(await home('', single))).toBe(1); // email stays open, not ticked
  await createPage(key);
  html = await home('', single);
  expect(html).not.toContain('Get started');
  expect(await home()).toContain('Get started'); // without OWNER_LOGIN email still counts
});
