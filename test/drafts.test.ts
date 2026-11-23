import { expect, it } from 'vitest';
import { signedId } from '../src/keys.ts';
import { addTester, api, callApp, callViewer, click, createPage, env, form, getViewer, json, ownerCookie, previewOf, publishedPage, served, sessionCookie, sql, stored, useCleanDatabase, viewerLogin, viewerOwner } from './helpers.ts';
import { fakeBrowser } from './helpers.ts';

useCleanDatabase();

const SECRET = env.PREVIEW_SECRET;
const VIEWER = 'https://view.test';
const NOT_PUBLISHED = "This page isn't published";
// docs/SPEC.md "Frame CSP" and "Raw CSP", with the origins of these tests.
const frameCsp = (id: string) => `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-src ${VIEWER}/${id}/raw; script-src ${VIEWER}/bar.js`; // every bar loads only /bar.js, its frame only its own page
let RAW_CSP =
  `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self' https://app.test`;

const now = () => Math.floor(Date.now() / 1000);
const frame = async (path: string) => (await callViewer(path)).text();
const testerId = async (name: string) => (await sql<{ id: number }[]>`select id from testers where name = ${name}`)[0].id;
/** The address of the iframe, as the browser reads it (`&amp;` is `&`). */
const iframeSrc = (html: string) => /<iframe [^>]*\ssrc="([^"]+)"/.exec(html)![1].replaceAll('&amp;', '&');
const ogImage = (html: string) => /<meta property="og:image" content="([^"]+)">/.exec(html)?.[1];
const publishedAt = async (id: string) => (await sql<{ published_at: Date | null }[]>`select published_at from pages where id = ${id}`)[0].published_at;

it('makes every new page a draft: the public link and /raw say it is not published, without its title, and offer Log in', async () => {
  const key = await addTester('amy');
  const { id, url, published } = await createPage(key, 'A secret title', '<p>secret</p>');
  expect(published).toBe(false);
  expect(url).toBe(`${VIEWER}/${id}`);
  expect(await publishedAt(id)).toBeNull();
  expect(stored('previews/')).toHaveLength(1); // the wall's picture, taken as its owner

  for (const path of [`/${id}`, `/${id}/raw`]) {
    const response = await callViewer(path);
    expect(response.status, path).toBe(404);
    const text = await response.text();
    expect(text).toContain(NOT_PUBLISHED);
    expect(text).not.toContain('secret');
  }
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(404);
  expect(await frame(`/${id}`)).toContain(`<a href="/${id}/login">Log in</a>`);
});

it("sends a page's owner, logged in on the viewer, on to the page on the app, whatever its state or link; /raw still opens for that login", async () => {
  const tester = await addTester('amy');
  await addTester('bob');
  const draft = await createPage(tester, 'Draft title', '<h1>draft</h1>');
  const live = await publishedPage(tester, 'Live', '<p>live</p>');
  const gated = await createPage(tester, 'Gated', '<p>gated</p>');
  expect((await click('publish', gated.id, env, { access: 'approval' })).status).toBe(303);

  // docs/SPEC.md "Managing a page": the owner's page and its bar are on the app, which frames /raw with a ticket (test/viewer.test.ts).
  for (const path of [`/${draft.id}`, `/${live.id}`, `/${live.id}-abcd`, `/${gated.id}`]) {
    const id = path.slice(1, 9);
    const response = await getViewer(path, await viewerOwner(id));
    expect(response.status, path).toBe(302);
    expect(response.headers.get('location'), path).toBe(`https://app.test/p/${id}`);
    expect(response.headers.get('cache-control'), path).toBe('no-store');
  }
  // Another workspace's login still gets the visitor's page, with its Log out.
  const other = await getViewer(`/${live.id}`, await viewerLogin(await testerId('bob')));
  expect(other.status).toBe(200);
  expect(await other.text()).toContain(`href="/${live.id}/logout"`);

  // A draft's /raw opens for that login and for no fresh browser.
  const raw = await getViewer(`/${draft.id}/raw`, await viewerOwner(draft.id));
  expect(raw.status).toBe(200);
  expect(await raw.text()).toBe(served('<h1>draft</h1>'));
  expect(raw.headers.get('content-security-policy')).toBe(RAW_CSP);
  expect(raw.headers.get('referrer-policy')).toBe('no-referrer');
  expect((await callViewer(`/${draft.id}/raw`)).status).toBe(404);
});

it('keeps a draft and its /raw shut for anyone but its owner, whatever they send', async () => {
  const amy = await addTester('amy');
  await addTester('bob');
  const { id } = await createPage(amy, 'First title', '<p>one</p>');
  const owner = await testerId('amy');

  for (const [name, cookie] of [
    ['no login', ''],
    ['a forged login', `__Host-campfile-owner=${owner}.9999999999.forged`],
    ['an expired login', `__Host-campfile-owner=${await signedId(SECRET, 'owner', owner, now() - 1)}`],
    ["the owner's login signed for another scope", `__Host-campfile-owner=${await signedId(SECRET, `access:${id}`, owner, now() + 60)}`],
    ["the owner's app session", await sessionCookie(owner)],
    ['another workspace logged in', await viewerLogin(await testerId('bob'))],
  ]) {
    for (const path of [`/${id}`, `/${id}/raw`, `/${id}?key=anything`, `/${id}/raw?exp=9999999999&t=anything`]) {
      const response = await getViewer(path, cookie);
      expect(response.status, `${name} ${path}`).toBe(404);
      const text = await response.text();
      expect(text, `${name} ${path}`).toContain(NOT_PUBLISHED);
      expect(text, `${name} ${path}`).not.toContain('First title');
    }
  }
  // Logged in as someone else: Log in asks for an email again.
  const other = await (await getViewer(`/${id}`, await viewerLogin(await testerId('bob')))).text();
  expect(other).toContain(`<a href="/${id}/login?switch=1">Log in with another email</a>`);
});

it('publishes from the owner page: a form POST signed in as the owner answers 303 back to the owner page, and the public page then has a link preview', async () => {
  const tester = await addTester('amy');
  const { id, url } = await createPage(tester, 'Hi', '<h1>Hi</h1>');
  let bindings = env;
  const { browser, requests } = fakeBrowser();
  bindings = { ...env, BROWSER: browser };

  const response = await click('publish', id, bindings);
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(`/p/${id}/manage?done=published`);
  expect(await publishedAt(id)).toBeInstanceOf(Date);
  expect(requests.map((request) => request.url)).toEqual([url]); // the public page, which needs no key

  const html = await frame(`/${id}`);
  expect(ogImage(html)).toMatch(new RegExp(`^${VIEWER}/${id}/preview\\.jpg\\?v=[0-9a-f]{8}$`));
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  expect(html).toContain(`<meta property="og:url" content="${url}">`);
  expect(await (await callViewer(`/${id}/raw`)).text()).toBe(served('<h1>Hi</h1>'));
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(200);
});

it.each(['publish', 'unpublish'] as const)('does not %s without the sign-in on the app, with a forged session or another workspace', async (button) => {
  const tester = await addTester('amy');
  await addTester('bob');
  const [bob] = await sql<{ id: number }[]>`select id from testers where name = 'bob'`;
  const make = button === 'publish' ? createPage : publishedPage; // the page starts in the state the button changes
  const page = await make(tester);
  const before = await publishedAt(page.id);
  const images = stored('previews/');
  let bindings = env;
  const { browser, requests } = fakeBrowser();
  bindings = { ...env, BROWSER: browser };
  const fields = new URLSearchParams({ access: 'link' });

  for (const [cookie, status] of [
    ['', 303], // not signed in: off to sign in
    [await viewerOwner(page.id), 303], // the viewer's login is not the app's session
    ['__Host-campfile-session=1.9999999999.forged', 303],
    [await sessionCookie(bob.id), 404], // signed in, but not the owner
  ] as const) {
    const response = await callApp(`/p/${page.id}/${button}`, { method: 'POST', headers: { ...form, Cookie: cookie }, body: fields }, bindings);
    expect(response.status, cookie).toBe(status);
    if (status === 303) expect(response.headers.get('location')).toBe(`/signin?next=/p/${page.id}/manage`);
  }
  expect(await publishedAt(page.id)).toEqual(before);
  expect(requests).toEqual([]);
  expect(stored('previews/')).toEqual(images);
});

it.each(['publish', 'unpublish'] as const)('does not %s from a GET, and refuses a big request', async (button) => {
  const tester = await addTester('amy');
  const { id } = await (button === 'publish' ? createPage : publishedPage)(tester);
  const before = await publishedAt(id);
  const cookie = await ownerCookie(id);

  // Link scanners and prefetchers open links with GET; that must never change a page.
  const get = await callApp(`/p/${id}/${button}?access=link`, { headers: { Cookie: cookie } });
  expect(get.status).toBe(404);
  expect(await publishedAt(id)).toEqual(before);

  const big = await callApp(`/p/${id}/${button}`, { method: 'POST', headers: { ...form, Cookie: cookie }, body: `access=link&emails=${'x'.repeat(40000)}` });
  expect(big.status).toBe(413);
  expect(await publishedAt(id)).toEqual(before);
});

it.each(['publish', 'unpublish'] as const)('does not %s a removed page, or one that never existed, even signed in as its owner', async (button) => {
  const tester = await addTester('amy');
  const { id } = await (button === 'publish' ? createPage : publishedPage)(tester);
  const before = await publishedAt(id);
  await sql`update pages set status = 'hidden' where id = ${id}`;

  const removed = await click(button, id);
  expect(removed.status).toBe(404);
  expect(await publishedAt(id)).toEqual(before);

  const unknown = await callApp(`/p/ZZZZZZZZ/${button}`, { method: 'POST', headers: { ...form, Cookie: await ownerCookie(id) }, body: 'access=link' });
  expect(unknown.status).toBe(404);
});

it('publishing a published page again changes nothing and takes no new screenshot', async () => {
  const tester = await addTester('amy');
  const { id } = await createPage(tester, 'Amy', '<p>amy</p>');
  let bindings = env;
  const { browser, requests } = fakeBrowser();
  bindings = { ...env, BROWSER: browser };

  expect((await click('publish', id, bindings)).status).toBe(303);
  expect(await (await callViewer(`/${id}/raw`)).text()).toBe(served('<p>amy</p>'));
  expect(requests).toHaveLength(1);

  const when = await publishedAt(id);
  const again = await click('publish', id, bindings);
  expect(again.status).toBe(303);
  expect(again.headers.get('location')).toBe(`/p/${id}/manage?done=published`);
  expect(await publishedAt(id)).toEqual(when);
  expect(requests).toHaveLength(1); // only the first publish takes a screenshot
});

it('takes one screenshot when a page is published several times at once', async () => {
  const tester = await addTester('amy');
  const { id } = await createPage(tester);
  const { browser, requests } = fakeBrowser();
  const bindings = { ...env, BROWSER: browser };

  const answers = await Promise.all([1, 2, 3, 4].map(() => click('publish', id, bindings)));
  expect(answers.map((answer) => answer.status)).toEqual([303, 303, 303, 303]);
  expect(requests).toHaveLength(1);
  expect(stored('previews/')).toHaveLength(1);
});

it('keeps a draft a draft when it is updated, with a new screenshot taken as its owner and no link preview; a published page goes live at once and gets a new screenshot', async () => {
  const tester = await addTester('amy');
  let bindings = env;
  const { browser, requests } = fakeBrowser();
  bindings = { ...env, BROWSER: browser };
  const { id, url } = await json(await api(tester, 'POST', '/api/pages', { title: 'One', html: '<p>one</p>' }, bindings));

  const updated = await api(tester, 'PUT', `/api/pages/${id}`, { title: 'Two', html: '<p>two</p>' }, bindings);
  expect(updated.status).toBe(200);
  expect(await json(updated)).toEqual({ id, url, published: false });
  expect(await publishedAt(id)).toBeNull();
  expect(requests.map((request) => [request.url, request.cookies?.length])).toEqual([[url, 1], [url, 1]]); // created, then updated, each shot as its owner
  expect(stored('previews/')).toHaveLength(1); // the old version's went
  expect((await callViewer(`/${id}`)).status).toBe(404);
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(404); // the draft's picture is the wall's, never a link preview
  expect(await (await getViewer(`/${id}/raw`, await viewerOwner(id))).text()).toBe(served('<p>two</p>')); // the owner sees the new content

  expect((await click('publish', id, bindings)).status).toBe(303);
  expect(requests).toHaveLength(3);
  expect(requests[2].cookies).toBeUndefined(); // a link page is shot as anyone sees it

  const live = await api(tester, 'PUT', `/api/pages/${id}`, { html: '<p>three</p>' }, bindings);
  expect(await json(live)).toEqual({ id, url, published: true });
  expect(await (await callViewer(`/${id}/raw`)).text()).toBe(served('<p>three</p>')); // open to anyone
  expect(requests.map((request) => request.url)).toEqual([url, url, url, url]);
  expect(ogImage(await frame(`/${id}`))).toBeDefined();
  expect(stored('previews/')).toHaveLength(1);
});

it('lists drafts and published pages, each with its one url', async () => {
  const tester = await addTester('amy');
  const draft = await createPage(tester, 'Draft', '<p>draft</p>');
  const live = await publishedPage(tester, 'Live', '<p>live</p>');

  const { pages } = await json(await api(tester, 'GET', '/api/pages'));
  expect(pages).toEqual([
    { id: live.id, title: 'Live', url: live.url, published: true, access: 'link', sharing: 'off', updated_at: expect.any(String), group: null },
    { id: draft.id, title: 'Draft', url: draft.url, published: false, access: 'link', sharing: 'off', updated_at: expect.any(String), group: null },
  ]);
});

it('never signs anyone in on the app from the viewer: the owner is sent on to the app, which needs the email sign-in, even with an old login token in the address', async () => {
  const tester = await addTester('amy');
  const { id } = await createPage(tester);
  const amy = await testerId('amy');

  expect((await getViewer(`/${id}`, await viewerOwner(id))).headers.get('location')).toBe(`https://app.test/p/${id}`);
  for (const path of [`/p/${id}`, `/p/${id}?login=${await signedId(env.CONSENT_SECRET, 'login', amy, Math.floor(Date.now() / 1000) + 3600)}`]) {
    const response = await callApp(path);
    expect(response.headers.get('location'), path).toBe(`/signin?next=/p/${id}`);
    expect(response.headers.get('set-cookie'), path).toBeNull();
  }
});

it("shows a visitor a published page the same with or without a forged login or ?key=: the visitor's bar with Log in, no lamp, no form", async () => {
  const tester = await addTester('amy');
  const { id, url } = await publishedPage(tester, 'Live', '<p>live</p>');
  const owner = await testerId('amy');

  const plain = await callViewer(`/${id}`);
  const html = await plain.text();
  expect(plain.headers.get('content-security-policy')).toBe(frameCsp(id));
  expect(html).not.toContain('class="state');
  expect(html).toContain(`href="/${id}/login"`);
  expect(html).not.toContain(`/${id}/logout`);
  expect(html).toContain('href="https://app.test/" target="_blank"'); // the visitor's "make your own" dialog points at the app
  expect(html).not.toContain('<form');
  expect(iframeSrc(html)).toBe(`/${id}/raw`);
  expect(ogImage(html)).toBeDefined();
  expect(html).toContain(`<meta property="og:url" content="${url}">`);

  for (const [path, cookie] of [
    [`/${id}?key=nope`, ''],
    [`/${id}`, `__Host-campfile-owner=${owner}.9999999999.forged`],
    [`/${id}`, `__Host-campfile-owner=${await signedId(SECRET, 'owner', owner, now() - 1)}`],
  ]) {
    const response = await getViewer(path, cookie);
    expect(response.status, cookie).toBe(200);
    expect(response.headers.get('content-security-policy'), cookie).toBe(frameCsp(id));
    expect(await response.text(), cookie).toBe(html);
  }
  // The old pass parameters mean nothing for a published page: /raw is open.
  expect(await (await callViewer(`/${id}/raw?exp=1&t=nope`)).text()).toBe(served('<p>live</p>'));
});

it('unpublishes from the owner page: 303 back to it, and the page is a draft again with a new screenshot for the wall; the public link, /raw and the link preview stop working', async () => {
  const tester = await addTester('amy');
  const { id } = await publishedPage(tester, 'Hi', '<h1>Hi</h1>');
  const shared = await previewOf(id);
  expect(stored('previews/')).toHaveLength(1);

  const response = await click('unpublish', id);
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(`/p/${id}/manage?done=unpublished`);
  expect(await publishedAt(id)).toBeNull();
  const drafted = await previewOf(id);
  expect(drafted).not.toBe(shared);
  expect(stored('previews/')).toEqual([drafted]); // the link-preview image goes with the public page
  expect((await json(await api(tester, 'GET', '/api/pages'))).pages).toMatchObject([{ id, published: false }]);

  for (const path of [`/${id}`, `/${id}/raw`]) {
    const gone = await callViewer(path);
    expect(gone.status, path).toBe(404);
    expect(await gone.text(), path).toContain(NOT_PUBLISHED);
  }
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(404);

  expect(await (await getViewer(`/${id}/raw`, await viewerOwner(id))).text()).toBe(served('<h1>Hi</h1>')); // the draft is still its owner's
});

it('unpublishing twice, or a page that was never published, changes nothing', async () => {
  const tester = await addTester('amy');
  const { id } = await publishedPage(tester);

  for (const _again of [1, 2]) {
    const response = await click('unpublish', id);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/p/${id}/manage?done=unpublished`);
    expect(await publishedAt(id)).toBeNull();
  }
  const draft = await createPage(tester);
  const shot = await previewOf(draft.id);
  expect(shot).not.toBeNull();
  expect((await click('unpublish', draft.id)).status).toBe(303);
  expect(await publishedAt(draft.id)).toBeNull();
  expect(await previewOf(draft.id)).toBe(shot); // a draft keeps its screenshot
});

it('takes a new screenshot when an unpublished page is published again', async () => {
  const tester = await addTester('amy');
  const { id, url } = await createPage(tester, 'Hi', '<h1>Hi</h1>');
  const { browser, requests } = fakeBrowser();
  const bindings = { ...env, BROWSER: browser };

  await click('publish', id, bindings);
  const first = await previewOf(id);
  expect(first).not.toBeNull();
  await click('unpublish', id, bindings);
  await click('publish', id, bindings);

  expect(requests.map((request) => request.url)).toEqual([url, url, url]); // published, unpublished (shot as a draft), published again
  const second = await previewOf(id);
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  expect(stored('previews/')).toEqual([second]); // the first image went when the page was unpublished
  expect(ogImage(await frame(`/${id}`))).toBeDefined();
});
