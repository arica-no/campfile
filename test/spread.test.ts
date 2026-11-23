import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { signedId } from '../src/keys.ts';
import { arrive } from '../src/sharing.ts';
import { addTester, callApp, callViewer, form, getViewer, ownerCookie, publishedPage, sessionCookie, sql, useCleanDatabase, viewerLogin, viewerOwner } from './helpers.ts';
import { env, startApp, stored } from './helpers.ts';
import { fakeBrowser, jpeg, SHOT } from './helpers.ts';
import { SPREAD_V } from '../src/spread-view.ts';

useCleanDatabase();

// docs/SPEC.md "How it spread": <viewer>/<id>/spread, the owner's view with names, and a public one with none once the owner turns it on.
const OWNER = 'amy@example.com';
const READER = 'b@example.com';
const key = (n: number) => `k${String(n).padStart(21, '0')}`;
const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
const valueOf = (cookie: string | undefined) => cookie!.split(';')[0];

/** A published link page with two entries: a browser through the author's link, who brings READER (a typed email). */
async function spreadPage() {
  const apiKey = await addTester('amy');
  await sql`update testers set email = ${OWNER} where name = 'amy'`;
  const { id } = await publishedPage(apiKey, 'Pricing page');
  const a = (await arrive(sql, { page: id, via: null, key: key(1), label: null, country: 'NO', device: 'phone' })).code!;
  await arrive(sql, { page: id, via: a, key: key(2), label: READER, country: 'SE', device: 'computer' });
  return id;
}

/** The sheet's Let anyone with the link see it, ticked or not, as `cookie`'s browser sends it. */
const toggle = (id: string, on: boolean, cookie: string) =>
  callApp(`/p/${id}/spread`, { method: 'POST', headers: { ...form, Cookie: cookie }, body: new URLSearchParams(on ? [['public', '0'], ['public', '1']] : [['public', '0']]) });
const isPublic = async (id: string) => (await sql<{ spread_public: boolean }[]>`select spread_public from pages where id = ${id}`)[0].spread_public;

it('shows the owner their tree with names, never cached, never described for link previews', async () => {
  const id = await spreadPage();
  const response = await getViewer(`/${id}/spread`, await viewerOwner(id));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  const html = await response.text();
  expect(html).toContain('data-mode="owner"');
  expect(html).toContain(READER);
  expect(html).toContain('Only you can see this');
  expect(html).not.toContain('og:image');
  expect(html).not.toMatch(/"(country|device)"/);
});

it('shows a stranger the not-found screen while it is not public, with a Log in that comes back to it', async () => {
  const id = await spreadPage();
  const response = await callViewer(`/${id}/spread`);
  expect(response.status).toBe(404);
  const html = await response.text();
  expect(html).toContain(`/${id}/login?then=spread`);
  expect(html).not.toContain(READER);
});

it('lets only the owner make it public, then shows anyone a view with no names or emails', async () => {
  const id = await spreadPage();
  // Signed out: the sign-in. Another workspace: not theirs. Neither changes it.
  expect((await toggle(id, true, '')).headers.get('location')).toMatch(/^\/signin\?next=/);
  await addTester('other');
  const [{ id: other }] = await sql<{ id: number }[]>`select id from testers where name = 'other'`;
  expect((await toggle(id, true, await sessionCookie(other))).status).toBe(404);
  expect(await isPublic(id)).toBe(false);

  const on = await toggle(id, true, await ownerCookie(id));
  expect(on.status).toBe(303);
  expect(on.headers.get('location')).toBe(`/p/${id}/manage?done=spread-public`);
  expect(await isPublic(id)).toBe(true);
  await sql`update share_links set created_at = '2026-09-22 14:37:12.345+00' where page = ${id}`;
  const response = await callViewer(`/${id}/spread`);
  expect(response.status).toBe(200);
  const html = await response.text();
  // Public first opens are rounded down to the hour: no minutes, seconds or milliseconds to match against other logs.
  expect(html).toContain('"first_opened":"2026-09-22T14:00:00.000Z"');
  expect(html).not.toMatch(/"first_opened":"[^"]*T\d\d:(?!00:00\.000Z)/);
  expect(await (await getViewer(`/${id}/spread`, await viewerOwner(id))).text()).toContain('"first_opened":"2026-09-22T14:37:12.345Z"');
  expect(html).toContain('data-mode="public"');
  expect(html).not.toContain(READER);
  expect(html).not.toContain(OWNER);
  expect(html).toContain('<meta property="og:title" content="How “Pricing page” spread">');
  expect(html).toContain(`content="https://view.test/${id}/spread/preview.jpg?design=cascade"`);
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  // ?shot=1, as the app's screenshot asks: the card layout, public mode only.
  expect(html).not.toContain('data-shot');
  expect(await (await callViewer(`/${id}/spread?shot=1`)).text()).toContain('data-shot="1"');
  expect(await (await getViewer(`/${id}/spread?shot=1`, await viewerOwner(id))).text()).not.toContain('data-shot');

  // Another workspace's owner, logged in on the viewer, gets the public view too.
  const theirs = await (await getViewer(`/${id}/spread`, await viewerLogin(other))).text();
  expect(theirs).toContain('data-mode="public"');
  expect(theirs).not.toContain(READER);

  expect((await toggle(id, false, await ownerCookie(id))).headers.get('location')).toBe(`/p/${id}/manage?done=spread-private`);
  expect(await isPublic(id)).toBe(false);
  expect((await callViewer(`/${id}/spread`)).status).toBe(404);
});

it('is not public while the page is a draft, an approval page or hidden, even with the switch on', async () => {
  const id = await spreadPage();
  await sql`update pages set spread_public = true where id = ${id}`;
  for (const change of [sql`update pages set published_at = null where id = ${id}`, sql`update pages set access = 'approval' where id = ${id}`, sql`update pages set status = 'hidden' where id = ${id}`]) {
    const [saved] = await sql<{ published_at: Date; access: string; status: string }[]>`select published_at, access, status from pages where id = ${id}`;
    await change;
    expect((await callViewer(`/${id}/spread`)).status).toBe(404);
    expect((await callViewer(`/${id}/spread/preview.jpg`)).status).toBe(404);
    await sql`update pages set published_at = ${saved.published_at}, access = ${saved.access}, status = ${saved.status} where id = ${id}`;
  }
  expect((await callViewer(`/${id}/spread`)).status).toBe(200);
});

it('refuses to make an approval page public', async () => {
  const id = await spreadPage();
  await sql`update pages set access = 'approval' where id = ${id}`;
  expect((await toggle(id, true, await ownerCookie(id))).status).toBe(400);
  expect(await isPublic(id)).toBe(false);
});

it('falls back to the cascade design for an unknown ?design', async () => {
  const id = await spreadPage();
  const html = await (await getViewer(`/${id}/spread?design=nope`, await viewerOwner(id))).text();
  expect(html).toContain('data-design="cascade"');
  expect(html).toContain('/spread/cascade.js');
});

it('brings the owner back to the spread view after logging in from it', async () => {
  const id = await spreadPage();
  const login = await getViewer(`/${id}/login?then=spread`, '');
  const loginCookie = valueOf(cookieOf(login, '__Host-campfile-login'));
  const location = new URL(login.headers.get('location')!);
  expect(location.searchParams.has('then')).toBe(false); // never sent on to the app
  const handOver = await callApp(location.pathname + location.search, { headers: { Cookie: await ownerCookie(id) } });
  const back = new URL(handOver.headers.get('location')!);
  const done = await getViewer(back.pathname + back.search, loginCookie);
  expect(done.status).toBe(303);
  expect(done.headers.get('location')).toBe(`/${id}/spread`);
  const html = await (await getViewer(`/${id}/spread`, valueOf(cookieOf(done, '__Host-campfile-owner')))).text();
  expect(html).toContain('data-mode="owner"');
});

it('serves the public view’s link-preview picture only while it is public', async () => {
  const id = await spreadPage();
  expect((await callViewer(`/${id}/spread/preview.jpg`)).status).toBe(404);
  await toggle(id, true, await ownerCookie(id));
  expect(stored(`spread/${id}/`)).toEqual([`spread/${id}/cascade.jpg`]); // taken when turned on
  // Another design is taken when first asked for (past the 10 s cap across all shots), by the app on the viewer's signed request.
  await sql`update spread_shots set tried_at = now() - interval '11 seconds'`;
  const ember = await callViewer(`/${id}/spread/preview.jpg?design=ember`);
  expect(ember.status).toBe(200);
  expect(ember.headers.get('content-type')).toBe('image/jpeg');
  expect(new Uint8Array(await ember.arrayBuffer())).toEqual(SHOT);
  // The app shoots nothing for an unsigned or another page's request.
  const token = await signedId(env.PREVIEW_SECRET, `spread-shot:${id}:ember`, 0, Math.floor(Date.now() / 1000) + 60);
  expect((await callApp(`/spread-shot/${id}?design=ember`, { method: 'POST' })).status).toBe(403);
  expect((await callApp(`/spread-shot/${id}?design=cascade&t=${token}`, { method: 'POST' })).status).toBe(403);
  // Off: the pictures go.
  await toggle(id, false, await ownerCookie(id));
  expect(stored('spread/')).toEqual([]);
  expect((await callViewer(`/${id}/spread/preview.jpg?design=ember`)).status).toBe(404);
});

it('takes one spread shot every 10 seconds, whatever its page or design, answering busy meanwhile', async () => {
  const id = await spreadPage();
  await toggle(id, true, await ownerCookie(id)); // shoots cascade
  const token = await signedId(env.PREVIEW_SECRET, `spread-shot:${id}:ember`, 0, Math.floor(Date.now() / 1000) + 60);
  const busy = await callApp(`/spread-shot/${id}?design=ember&t=${token}`, { method: 'POST' });
  expect(busy.status).toBe(503);
  expect(busy.headers.get('retry-after')).toBe('10');
  expect(stored(`spread/${id}/`)).toEqual([`spread/${id}/cascade.jpg`]);
  expect((await sql`select design from spread_shots`).map((row) => row.design)).toEqual(['cascade']); // nor claimed for 10 minutes
  await sql`update spread_shots set tried_at = now() - interval '11 seconds'`;
  expect((await callApp(`/spread-shot/${id}?design=ember&t=${token}`, { method: 'POST' })).status).toBe(204);
  expect(stored(`spread/${id}/`).sort()).toEqual([`spread/${id}/cascade.jpg`, `spread/${id}/ember.jpg`]);
});

it('lets only one of two simultaneous shots of different pages start the screenshot service', async () => {
  const first = await spreadPage();
  const { id: second } = await publishedPage(await addTester('bob'), 'Menu');
  await sql`update pages set spread_public = true where id in ${sql([first, second])}`;
  const { browser, requests } = fakeBrowser();
  const shoot = async (id: string) => {
    const token = await signedId(env.PREVIEW_SECRET, `spread-shot:${id}:cascade`, 0, Math.floor(Date.now() / 1000) + 60);
    return (await callApp(`/spread-shot/${id}?design=cascade&t=${token}`, { method: 'POST' }, { ...env, BROWSER: browser })).status;
  };
  expect((await Promise.all([shoot(first), shoot(second)])).sort()).toEqual([204, 503]);
  expect(requests).toHaveLength(1);
  // The public view in its card layout, with no cookie.
  expect([first, second].map((id) => `${env.VIEWER_ORIGIN}/${id}/spread?design=cascade&shot=1`)).toContain(requests[0].url);
  expect(requests[0].cookies).toBeUndefined();
});

it('keeps no picture from a shot that was still being taken when the owner turned it off', async () => {
  const id = await spreadPage();
  const cookie = await ownerCookie(id);
  const asked = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const { browser } = fakeBrowser(async () => {
    asked.resolve();
    await answered.promise;
    return jpeg();
  });
  const on = startApp(`/p/${id}/spread`, { method: 'POST', headers: { ...form, Cookie: cookie }, body: new URLSearchParams([['public', '0'], ['public', '1']]) }, { ...env, BROWSER: browser });
  await on.response;
  await asked.promise;
  await toggle(id, false, cookie);
  answered.resolve();
  await on.settled();
  expect(stored('spread/')).toEqual([]);
});

it('shows the How it spread section on the sheet: the counts, the view, and the switch with its public link', async () => {
  const id = await spreadPage();
  await toggle(id, true, await ownerCookie(id));
  const html = await (await callApp(`/p/${id}/manage?done=spread-public`, { headers: { Cookie: await ownerCookie(id) } })).text();
  expect(html).toContain('Anyone with the link can now see how “Pricing page” spread, with no names.');
  const section = html.slice(html.indexOf('<section class="sec" id="spread">'));
  expect(section).toContain('<b>2</b> people · 2 levels · 1 spark');
  expect(section).toContain(`href="https://view.test/${id}/login?then=spread#from-sheet"`);
  expect(section).toContain('name="public" value="1" checked');
  expect(section).toContain(`data-copy="https://view.test/${id}/spread"`);
});

it('changes the ?v= of the view files whenever one of them changes, so browsers holding the old ones fetch the new', () => {
  const dir = new URL('../viewer/public/spread/', import.meta.url);
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).sort()) hash.update(readFileSync(new URL(name, dir)));
  expect(SPREAD_V, 'set SPREAD_V in src/spread-view.ts to this').toBe(hash.digest('hex').slice(0, 8));
});
