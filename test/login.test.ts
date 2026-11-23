import { expect, it } from 'vitest';
import { HAS_TERMS } from '../src/hosted.ts';
import { readSignedId, signedId } from '../src/keys.ts';
import { LINK_MINUTES, TERMS_VERSION } from '../src/signin.ts';
import { addTester, callApp, createPage, emails, env, form, getViewer, lastCode, served, sessionCookie, sql, useCleanDatabase, viewerLogin } from './helpers.ts';

useCleanDatabase();

// docs/SPEC.md "Login": viewer /login → app /viewer-login (the login screen if needed) → viewer /signed-in with a ticket for this browser's state.
const OWNER = 'amy@example.com';
const now = () => Math.floor(Date.now() / 1000);
const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
const valueOf = (cookie: string | undefined) => cookie!.split(';')[0];

async function draft() {
  const key = await addTester('amy');
  await sql`update testers set email = ${OWNER} where name = 'amy'`;
  const { id } = await createPage(key, 'Draft title', '<p>draft</p>');
  const [{ owner }] = await sql<{ owner: number }[]>`select owner from pages where id = ${id}`;
  return { id, owner };
}

/** The viewer's Log in: the state cookie and where it sends the browser. */
async function startLogin(id: string, query = '') {
  const response = await getViewer(`/${id}/login${query}`, '');
  expect(response.status).toBe(303);
  const login = cookieOf(response, '__Host-campfile-login');
  expect(login).toContain('Max-Age=600; HttpOnly; Secure; SameSite=Lax');
  const state = valueOf(login).split('=')[1];
  return { state, loginCookie: valueOf(login), location: response.headers.get('location')! };
}

/** Asks for a login link as a browser does: the link from the email, and the cookie the code screen sets in that browser. */
async function askForLink(address: string, next: string) {
  const response = await callApp('/signin', { method: 'POST', headers: form, body: new URLSearchParams({ email: address, next }) });
  const link = new URL(emails.at(-1)!.text.match(/https:\/\/app\.test\/signin\/link\?\S+/)![0]);
  return { link: link.pathname + link.search, cookie: valueOf(cookieOf(response, '__Host-campfile-link')) };
}

it('logs the owner in on the viewer through the app: email code, ticket, then their page opens on the app', async () => {
  const { id } = await draft();
  const { state, loginCookie, location } = await startLogin(id);
  expect(location).toBe(`https://app.test/viewer-login?page=${id}&state=${state}`);

  // Not signed in on the app: the email sign-in first, which comes back to the hand-over.
  const toSignin = await callApp(location.slice('https://app.test'.length));
  const next = `/viewer-login?page=${id}&state=${state}`;
  expect(toSignin.headers.get('location')).toBe(`/signin?next=${encodeURIComponent(next)}`);
  expect(await (await callApp(toSignin.headers.get('location')!)).text()).toContain(`name="next" value="/viewer-login?page=${id}&#38;state=${state}"`);
  await callApp('/signin', { method: 'POST', headers: form, body: new URLSearchParams({ email: OWNER, next }) });
  // The email has the code and a login link back to the same hand-over.
  expect(emails.at(-1)!.text).toContain(`Or type this code: ${lastCode(OWNER)}`);
  expect(new URL(emails.at(-1)!.text.match(/https:\/\/app\.test\/signin\/link\?\S+/)![0]).searchParams.get('next')).toBe(next);
  const signedIn = await callApp('/signin', { method: 'POST', headers: form, body: new URLSearchParams({ email: OWNER, next, code: lastCode(OWNER) }) });
  expect(signedIn.status).toBe(303);
  expect(signedIn.headers.get('location')).toBe(next);
  const session = valueOf(cookieOf(signedIn, '__Host-campfile-session'));

  const handOver = await callApp(next, { headers: { Cookie: session } });
  const back = new URL(handOver.headers.get('location')!);
  expect(`${back.origin}${back.pathname}`).toBe(`https://view.test/${id}/signed-in`);

  const done = await getViewer(back.pathname + back.search, loginCookie);
  expect(done.status).toBe(303);
  expect(done.headers.get('location')).toBe(`/${id}`);
  expect(cookieOf(done, '__Host-campfile-login')).toContain('Max-Age=0');
  const owner = cookieOf(done, '__Host-campfile-owner');
  expect(owner).toContain(`Max-Age=${30 * 24 * 60 * 60}; HttpOnly; Secure; SameSite=Lax`);

  const page = await getViewer(`/${id}`, valueOf(owner));
  expect(page.status).toBe(302);
  expect(page.headers.get('location')).toBe(`https://app.test/p/${id}`);
  expect(await (await getViewer(`/${id}/raw`, valueOf(owner))).text()).toBe(served('<p>draft</p>'));
});

it('skips the code when the app session is there, and asks again with switch', async () => {
  const { id, owner } = await draft();
  const session = await sessionCookie(owner);

  const { state, location } = await startLogin(id);
  expect((await callApp(location.slice('https://app.test'.length), { headers: { Cookie: session } })).headers.get('location')).toMatch(
    new RegExp(`^https://view\\.test/${id}/signed-in\\?t=`),
  );

  const switched = await startLogin(id, '?switch=1');
  expect(switched.location).toBe(`https://app.test/viewer-login?page=${id}&state=${switched.state}&switch=1`);
  const toSignin = await callApp(switched.location.slice('https://app.test'.length), { headers: { Cookie: session } });
  expect(toSignin.headers.get('location')).toBe(`/signin?next=${encodeURIComponent(`/viewer-login?page=${id}&state=${switched.state}`)}`);
  expect(state).not.toBe(switched.state);
});

it('refuses a ticket in a browser without its state, with another state, after it expired, or forged', async () => {
  const { id, owner } = await draft();
  const { state, loginCookie } = await startLogin(id);
  const ticket = (forState: string, expires = now() + 60) => signedId(env.PREVIEW_SECRET, `ticket:${forState}`, owner, expires);
  const other = (await startLogin(id)).loginCookie;

  for (const [name, t, cookie] of [
    ['no state cookie (the link sent to someone else)', await ticket(state), ''],
    ['another browser state', await ticket(state), other],
    ['an expired ticket', await ticket(state, now() - 1), loginCookie],
    ['a forged ticket', `${owner}.9999999999.forged`, loginCookie],
    ['an owner cookie value as the ticket', await signedId(env.PREVIEW_SECRET, 'owner', owner, now() + 60), loginCookie],
  ]) {
    const response = await getViewer(`/${id}/signed-in?t=${t}`, cookie);
    expect(response.status, name).toBe(404);
    expect(await response.text(), name).toContain(`<a href="/${id}/login">Continue</a>`);
    expect(cookieOf(response, '__Host-campfile-owner'), name).toBeUndefined();
  }
  expect((await getViewer(`/${id}/signed-in?t=${await ticket(state)}`, loginCookie)).status).toBe(303); // the right one still works
});

it(`logs in with the email's link in the browser that asked: a GET signs in and goes on, again and again for ${LINK_MINUTES} minutes; a changed or expired link does not`, async () => {
  const { id, owner } = await draft();
  const next = `/viewer-login?page=${id}&state=${'a'.repeat(22)}`;
  const { link, cookie } = await askForLink(OWNER, next);
  // A mail scanner may open it first: it still works for the person after that.
  expect((await callApp(link)).headers.get('set-cookie')).toBeNull();
  for (let time = 0; time < 2; time++) {
    const response = await callApp(link, { headers: { Cookie: cookie } });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(next);
    expect(cookieOf(response, '__Host-campfile-session')).toContain('HttpOnly');
  }
  expect(await sql`select version from terms_acceptances where tester = ${owner}`).toEqual(HAS_TERMS ? [{ version: TERMS_VERSION }] : []);

  const changed = (key: string, value: string) => {
    const query = new URL(link, 'https://app.test').searchParams;
    query.set(key, value);
    return callApp(`/signin/link?${query}`, { headers: { Cookie: cookie } });
  };
  const nonce = new URL(link, 'https://app.test').searchParams.get('n')!;
  const expired = await signedId(env.CONSENT_SECRET, `link:${OWNER}:${TERMS_VERSION}:${nonce}`, 0, now() - 1);
  for (const refused of [
    await changed('email', 'bob@example.com'),
    await changed('v', '2000-01-01'),
    await changed('n', 'b'.repeat(22)),
    await changed('t', expired),
    await changed('t', `0.9999999999.forged`),
  ]) {
    expect(refused.status).toBe(400);
    expect(refused.headers.get('set-cookie')).toBeNull();
    expect(await refused.text()).toContain('That link has expired');
  }
  expect(await (await changed('email', 'bob@example.com')).text()).not.toContain('<form'); // only a link Campfile signed for that email offers a new one
  // `next` is checked like the login screen's: anywhere else, the link signs in and goes to the wall.
  const elsewhere = await changed('next', 'https://evil.test/');
  expect(elsewhere.status).toBe(303);
  expect(elsewhere.headers.get('location')).toBe('/my');
});

it("logs nobody in to someone else's workspace unnoticed: another site's login form is refused, and another browser's link needs a click", async () => {
  const { id, owner } = await draft();
  const next = `/p/${id}/manage`;
  const MALLORY = 'mallory@example.com';

  // Mallory's own code, posted to the login from her site (as browsers send it, or with her own Origin), or with neither header.
  const { link } = await askForLink(MALLORY, next);
  const crossSite = { 'Content-Type': form['Content-Type'], Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site' };
  for (const [name, headers] of [
    ['another site', crossSite],
    ['another no-referrer site', { ...crossSite, Origin: 'null' }],
    ['Origin null, no Sec-Fetch-Site', { 'Content-Type': form['Content-Type'], Origin: 'null' }],
    ['neither header', { 'Content-Type': form['Content-Type'] }],
  ] as const) {
    const posted = await callApp('/signin', { method: 'POST', headers, body: new URLSearchParams({ email: MALLORY, code: lastCode(MALLORY), next }) });
    expect(posted.status, name).toBe(403);
    expect(posted.headers.get('set-cookie'), name).toBeNull();
  }
  // A client without Sec-Fetch-Site still gets in with the app's exact Origin.
  const exactOrigin = await callApp('/signin', { method: 'POST', headers: { 'Content-Type': form['Content-Type'], Origin: 'https://app.test' }, body: new URLSearchParams({ email: 'x' }) });
  expect(exactOrigin.status).toBe(400);

  // Mallory's link in Amy's browser: no cookie, or Amy's own login attempt's cookie, signed in as Amy or not. Only a confirm screen naming Mallory.
  const amy = await askForLink(OWNER, next);
  const amySession = await sessionCookie(owner);
  for (const [name, cookie] of [['no cookie', ''], ["Amy's own login attempt", amy.cookie], ['signed in as Amy', `${amy.cookie}; ${amySession}`]]) {
    const opened = await callApp(link, { headers: { Cookie: cookie } });
    expect(opened.status, name).toBe(200);
    expect(await opened.text(), name).toContain(`Log in as ${MALLORY}?`);
    expect(opened.headers.get('set-cookie'), name).toBeNull();
  }
  // Amy's own link in that browser still logs her straight in.
  expect(cookieOf(await callApp(amy.link, { headers: { Cookie: amy.cookie } }), '__Host-campfile-session')).toBeDefined();

  // The confirm screen's button: refused from another site, a login as the named email from the app itself.
  const confirm = await (await callApp(link)).text();
  const fields = new URLSearchParams([...confirm.matchAll(/type="hidden" name="(\w+)" value="([^"]*)"/g)].map(([, name, value]) => [name, value]));
  const refused = await callApp('/signin/link', { method: 'POST', headers: crossSite, body: fields });
  expect(refused.status).toBe(403);
  expect(refused.headers.get('set-cookie')).toBeNull();
  const clicked = await callApp('/signin/link', { method: 'POST', headers: form, body: fields });
  expect(clicked.status).toBe(303);
  expect(clicked.headers.get('location')).toBe(next);
  const [mallory] = await sql<{ id: number }[]>`select id from testers where email = ${MALLORY}`;
  const session = valueOf(cookieOf(clicked, '__Host-campfile-session')).split('=')[1];
  expect(await readSignedId(env.CONSENT_SECRET, 'session', session)).toBe(mallory.id);
});

it('only hands over for a well-formed page id and state, and sign-in only goes back to the app or the hand-over', async () => {
  const { id, owner } = await draft();
  const session = await sessionCookie(owner);
  for (const query of [`?page=${id}&state=short`, `?page=../x&state=${'a'.repeat(22)}`, '?page=../x', `?state=${'a'.repeat(22)}`, '']) {
    expect((await callApp(`/viewer-login${query}`, { headers: { Cookie: session } })).status, query).toBe(400);
  }
  // An approval email's link has no state: the page's own Log in makes one, and comes back.
  const stateless = await callApp(`/viewer-login?page=${id}`, { headers: { Cookie: session } });
  expect(stateless.status).toBe(303);
  expect(stateless.headers.get('location')).toBe(`https://view.test/${id}/login`);
  const html = await (await callApp(`/signin?next=${encodeURIComponent('https://evil.test/')}`)).text();
  expect(html).toContain('name="next" value=""');
  expect(await (await callApp(`/signin?next=${encodeURIComponent(`/viewer-login?page=${id}`)}`)).text()).toContain(`name="next" value="/viewer-login?page=${id}"`);
  expect(await (await callApp(`/signin?next=${encodeURIComponent(`/viewer-login?page=${id}&switch=1`)}`)).text()).toContain('name="next" value=""');
  for (const back of ['/my', '/my/emails', `/p/${id}`, `/p/${id}/manage`]) expect(await (await callApp(`/signin?next=${encodeURIComponent(back)}`)).text()).toContain(`name="next" value="${back}"`);
  expect(await (await callApp(`/signin?next=${encodeURIComponent('/my/other')}`)).text()).toContain('name="next" value=""');
});

it('logs out of the viewer and the app', async () => {
  const { id, owner } = await draft();
  const out = await getViewer(`/${id}/logout`, await signedId(env.PREVIEW_SECRET, 'owner', owner, now() + 60));
  expect(out.status).toBe(303);
  expect(out.headers.get('location')).toBe(`https://app.test/signout?page=${id}`);
  expect(cookieOf(out, '__Host-campfile-owner')).toContain('Max-Age=0');

  const app = await callApp(`/signout?page=${id}`, { headers: { Cookie: await sessionCookie(owner) } });
  expect(app.status).toBe(303);
  expect(app.headers.get('location')).toBe(`https://view.test/${id}`);
  expect(cookieOf(app, '__Host-campfile-session')).toContain('Max-Age=0');
  expect((await callApp('/signout?page=https://evil.test')).headers.get('location')).toBe('/');
});

it('keeps a login from before the rename to campfile: the old cookie names still log in, and Log out ends them too', async () => {
  const { id, owner } = await draft();
  const old = (cookie: string) => cookie.replace('__Host-campfile-', '__Host-campfire-');
  const wall = async (cookie: string) => (await callApp('/my', { headers: { Cookie: cookie } })).headers.get('location');
  expect(await wall(old(await sessionCookie(owner)))).toBe(await wall(await sessionCookie(owner)));
  expect(await wall('')).not.toBe(await wall(await sessionCookie(owner)));
  const frame = async (cookie: string) => (await getViewer(`/${id}`, cookie)).headers.get('location');
  expect(await frame(old(await viewerLogin(owner)))).toBe(`https://app.test/p/${id}`);
  expect(await frame(await viewerLogin(owner))).toBe(`https://app.test/p/${id}`);
  expect(await frame('')).toBeNull();

  const out = await getViewer(`/${id}/logout`, '');
  for (const name of ['__Host-campfire-owner', `__Host-campfire-pass-${id}`]) expect(cookieOf(out, name)).toContain('Max-Age=0');
  expect(cookieOf(await callApp(`/signout?page=${id}`), '__Host-campfire-session')).toContain('Max-Age=0');
});

it('lands on the wall when the login names no page', async () => {
  await draft();
  await callApp('/signin', { method: 'POST', headers: form, body: new URLSearchParams({ email: OWNER }) });
  const signedIn = await callApp('/signin', { method: 'POST', headers: form, body: new URLSearchParams({ email: OWNER, code: lastCode(OWNER) }) });
  expect(signedIn.status).toBe(303);
  expect(signedIn.headers.get('location')).toBe('/my');
  expect((await callApp('/my', { headers: { Cookie: valueOf(cookieOf(signedIn, '__Host-campfile-session')) } })).status).toBe(200);
});

it('tells a self-hosted login without SMTP to take its code from the server log', async () => {
  const response = await callApp('/signin', { method: 'POST', headers: form, body: new URLSearchParams({ email: OWNER }) }, { ...env, EMAIL_IN_LOG: true });
  expect(await response.text()).toContain('<h1>Get your code from the server</h1>');
});
