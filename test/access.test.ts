import { expect, it, vi } from 'vitest';
import { HAS_TERMS } from '../src/hosted.ts';
import { CODES_PER_EMAIL_PER_HOUR, CODES_PER_IP_PER_DAY, EMAILS_PER_DAY, loginLink, signIn } from '../src/signin.ts';
import { addTester, api, callApp, callViewer, click, createPage, emails, env, form, getViewer, json, lastCode, ownerCookie, postViewer, served, sessionCookie, signup, sql, useCleanDatabase, viewerLogin, viewerOwner } from './helpers.ts';
import { stored } from './helpers.ts';
import { fakeBrowser } from './helpers.ts';

useCleanDatabase();

const OWNER = 'amy@example.com';
const VISITOR = 'ingrid@example.com';
const AMY = '<!--email_off-->amy<!--/email_off-->'; // the owner's name on viewer screens

/** Amy's draft, published with approval; `emails` are let in at once. */
async function approvalPage(emailsLetIn = '', bindings = env) {
  const tester = await addTester('amy');
  await sql`update testers set email = ${OWNER} where name = 'amy'`;
  const page = await createPage(tester, 'Secret plan', '<p>secret</p>');
  expect((await click('publish', page.id, bindings, { access: 'approval', emails: emailsLetIn })).status).toBe(303);
  return { ...page, tester };
}

const personId = async (id: string, address: string) =>
  (await sql<{ id: number }[]>`select id from page_people where page = ${id} and email = ${address}`)[0]?.id;
const statusOf = async (id: string, address: string) =>
  (await sql<{ status: string }[]>`select status from page_people where page = ${id} and email = ${address}`)[0]?.status;

/** The viewer cookie of someone who logged in with this email, as the one login sets it (their workspace is made on the first login). */
const loggedIn = async (address: string) => viewerLogin(await signIn(sql, address, null, signup));
/** A logged-in visitor clicks Ask. */
const ask = async (id: string, address: string) => postViewer(`/${id}/ask`, {}, await loggedIn(address));

/** What a browser gets at the page's public link: the page in its frame, or the gate. `more` are request headers besides the cookie. */
const opens = async (id: string, cookie = '', more: Record<string, string> = {}) =>
  (await (await callViewer(`/${id}`, undefined, { headers: { Cookie: cookie, ...more } })).text()).includes('<iframe');

const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))!.split(';')[0];

/** A browser opens the invite in an approval email: the viewer's Log in, then the app's hand-over, with `appCookie` if it is signed in there. */
async function openInvite(text: string, appCookie = '') {
  const link = new URL(text.match(/https:\/\/view\.test\/\S+/)![0]);
  const login = await getViewer(link.pathname + link.search, '');
  const handOver = new URL(login.headers.get('location')!);
  return { loginCookie: cookieOf(login, '__Host-campfile-login'), next: `/viewer-login?page=${handOver.searchParams.get('page')}&state=${handOver.searchParams.get('state')}`, response: await callApp(handOver.pathname + handOver.search, { headers: { Cookie: appCookie } }) };
}

/** Someone not logged in types their email at the gate and asks, from the network `ip`. */
const askWithEmail = (id: string, address: string, ip = '203.0.113.7') =>
  callViewer(`/${id}/ask`, 'https://view.test', { method: 'POST', headers: { ...form, 'Campfile-Client-IP': ip }, body: new URLSearchParams({ email: address }) });
/** The owner clicks Approve on the app. */
const ownerApproves = async (id: string, address: string) =>
  callApp(`/p/${id}/people/${await personId(id, address)}`, { method: 'POST', headers: { ...form, Cookie: await ownerCookie(id) }, body: 'decision=approve' });

it("publishes with approval: no link preview, and /raw and the page stay shut to visitors; the owner, logged in on the viewer, is sent on to the app, where /raw still opens for them; the owner's screenshot gets the framed page", async () => {
  let bindings = env;
  const { browser, requests } = fakeBrowser();
  bindings = { ...env, BROWSER: browser };
  const made = await approvalPage('', bindings);
  const { id } = made;
  const { url } = made;
  expect((await callViewer(`/${id}/raw`)).status).toBe(404);

  expect(stored('previews/')).toHaveLength(1); // the owner's screenshot, for the wall
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(404);
  // The shot is taken logged in as the owner, for a few minutes only, so it shows the page and not the gate.
  expect(requests.map((request) => request.url)).toEqual([url]);
  const [login] = requests[0].cookies!;
  expect(login).toMatchObject({ name: '__Host-campfile-owner', url: 'https://view.test', path: '/', secure: true, httpOnly: true });
  expect(Number(login.value.split('.')[1])).toBeLessThanOrEqual(Date.now() / 1000 + 300);
  const shot = `${login.name}=${login.value}`;
  expect(await opens(id, shot, { 'Campfile-Screenshot': '1' })).toBe(true); // The screenshot service is no browser of the owner's: the framed page, not the app's
  expect((await getViewer(`/${id}`, shot)).status).toBe(302); // the same login in any other browser is the owner's

  const visitor = await (await callViewer(`/${id}`)).text();
  expect(visitor).not.toContain('<iframe');
  expect(visitor).not.toContain('og:image');
  expect(visitor).not.toContain('secret</p>');
  expect(visitor).toContain(`Only people ${AMY} lets in can open this page. Type your email to ask ${AMY} for access.`);
  expect(visitor).toContain(`<form method="post" action="/${id}/ask">`);
  expect(visitor).toContain(`<button type="submit">Ask ${AMY}</button>`);
  expect(visitor).toContain(`Already let in, or is this your page? <a href="/${id}/login">Log in</a>`);

  const cookie = await viewerOwner(id);
  const owner = await getViewer(`/${id}`, cookie);
  expect(owner.status).toBe(302);
  expect(owner.headers.get('location')).toBe(`https://app.test/p/${id}`); // the owner's page view, which frames /raw with a ticket
  expect(await (await getViewer(`/${id}/raw`, cookie)).text()).toBe(served('<p>secret</p>'));
});

it("sends an owner who types their own email at the gate to Log in, which the gate's form-action allows to go on to the app's login, since browsers apply it to redirects", async () => {
  const { id } = await approvalPage();
  const gate = await callViewer(`/${id}`);
  const allowed = gate.headers.get('content-security-policy')!.match(/form-action ([^;]+)/)![1].replace("'self'", 'https://view.test').split(' ');
  const asked = await postViewer(`/${id}/ask`, { email: OWNER });
  expect(asked.status).toBe(303);
  expect(asked.headers.get('location')).toBe(`/${id}/login`);
  const login = await callViewer(asked.headers.get('location')!);
  expect(login.status).toBe(303);
  expect(allowed).toContain(new URL(login.headers.get('location')!).origin);
  expect(await sql`select 1 from page_people`).toHaveLength(0);
  expect(emails).toEqual([]);
});

it('lets a logged-in visitor ask once, then in after the owner approves, with an email saying so; for this page only, until Remove', async () => {
  const { id, tester } = await approvalPage();
  const [{ owner }] = await sql<{ owner: number }[]>`select owner from pages where id = ${id}`;
  const second = await createPage(await addTester('bob'), 'Other', '<p>other</p>');
  expect((await click('publish', second.id, env, { access: 'approval' })).status).toBe(303);
  const cookie = await loggedIn(VISITOR);

  const gate = await (await getViewer(`/${id}`, cookie)).text();
  expect(gate).toContain(`You're logged in as <strong><!--email_off-->${VISITOR}<!--/email_off--></strong>`);
  expect(gate).toContain(`action="/${id}/ask"`);
  const asked = await postViewer(`/${id}/ask`, {}, cookie);
  expect(asked.status).toBe(303);
  expect(asked.headers.get('location')).toBe(`/${id}`);
  expect(emails).toHaveLength(1);
  expect(emails[0].to).toEqual([OWNER]);
  expect(emails[0].text).toContain(`https://app.test/p/${id}/manage`);
  expect(await statusOf(id, VISITOR)).toBe('waiting');
  expect(await opens(id, cookie)).toBe(false);
  expect(await (await getViewer(`/${id}`, cookie)).text()).toContain(`You asked ${AMY} for access`);

  // Asking again, while waiting, sends nothing.
  expect((await postViewer(`/${id}/ask`, {}, cookie)).status).toBe(303);
  expect(emails).toHaveLength(1);

  // Someone signed in to another workspace cannot decide.
  const notOwner = await callApp(`/p/${id}/people/${await personId(id, VISITOR)}`, {
    method: 'POST',
    headers: { ...form, Cookie: await sessionCookie(owner + 1) },
    body: 'decision=approve',
  });
  expect(notOwner.status).toBe(404);
  expect(await statusOf(id, VISITOR)).toBe('waiting');

  const approve = await callApp(`/p/${id}/people/${await personId(id, VISITOR)}`, {
    method: 'POST',
    headers: { ...form, Cookie: await sessionCookie(owner) },
    body: 'decision=approve',
  });
  expect(approve.status).toBe(303);
  expect(emails).toHaveLength(2);
  // They asked, so the email logs them in: a link and a code, and a first line saying who let them in.
  expect(emails[1]).toMatchObject({ to: [VISITOR], subject: 'amy let you in on Campfile' }); // the owner's title stays out of the subject
  expect(emails[1].text).toContain('amy let you in to “Secret plan” on Campfile.\n\nLog in to Campfile with this link:\nhttps://app.test/signin/link?');
  expect(emails[1].text).toMatch(/\nOr type this code: \d{6}\n/);

  expect(await opens(id, cookie)).toBe(true);
  const frame = await (await getViewer(`/${id}`, cookie)).text();
  expect(frame).toContain(`href="/${id}/logout"`); // a logged-in visitor's bar: Log out, not Log in
  const src = frame.match(/<iframe[^>]* src="([^"]+)"/)![1];
  expect(await (await getViewer(src, cookie)).text()).toBe(served('<p>secret</p>'));
  expect((await callViewer(src)).status).toBe(404); // the iframe address alone, in another browser

  // Approval is for this page only.
  expect(await opens(second.id, cookie)).toBe(false);

  const remove = await callApp(`/p/${id}/people/${await personId(id, VISITOR)}`, {
    method: 'POST',
    headers: { ...form, Cookie: await sessionCookie(owner) },
    body: 'decision=remove',
  });
  expect(remove.status).toBe(303);
  expect(await opens(id, cookie)).toBe(false);
  // The iframe address saved before Remove is shut too, also for content the owner adds afterwards.
  expect((await api(tester, 'PUT', `/api/pages/${id}`, { html: '<p>new secret</p>' })).status).toBe(200);
  const saved = await getViewer(src, cookie);
  expect(saved.status).toBe(404);
  expect(await saved.text()).not.toContain('new secret');
});

it("files a logged-in visitor's request but emails the owner nothing once the day's emails are all sent", async () => {
  const { id } = await approvalPage();
  const cookie = await loggedIn(VISITOR);
  await sql`insert into signin_sends (email, ip) select 'someone@example.com', '192.0.2.1' from generate_series(1, ${EMAILS_PER_DAY}::int)`;
  const before = emails.length;
  expect((await postViewer(`/${id}/ask`, {}, cookie)).status).toBe(303);
  expect(await statusOf(id, VISITOR)).toBe('waiting');
  expect(emails).toHaveLength(before);
});

it('lets someone who is not logged in ask with only their email: a waiting request, the owner emailed at once, and a screen to wait on', async () => {
  const { id } = await approvalPage();
  const asked = await askWithEmail(id, ` ${VISITOR.toUpperCase()} `);
  expect(asked.status).toBe(303);
  expect(asked.headers.get('location')).toBe(`/${id}?email=${encodeURIComponent(VISITOR)}`);
  expect(await statusOf(id, VISITOR)).toBe('waiting');
  expect(emails).toHaveLength(1);
  expect(emails[0]).toMatchObject({ to: [OWNER], subject: `${VISITOR} wants to see Secret plan` });
  expect(emails[0].text).toContain(`https://app.test/p/${id}/manage`);
  expect(emails[0].text).toContain("The visitor typed this email, and Campfile hasn't checked that it belongs to them: it only opens the page for whoever can read that inbox.");

  const screen = await getViewer(asked.headers.get('location')!, '');
  const html = await screen.text();
  expect(screen.status).toBe(200);
  expect(html).toContain(`${AMY} will get your request. When ${AMY} lets you in, you'll get an email with a login link and a 6&#8209;digit code. Click the link, or type the code here.`);
  expect(html).toContain(`<form method="post" action="/${id}/enter">`);
  expect(html).toContain('autocomplete="one-time-code"');
  expect(html).toContain('<button type="submit">Open the page</button>');
  expect(html.includes('By continuing you accept the <a href="https://app.test/terms">Terms</a> and <a href="https://app.test/privacy">Privacy Policy</a>.')).toBe(HAS_TERMS);
  expect(html).toContain(`You typed <strong><!--email_off-->${VISITOR}<!--/email_off--></strong>. Wrong email? <a href="/${id}">Start again</a>`);
  expect(html).not.toContain('<iframe');
  expect(await opens(id)).toBe(false);

  // Asking again, or after a no, files nothing, emails nobody, and looks the same.
  expect((await askWithEmail(id, VISITOR)).headers.get('location')).toBe(asked.headers.get('location'));
  await sql`update page_people set status = 'denied' where page = ${id}`;
  expect((await askWithEmail(id, VISITOR)).headers.get('location')).toBe(asked.headers.get('location'));
  expect(emails).toHaveLength(1);
  expect(await sql`select 1 from page_people`).toHaveLength(1);
  expect(await statusOf(id, VISITOR)).toBe('denied');
});

it('emails the requester a login link and a code when the owner approves; the code, typed at the gate, opens the page and accepts the terms', async () => {
  const { id } = await approvalPage();
  await askWithEmail(id, VISITOR);
  expect((await ownerApproves(id, VISITOR)).status).toBe(303);
  expect(emails).toHaveLength(2);
  expect(emails[1]).toMatchObject({ to: [VISITOR], subject: 'amy let you in on Campfile' });
  const code = lastCode(VISITOR);

  // A wrong code shows the code screen again, with the email kept; it logs nobody in.
  const wrong = await postViewer(`/${id}/enter`, { email: VISITOR, code: code === '000000' ? '111111' : '000000' });
  expect(wrong.status).toBe(400);
  const retry = await wrong.text();
  expect(retry).toContain('That code is wrong or has expired.');
  expect(retry).toContain(`<input type="hidden" name="email" value="${VISITOR}">`);
  expect(wrong.headers.getSetCookie()).toEqual([]);

  // The right code posted from another site logs nobody in (login CSRF), and does not use it up.
  const crossSite = await callViewer(`/${id}/enter`, 'https://view.test', { method: 'POST', headers: { 'Content-Type': form['Content-Type'], Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site' }, body: new URLSearchParams({ email: VISITOR, code }) });
  expect(crossSite.status).toBe(403);
  // The right one, as people paste it with a space, logs this browser in and opens the page.
  const entered = await postViewer(`/${id}/enter`, { email: VISITOR, code: `${code.slice(0, 3)} ${code.slice(3)}` });
  expect(entered.status).toBe(303);
  expect(entered.headers.get('location')).toBe(`/${id}`);
  const cookie = cookieOf(entered, '__Host-campfile-owner');
  expect(await opens(id)).toBe(false);
  expect(await opens(id, cookie)).toBe(true);
  expect(await sql`select 1 from terms_acceptances where email = ${VISITOR}`).toHaveLength(HAS_TERMS ? 1 : 0);
  expect((await postViewer(`/${id}/enter`, { email: VISITOR, code })).status).toBe(400); // used up
});

it("logs in from the link in the approval email, in any browser, and ends on the page: its hand-over carries no state, so the page's own Log in makes one", async () => {
  const { id } = await approvalPage();
  await askWithEmail(id, VISITOR);
  await ownerApproves(id, VISITOR);
  const link = new URL(emails[1].text.match(/https:\/\/app\.test\/signin\/link\?\S+/)![0]);
  expect(link.searchParams.get('next')).toBe(`/viewer-login?page=${id}`);

  // This browser never asked for the link, so it confirms with one click.
  const confirm = await callApp(link.pathname + link.search);
  expect(confirm.status).toBe(200);
  expect(await confirm.text()).toContain(`<h1>Log in as ${VISITOR}?</h1>`);
  const clicked = await callApp('/signin/link', { method: 'POST', headers: form, body: link.searchParams });
  expect(clicked.status).toBe(303);
  expect(clicked.headers.get('location')).toBe(`/viewer-login?page=${id}`);
  const session = cookieOf(clicked, '__Host-campfile-session');

  const bounce = await callApp(clicked.headers.get('location')!, { headers: { Cookie: session } });
  expect(bounce.headers.get('location')).toBe(`https://view.test/${id}/login`);
  const login = await getViewer(`/${id}/login`, '');
  const handOver = new URL(login.headers.get('location')!);
  const back = new URL((await callApp(handOver.pathname + handOver.search, { headers: { Cookie: session } })).headers.get('location')!);
  const done = await getViewer(back.pathname + back.search, cookieOf(login, '__Host-campfile-login'));
  expect(done.headers.get('location')).toBe(`/${id}`);
  expect(await opens(id, cookieOf(done, '__Host-campfile-owner'))).toBe(true);
});

it('emails a sign-in code at once to an email that is let in already when it asks at the gate; typed there, the code opens the page', async () => {
  const { id } = await approvalPage(VISITOR);
  expect(emails.map((sent) => sent.to)).toEqual([[VISITOR]]); // the invite
  const asked = await askWithEmail(id, VISITOR);
  expect(asked.headers.get('location')).toBe(`/${id}?email=${encodeURIComponent(VISITOR)}`);
  expect(emails.map((sent) => sent.to)).toEqual([[VISITOR], [VISITOR]]); // the owner is not emailed
  expect(emails[1].subject).toBe(`${lastCode(VISITOR)} is your Campfile sign-in code`);
  expect(await statusOf(id, VISITOR)).toBe('approved');
  const entered = await postViewer(`/${id}/enter`, { email: VISITOR, code: lastCode(VISITOR) });
  expect(await opens(id, cookieOf(entered, '__Host-campfile-owner'))).toBe(true);
});

it('files nothing when a visitor logs in at the gate, so a link from another site cannot send their email to the owner; the gate offers Ask', async () => {
  const { id } = await approvalPage();
  const person = await signIn(sql, VISITOR, null, signup);
  // Signed in on the app already, Log in comes straight back with no screen: exactly what another site's link to /:id/login gets.
  const login = await getViewer(`/${id}/login`, '');
  const handOver = new URL(login.headers.get('location')!);
  const back = new URL((await callApp(handOver.pathname + handOver.search, { headers: { Cookie: await sessionCookie(person) } })).headers.get('location')!);
  const done = await getViewer(back.pathname + back.search, cookieOf(login, '__Host-campfile-login'));
  expect(done.status).toBe(303);
  expect(await statusOf(id, VISITOR)).toBeUndefined();
  expect(emails).toEqual([]);
  const gate = await (await getViewer(`/${id}`, cookieOf(done, '__Host-campfile-owner'))).text();
  expect(gate).toContain(`action="/${id}/ask"`);
});

it('an invite opens nothing while its page is unpublished, open to anyone with the link, or its owner is disabled, and uses no opens then', async () => {
  const { id, tester } = await approvalPage(VISITOR);
  const invite = emails[0].text;
  const givesPass = async () => /\/signed-in\?pass=/.test((await openInvite(invite)).response.headers.get('location') ?? '');

  expect((await api(tester, 'POST', `/api/pages/${id}/unpublish`)).status).toBe(200);
  expect(await givesPass()).toBe(false);
  expect((await api(tester, 'POST', `/api/pages/${id}/publish`, { access: 'link' })).status).toBe(200);
  expect(await givesPass()).toBe(false);
  expect((await api(tester, 'POST', `/api/pages/${id}/publish`, { access: 'approval' })).status).toBe(200);
  await sql`update testers set disabled_at = now() where id = (select owner from pages where id = ${id})`;
  expect(await givesPass()).toBe(false);
  expect(await sql`select invite_opens from page_people where page = ${id}`).toEqual([{ invite_opens: 0 }]);

  await sql`update testers set disabled_at = null where id = (select owner from pages where id = ${id})`;
  expect(await givesPass()).toBe(true); // still let in, still within its days: the invite works again
});

it('invites everyone let in: its link gives that browser a pass to this page alone, up to 5 times in 7 days, then offers a fresh invite to their email; Say no and Remove end the invite and the pass', async () => {
  const { id, tester } = await approvalPage(`${VISITOR}, omar@example.com`);
  const [{ owner }] = await sql<{ owner: number }[]>`select owner from pages where id = ${id}`;
  expect(emails.map((sent) => sent.to)).toEqual([[VISITOR], ['omar@example.com']]);
  const [invite, omarsInvite] = emails.map((sent) => sent.text);
  expect(invite.includes('/terms')).toBe(HAS_TERMS);
  const second = await createPage(tester, 'Second plan', '<p>second</p>');
  expect((await click('publish', second.id, env, { access: 'approval', emails: VISITOR })).status).toBe(303);

  // Opening it accepts the terms and gives this browser a pass, not a login: no app session and no viewer login, so a forwarded invite opens this page and nothing else of that email's.
  const { loginCookie, response: signedIn } = await openInvite(invite);
  expect(signedIn.headers.get('set-cookie')).toBeNull();
  expect(await sql`select email from terms_acceptances`).toEqual(HAS_TERMS ? [{ email: VISITOR }] : []);
  const back = new URL(signedIn.headers.get('location')!);
  expect(back.origin + back.pathname).toBe(`https://view.test/${id}/signed-in`);
  // Its hand-over sets nothing in another browser, or for another page.
  expect((await getViewer(back.pathname + back.search, '')).headers.getSetCookie()).toEqual([]);
  expect((await getViewer(`/${second.id}/signed-in${back.search}`, loginCookie)).headers.getSetCookie()).toEqual([]);
  const done = await getViewer(back.pathname + back.search, loginCookie);
  expect(done.headers.get('location')).toBe(`/${id}`);
  expect(done.headers.getSetCookie().some((set) => set.startsWith('__Host-campfile-owner='))).toBe(false);
  const passSet = done.headers.getSetCookie().find((set) => set.startsWith(`__Host-campfile-pass-${id}=`))!;
  expect(passSet).toContain(`Max-Age=${30 * 24 * 60 * 60}; HttpOnly; Secure; SameSite=Lax`);
  const pass = passSet.split(';')[0];
  expect(await opens(id, pass)).toBe(true);
  expect((await getViewer(`/${id}/raw`, pass)).status).toBe(200);
  // A disabled workspace's pass opens nothing, as its login would not.
  await sql`update testers set disabled_at = now() where email = ${VISITOR}`;
  expect(await opens(id, pass)).toBe(false);
  await sql`update testers set disabled_at = null where email = ${VISITOR}`;
  // Only this page: not another page that lets the same email in, not even with the pass renamed for it.
  expect(await opens(second.id, pass)).toBe(false);
  expect(await opens(second.id, pass.replace(id, second.id))).toBe(false);
  expect((await getViewer(`/${second.id}/raw`, pass.replace(id, second.id))).status).toBe(404);
  const [{ id: visitor }] = await sql<{ id: number }[]>`select id from testers where email = ${VISITOR}`;
  const session = await sessionCookie(visitor);

  // Opened again, even in a browser logged in as someone else, it gives a pass up to 5 times in all, so a mail scanner's opens leave the person some.
  for (let open = 2; open <= 5; open++) {
    expect((await openInvite(invite, await sessionCookie(owner))).response.headers.get('location')).toMatch(new RegExp(`^https://view\\.test/${id}/signed-in\\?pass=`));
  }

  // The sixth open offers a fresh invite to their email: the address and one button; the owner's title stays off the app's screens.
  const used = await (await openInvite(invite)).response.text();
  expect(used).toContain('<h1>amy shared a page with you</h1>');
  expect(used).toContain(`<strong>${VISITOR}</strong>`);
  expect(used).toContain('Email me a new link');
  expect(used).not.toContain('Secret plan');
  // Not you? logs out (here: someone else logged in on the viewer) and lands on the gate's email box, so the owner decides before any code is sent.
  expect(used).toContain(`Not you? <a href="https://view.test/${id}/logout">Ask with another email</a>`);
  const out = await getViewer(`/${id}/logout`, await loggedIn('someone@example.com'));
  expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  expect(out.headers.getSetCookie().find((set) => set.startsWith(`__Host-campfile-pass-${id}=`))).toContain('Max-Age=0'); // and this page's pass
  const signedOut = await callApp(new URL(out.headers.get('location')!).pathname + new URL(out.headers.get('location')!).search);
  expect(signedOut.headers.get('location')).toBe(`https://view.test/${id}`);
  expect(await (await callViewer(`/${id}`)).text()).toContain('name="email"');
  // Past its 7 days, an unused invite does the same.
  await sql`update page_people set invite_until = now() - interval '1 second' where email = 'omar@example.com'`;
  expect(await (await openInvite(omarsInvite)).response.text()).toContain('Email me a new link');

  // Signed in on the app as that email: straight through. As someone else: the fresh invite for the invited email.
  expect((await openInvite(invite, session)).response.headers.get('location')).toMatch(new RegExp(`^https://view\\.test/${id}/signed-in\\?t=`));
  expect(await (await openInvite(invite, await sessionCookie(owner))).response.text()).toContain(`<strong>${VISITOR}</strong>`);
  // A forged invite, or one for another page, fills in nothing: the plain login.
  expect((await openInvite(invite.replace(/invite=\d+/, 'invite=999'))).response.headers.get('location')).toMatch(/^\/signin\?next=/);
  const other = await createPage(tester, 'Other', '<p>other</p>');
  expect((await openInvite(invite.replace(`/${id}/`, `/${other.id}/`))).response.headers.get('location')).toMatch(/^\/signin\?next=/);

  // Say no ends Omar's invite, and he cannot ask again; Remove ends Ingrid's.
  await callApp(`/p/${id}/people/${await personId(id, 'omar@example.com')}`, { method: 'POST', headers: { ...form, Cookie: await sessionCookie(owner) }, body: 'decision=deny' });
  expect((await openInvite(omarsInvite)).response.headers.get('location')).toMatch(/^\/signin\?next=/);
  const sent = emails.length;
  expect((await ask(id, 'omar@example.com')).status).toBe(303);
  expect(emails).toHaveLength(sent);
  expect(await statusOf(id, 'omar@example.com')).toBe('denied');
  await callApp(`/p/${id}/people/${await personId(id, VISITOR)}`, { method: 'POST', headers: { ...form, Cookie: await sessionCookie(owner) }, body: 'decision=remove' });
  expect((await openInvite(invite)).response.headers.get('location')).toMatch(/^\/signin\?next=/);
  expect(await opens(id, pass)).toBe(false); // its pass shuts too
  // Nor does a fresh invite come for it: Remove ended who it names.
  const before = emails.length;
  const token = new URL(invite.match(/https:\/\/\S+invite=\S+/)![0]).searchParams.get('invite')!;
  const renewed = await callApp('/signin/renew', { method: 'POST', headers: form, body: new URLSearchParams({ page: id, invite: token }) });
  expect(await renewed.text()).toContain('That link no longer works');
  expect(emails).toHaveLength(before);
});

it('Say no ends an invite and its pass for good: approved again, neither opens the page, nor after a renewed invite, which alone opens it', async () => {
  const { id } = await approvalPage(VISITOR);
  const [{ owner }] = await sql<{ owner: number }[]>`select owner from pages where id = ${id}`;
  const decision = async (body: string) =>
    callApp(`/p/${id}/people/${await personId(id, VISITOR)}`, { method: 'POST', headers: { ...form, Cookie: await sessionCookie(owner) }, body });
  const { loginCookie, response } = await openInvite(emails[0].text);
  const first = new URL(response.headers.get('location')!);
  const pass = cookieOf(await getViewer(first.pathname + first.search, loginCookie), `__Host-campfile-pass-${id}`);
  const later = await openInvite(emails[0].text); // a second hand-over, kept for after Say no
  expect(await opens(id, pass)).toBe(true);

  await decision('decision=deny');
  await decision('decision=approve');
  expect(await statusOf(id, VISITOR)).toBe('approved');
  expect(await (await openInvite(emails[0].text)).response.text()).toContain('Email me a new link');
  expect(await opens(id, pass)).toBe(false);
  // Its ticket, still within its 60 seconds, carries the approval it was opened under: shut too.
  const ticket = new URL(later.response.headers.get('location')!);
  expect(await opens(id, cookieOf(await getViewer(ticket.pathname + ticket.search, later.loginCookie), `__Host-campfile-pass-${id}`))).toBe(false);

  // Whoever holds the old invite (a forward) renews it: the new one goes to Ingrid, and the old invite and its pass stay shut.
  const token = new URL(emails[0].text.match(/https:\/\/\S+invite=\S+/)![0]).searchParams.get('invite')!;
  expect(await (await callApp('/signin/renew', { method: 'POST', headers: form, body: new URLSearchParams({ page: id, invite: token }) })).text()).toContain('Check your email');
  const renewed = emails.at(-1)!;
  expect(renewed.to).toEqual([VISITOR]);
  expect(await (await openInvite(emails[0].text)).response.text()).toContain('Email me a new link');
  expect(await opens(id, pass)).toBe(false);
  expect((await openInvite(renewed.text)).response.headers.get('location')).toMatch(new RegExp(`^https://view\\.test/${id}/signed-in\\?pass=`));
});

it('Say no while an open of the invite is still recording the terms: the ticket it then hands over gives no pass', async () => {
  const { id } = await approvalPage(VISITOR);
  await signIn(sql, VISITOR, null, signup); // the workspace exists, so its row can be held
  const [{ owner }] = await sql<{ owner: number }[]>`select owner from pages where id = ${id}`;
  // Hold Ingrid's workspace row: the open uses its invite, then waits in signIn until it is let go.
  const held = Promise.withResolvers<void>();
  const letGo = Promise.withResolvers<void>();
  const hold = sql.begin(async (tx) => {
    await tx`select 1 from testers where email = ${VISITOR} for update`;
    held.resolve();
    await letGo.promise;
  });
  await held.promise;
  const opening = openInvite(emails[0].text);
  // The open runs in the app's own connection, with no signal to await: poll the row until its invite is used.
  while ((await sql<{ invite_opens: number }[]>`select invite_opens from page_people where page = ${id}`)[0].invite_opens === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  for (const body of ['decision=deny', 'decision=approve'])
    await callApp(`/p/${id}/people/${await personId(id, VISITOR)}`, { method: 'POST', headers: { ...form, Cookie: await sessionCookie(owner) }, body });
  letGo.resolve();
  await hold;
  const { loginCookie, response } = await opening;
  const ticket = new URL(response.headers.get('location')!);
  expect(ticket.pathname).toBe(`/${id}/signed-in`);
  expect(await opens(id, cookieOf(await getViewer(ticket.pathname + ticket.search, loginCookie), `__Host-campfile-pass-${id}`))).toBe(false);
});

it('a renewal in the same second as the last send still ends the older link: every send signs a later expiry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Math.floor(Date.now() / 1000) * 1000); // frozen: every send below in this one second
    const { id } = await approvalPage(VISITOR);
    const old = emails[0].text;
    for (let open = 1; open <= 5; open++) await openInvite(old);
    const token = new URL(old.match(/https:\/\/\S+invite=\S+/)![0]).searchParams.get('invite')!;
    expect(await (await callApp('/signin/renew', { method: 'POST', headers: form, body: new URLSearchParams({ page: id, invite: token }) })).text()).toContain('Check your email');
    const renewed = emails.at(-1)!.text;
    expect(renewed).not.toBe(old);
    expect(await (await openInvite(old)).response.text()).toContain('Email me a new link');
    expect((await openInvite(renewed)).response.headers.get('location')).toMatch(new RegExp(`^https://view\\.test/${id}/signed-in\\?pass=`));

    // Say no, Approve and a renewal, still in that second: the renewed link before it opens nothing either.
    const [{ owner }] = await sql<{ owner: number }[]>`select owner from pages where id = ${id}`;
    for (const body of ['decision=deny', 'decision=approve'])
      await callApp(`/p/${id}/people/${await personId(id, VISITOR)}`, { method: 'POST', headers: { ...form, Cookie: await sessionCookie(owner) }, body });
    const renewedToken = new URL(renewed.match(/https:\/\/\S+invite=\S+/)![0]).searchParams.get('invite')!;
    expect(await (await callApp('/signin/renew', { method: 'POST', headers: form, body: new URLSearchParams({ page: id, invite: renewedToken }) })).text()).toContain('Check your email');
    expect(await (await openInvite(renewed)).response.text()).toContain('Email me a new link');
  } finally {
    vi.useRealTimers();
  }
});

it('renews from an approval login link at most 30 days old, only while its email is let in to a published approval page with an active owner, within the send limits', async () => {
  const { id, tester } = await approvalPage(VISITOR);
  const fields = Object.fromEntries(new URL(await loginLink(env, VISITOR, `/viewer-login?page=${id}`, 'n'.repeat(22))).searchParams);
  const renew = () => callApp('/signin/renew', { method: 'POST', headers: form, body: new URLSearchParams(fields) });
  const sends = async () => {
    const before = emails.length;
    const text = await (await renew()).text();
    return emails.length > before && text.includes('Check your email');
  };
  expect(await sends()).toBe(true);
  expect(emails.at(-1)!.to).toEqual([VISITOR]);

  expect((await api(tester, 'POST', `/api/pages/${id}/unpublish`)).status).toBe(200);
  expect(await sends()).toBe(false);
  expect((await api(tester, 'POST', `/api/pages/${id}/publish`, { access: 'link' })).status).toBe(200);
  expect(await sends()).toBe(false);
  expect((await api(tester, 'POST', `/api/pages/${id}/publish`, { access: 'approval' })).status).toBe(200);
  await sql`update testers set disabled_at = now() where id = (select owner from pages where id = ${id})`;
  expect(await sends()).toBe(false);
  await sql`update testers set disabled_at = null where id = (select owner from pages where id = ${id})`;
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(await sends()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
  // Past the per-email limit (the first invite and the renewal above count): "Not sent", the person stays let in.
  for (let sent = 2; sent < CODES_PER_EMAIL_PER_HOUR; sent++) expect(await sends()).toBe(true);
  const over = await renew();
  expect(over.status).toBe(429);
  expect(await over.text()).toContain('Not sent');
  expect(await statusOf(id, VISITOR)).toBe('approved');

  await sql`delete from page_people where page = ${id}`;
  expect(await (await renew()).text()).toContain('That link no longer works');
});

it("files no request without an email, or from the owner; a disabled workspace's login counts for nothing", async () => {
  const { id } = await approvalPage();
  expect((await postViewer(`/${id}/ask`, {})).status).toBe(400);
  const invalid = await postViewer(`/${id}/ask`, { email: 'not an email' });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).toContain('value="not an email"'); // kept, to fix
  expect((await ask(id, OWNER)).status).toBe(303);
  const cookie = await loggedIn(VISITOR);
  await sql`update testers set disabled_at = now() where email = ${VISITOR}`;
  expect((await postViewer(`/${id}/ask`, {}, cookie)).status).toBe(400);
  expect(await (await getViewer(`/${id}`, cookie)).text()).toContain(`action="/${id}/ask">\n<label for="email">`); // the gate asks for an email, like anyone's
  expect(await sql`select 1 from page_people`).toHaveLength(0);
  expect(emails).toEqual([]);
});

it(`lets one network ask ${CODES_PER_IP_PER_DAY} times a day with typed emails, so nobody can flood an owner with made-up ones; past that, nothing is filed`, async () => {
  const { id } = await approvalPage();
  for (let i = 0; i < CODES_PER_IP_PER_DAY; i++) expect((await askWithEmail(id, `made-up${i}@example.com`)).status).toBe(303);
  const refused = await askWithEmail(id, 'one-more@example.com');
  expect(refused.status).toBe(429);
  expect(await refused.text()).toContain('Too many codes were asked for from this network');
  expect(await statusOf(id, 'one-more@example.com')).toBeUndefined();
  expect(await sql`select 1 from page_people`).toHaveLength(CODES_PER_IP_PER_DAY);
  expect((await askWithEmail(id, 'other-network@example.com', '203.0.113.8')).status).toBe(303);
});

it(`lets an owner email at most ${CODES_PER_IP_PER_DAY} people a day by approving; past that, people are let in without an email`, async () => {
  const { id, tester } = await approvalPage();
  await sql`insert into page_people (page, email, status) select ${id}, 'p' || i || '@example.com', 'waiting' from generate_series(0, ${CODES_PER_IP_PER_DAY}) i`;
  const approve = (i: number) => api(tester, 'POST', `/api/pages/${id}/people/decide`, { email: `p${i}@example.com`, decision: 'approve' });
  for (let i = 0; i < CODES_PER_IP_PER_DAY; i++) expect((await approve(i)).status).toBe(200);
  const refused = await approve(CODES_PER_IP_PER_DAY);
  expect(refused.status).toBe(429);
  expect((await json(refused)).error).toContain(`Let in anyway, without an email: p${CODES_PER_IP_PER_DAY}@example.com.`);
  expect(await statusOf(id, `p${CODES_PER_IP_PER_DAY}@example.com`)).toBe('approved');
  // Letting several in at once names everyone who got no invite.
  const many = await api(tester, 'POST', `/api/pages/${id}/people`, { emails: 'q1@example.com, q2@example.com' });
  expect(many.status).toBe(429);
  expect((await json(many)).error).toContain('Let in anyway, without an email: q1@example.com, q2@example.com.');
  expect(await statusOf(id, 'q2@example.com')).toBe('approved');
  expect(emails).toHaveLength(CODES_PER_IP_PER_DAY);
});

it('emails the owner about at most 10 new requests a day, even after they are decided or removed, and takes no more than 100 waiting', async () => {
  const { id } = await approvalPage();
  for (let i = 0; i < 10; i++) expect((await ask(id, `asker${i}@example.com`)).status).toBe(303);
  expect(emails.map((sent) => sent.to)).toEqual(Array(10).fill([OWNER]));
  // Deciding or removing the requests must not refill the day's owner emails.
  await sql`update page_people set status = 'denied' where page = ${id} and email < 'asker5'`;
  await sql`delete from page_people where page = ${id} and email >= 'asker5'`;
  expect((await ask(id, 'eleventh@example.com')).status).toBe(303);
  expect(emails).toHaveLength(10); // still waiting on the owner page, without an email
  expect(await statusOf(id, 'eleventh@example.com')).toBe('waiting');

  await sql`insert into page_people (page, email, status) select ${id}, 'x' || i || '@example.com', 'waiting' from generate_series(1, 99) i`;
  expect((await ask(id, 'late@example.com')).status).toBe(429);
  expect(await statusOf(id, 'late@example.com')).toBeUndefined();
});

it("retakes the screenshot on every switch, logged in only for an approval page, and shows it as a link preview only while anyone with the link can open the page; approved visitors no longer matter once it is open", async () => {
  const { id, url } = await approvalPage(VISITOR);
  const ownerShot = stored('previews/');
  const { browser, requests } = fakeBrowser();
  const bindings = { ...env, BROWSER: browser };

  expect((await click('publish', id, bindings, { access: 'link' })).status).toBe(303);
  expect(requests.map((request) => request.url)).toEqual([url]);
  expect(requests[0].cookies).toBeUndefined(); // the public link, as anyone sees it
  const linkShot = stored('previews/');
  expect(linkShot).toHaveLength(1);
  expect(linkShot).not.toEqual(ownerShot); // the owner's screenshot is never shown publicly
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(200);
  expect(await opens(id)).toBe(true);
  expect((await callViewer(`/${id}/raw`)).status).toBe(200);

  expect((await click('publish', id, bindings, { access: 'approval' })).status).toBe(303);
  expect(requests[1].cookies).toHaveLength(1);
  expect(stored('previews/')).toHaveLength(1);
  expect(stored('previews/')).not.toEqual(linkShot);
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(404);
  expect(await opens(id)).toBe(false);
});
