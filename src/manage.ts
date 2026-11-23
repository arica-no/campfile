// The owner's side of the app (docs/SPEC.md "Managing a page"): the wall, the list of their pages; and one page's view, the page itself under the owner's bar, with the panel (publish, unpublish, who can open it, people, rename, delete) slid over it.
// Every route needs the browser session of the page's workspace (the one login, below). The same login logs the browser in on the viewer (docs/SPEC.md "Login"). The screens are src/wall-view.ts's and src/page-view.ts's; the numbers and people behind them src/wall.ts's.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { addPeople, approvedOn, decide, INVITE_DAYS, invited, parseEmails, renewInvite, useInvite, type Decision } from './access.ts';
import { CLIENT_IP } from './client.ts';
import { errorLine, page, session, SESSION_COOKIE, sessionClearCookies, sessionSetCookie } from './connector.ts';
import { withDb, type DbVariables } from './db.ts';
import type { Sql } from './db.ts';
import type { AppEnv } from './env.ts';
import { SETUP_HIDDEN } from './home.ts';
import { escapeHtml } from './html.ts';
import { newState, oldCookie, readSignedId, signedId, STATE, TICKET_SECONDS } from './keys.ts';
import { pageScreen } from './page-view.ts';
import { activeTester, CampfileError, DeleteRefused, MAX_DELETE, NO_SUCH_PAGE, pageService, publishPage, shootDue, shootIfMissing, unpublishPage, WALL_ROUND_MS, WALL_SHOTS, type Access } from './pages.ts';
import { takeScreenshot } from './preview.ts';
import { shareTree, type Sharing } from './sharing.ts';
import { checkCode, CODE_MINUTES, codeInput, email, LINK_MINUTES, loginLink, noEmailNote, passwordIntro, sendCode, signIn, TERMS_NOTICE, TERMS_VERSION, validLink } from './signin.ts';
import { spreadCounts } from './spread-view.ts';
import { DESIGNS, designOf, spreadFile, type Design } from './spread-view.ts';
import { createGroup, deleteGroup, GROUP_CHANGED, listGroups, movePages, NO_SUCH_GROUP, renameGroup } from './groups.ts';
import { SHOWS, SORTS, keep, wallScreen, type PageSheet, type Refused, type Show } from './wall-view.ts';
import { forgetEmail, nameToAsk, pagePeople, rememberedEmails, renamePage, saveAuthorName, wallPages, type Sort } from './wall.ts';

type Env = { Bindings: AppEnv; Variables: DbVariables };

export const manage = new Hono<Env>();

// 100 emails of up to 254 characters fit.
const small = bodyLimit({ maxSize: 32768, onError: (c) => c.text('That request is too big.', 413) });
const ID = '[A-Za-z0-9]{8}';
// A login link to a page on the viewer (an approval email's, or the page's own Log in): which page, for renewing an invite to it (sharedBy). An approval email's link has no state: the hand-over makes one (/viewer-login).
const SHARED = new RegExp(`^/viewer-login\\?page=(${ID})(&state=[\\w-]{22})?$`);
// Where login may send the browser next: the wall, an owner page (its view, or its panel open), or the hand-over back to a page on the viewer, so the login page cannot be used to redirect anywhere else.
const NEXT = new RegExp(`^(/my(/emails|/groups/${ID})?|/p/${ID}(/manage)?|${SHARED.source.slice(1, -1)})$`);
const PAGE_ID = new RegExp(`^${ID}$`);

/** A form's fields: `field(name)` is the first value as text (a file or nothing is empty); `field.all(name)` is every value of a repeated name, as the tick boxes and the box of emails share `emails`. */
interface Field {
  (name: string): string;
  all(name: string): string[];
}

async function fields(c: Context<Env>): Promise<Field> {
  const form = await c.req.parseBody({ all: true });
  const all = (name: string) => [form[name]].flat().filter((value): value is string => typeof value === 'string');
  return Object.assign((name: string) => all(name)[0] ?? '', { all });
}

// Login CSRF: a login form posted from another site would log this browser in to the attacker's workspace. Every other form here is held to the same rule: SameSite=Lax already keeps the session cookie off another site's posts, this says so in plain words.
// Browsers set Sec-Fetch-Site themselves; our pages' Referrer-Policy: no-referrer makes their own form posts send `Origin: null`, so Origin alone would refuse them.
const sameOrigin: MiddlewareHandler<Env> = async (c, next) =>
  c.req.header('Sec-Fetch-Site') === 'same-origin' || c.req.header('Origin') === new URL(c.req.url).origin
    ? next()
    : page('Not allowed', '<h1>That came from another site</h1><p>Campfile only accepts this from its own pages. Open Campfile and do it there.</p>', 403);

// The browser that asked for a login link: its email link logs in here without a confirm click, and only here (docs/SPEC.md "Login").
const LINK_COOKIE = '__Host-campfile-link';

// --- Login (docs/SPEC.md "Login"): the one login screen, for page owners and visitors alike --------------------------
// Email → an email with a link and a 6-digit code → signed in for 30 days → `next`. Who may do what is decided afterwards, by the page.

function emailScreen(env: AppEnv, next: string, address = '', error?: string, resend = false): Response {
  return page(
    'Log in to Campfile',
    `<h1>Log in to Campfile</h1>
<p>${env.EMAIL_IN_LOG ? `Enter your email. ${noEmailNote(env)}` : `Enter your email. We'll email you a login link and a 6&#8209;digit code. Use either one; you don't need both.`}</p>
${errorLine(error)}
<form method="post" action="/signin">
<input type="hidden" name="next" value="${escapeHtml(next)}">${resend ? '\n<input type="hidden" name="resend" value="1">' : ''}
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus value="${escapeHtml(address)}">
<button type="submit">${env.EMAIL_IN_LOG ? 'Continue' : 'Send link and code'}</button>
</form>
${env.EMAIL_IN_LOG ? '' : `<p class="muted">The link logs in on the device where you open your email. To log in on a different device, type the code there. There's no password: only someone who can open your inbox can log in.</p>`}`,
    error ? 400 : 200,
  );
}

/** Without SMTP (self-hosted) the login email is printed in the server's log (selfhost/server.ts); some emails type a password instead (passwordIntro). */
function codeScreen(env: AppEnv, next: string, address: string, error?: string): Response {
  const password = passwordIntro(env, address);
  return page(
    password ? 'Type your password' : env.EMAIL_IN_LOG ? 'Get your code' : 'Check your email',
    `${password
      ?? (env.EMAIL_IN_LOG
      ? `<h1>Get your code from the server</h1>
<p>This server has no email set up, so nothing was sent to <strong>${escapeHtml(address)}</strong>. On the server, in the selfhost folder, run <strong>docker compose logs campfile</strong> and type the 6&#8209;digit code from its last lines here. It works for ${CODE_MINUTES} minutes.</p>`
      : `<h1>Check your email</h1>
<p>We sent a link and a 6&#8209;digit code to <strong>${escapeHtml(address)}</strong>. Click the link, or type the code here. The link works for ${LINK_MINUTES} minutes, the code for ${CODE_MINUTES}. Not in your inbox? Check your spam folder.</p>`)}
${errorLine(error)}
<form method="post" action="/signin">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<input type="hidden" name="email" value="${escapeHtml(address)}">
${codeInput(env, address)}
<button type="submit">Log in</button>
</form>
${TERMS_NOTICE}
<p class="muted">Wrong email? <a href="/signin?next=${encodeURIComponent(next)}">Start again</a></p>`,
    error ? 400 : 200,
  );
}

/**
 * An invite past its days or its opens: the invited email filled in, one click to get a renewed invite to this page (POST /signin/renew). The owner's title stays off this domain's screens.
 * The new invite goes to the invited address only, and is a pass to this page, never a login.
 * "Not you?" logs out to the page's gate, where another email asks the owner before any code is sent; a browser logged in as someone else would otherwise skip the email box.
 */
function inviteScreen(id: string, inviteParam: string, invite: { email: string; owner_name: string }, gate: string): Response {
  return page(
    'Log in to Campfile',
    `<h1>${escapeHtml(invite.owner_name)} shared a page with you</h1>
<p>We'll email a new link to <strong>${escapeHtml(invite.email)}</strong>. Click it to open the page.</p>
<form method="post" action="/signin/renew">
${hiddenFields({ page: id, invite: inviteParam })}
<button type="submit" autofocus>Email me a new link</button>
</form>
<p class="muted">Not you? <a href="${escapeHtml(gate)}">Ask with another email</a></p>`,
  );
}

const hiddenFields = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join('\n');

/** A login link opened in a browser that did not ask for it: one click, the email in plain view, so a link someone else sent cannot log you in to their workspace unnoticed. */
function confirmScreen(next: string, address: string, version: string, nonce: string, token: string): Response {
  return page(
    'Log in to Campfile',
    `<h1>Log in as ${escapeHtml(address)}?</h1>
<p>This login link was asked for in another browser. Continue only if you asked for it. If someone sent you this link, close this page.</p>
<form method="post" action="/signin/link">
${hiddenFields({ next, email: address, v: version, n: nonce, t: token })}
<button type="submit">Log in as ${escapeHtml(address)}</button>
</form>`,
  );
}

/** Signed in: the 30-day session cookie, then on to `next`, or the wall. */
async function loggedIn(c: Context<Env>, tester: number, next: string): Promise<Response> {
  const headers = new Headers({ 'Set-Cookie': await sessionSetCookie(c.env.CONSENT_SECRET, tester), Location: next || '/my' });
  return new Response(null, { status: 303, headers });
}

manage.get('/signin', (c) => emailScreen(c.env, NEXT.test(c.req.query('next') ?? '') ? c.req.query('next')! : ''));

manage.post('/signin', sameOrigin, small, withDb, async (c) => {
  const field = await fields(c);
  const next = NEXT.test(field('next')) ? field('next') : '';
  const parsed = email.safeParse(field('email'));
  if (!parsed.success) return emailScreen(c.env, next, field('email'), parsed.error.issues[0].message);
  try {
    if (!field('code')) {
      const nonce = newState();
      await sendCode(c.var.sql, c.env, parsed.data, c.req.header(CLIENT_IP) ?? 'unknown', await loginLink(c.env, parsed.data, next, nonce));
      const response = codeScreen(c.env, next, parsed.data);
      // A resend takes its email from a link anyone can write, so its new link always asks "Log in as …?" first: no nonce cookie for it.
      if (!field('resend')) response.headers.append('Set-Cookie', `${LINK_COOKIE}=${nonce}; Path=/; Max-Age=${LINK_MINUTES * 60}; HttpOnly; Secure; SameSite=Lax`);
      return response;
    }
    return await loggedIn(c, await checkCode(c.var.sql, parsed.data, field('code'), { env: c.env, waitUntil: c.var.waitUntil, via: 'the login screen (code)' }), next);
  } catch (error) {
    if (!(error instanceof CampfileError)) throw error;
    return field('code') ? codeScreen(c.env, next, parsed.data, error.message) : emailScreen(c.env, next, parsed.data, error.message, !!field('resend'));
  }
});

// The email's link works again until it expires, so a mail scanner opening it first does not use it up (docs/SPEC.md "Login").
// On GET it logs in only in the browser whose cookie holds this link's nonce; anywhere else, the confirm screen, whose POST is same-origin only.
async function linkLogin(c: Context<Env>, field: (name: string) => string, confirmed: boolean): Promise<Response> {
  const next = NEXT.test(field('next')) ? field('next') : '';
  const address = email.safeParse(field('email'));
  const [version, nonce, token] = [field('v'), field('n'), field('t')];
  if (!address.success || !(await validLink(c.env.CONSENT_SECRET, address.data, version, nonce, token))) {
    const fresh = next.replace(/&state=[\w-]{22}$/, ''); // the viewer's login state lasts 10 minutes, so by now it is gone: /viewer-login makes a new one
    const again = `/signin?next=${encodeURIComponent(fresh)}`;
    // Only a link Campfile signed for this email gets the button, so an edited link cannot email another address. That alone is no proof of the inbox: anyone can let their own link expire.
    if (!address.success || !(await validLink(c.env.CONSENT_SECRET, address.data, version, nonce, token, 0))) return page('That link has expired', `<h1>That link has expired</h1><p>A login link works for ${LINK_MINUTES} minutes.</p><p><a href="${again}">Log in</a></p>`, 400);
    const shown = `<strong>${escapeHtml(address.data)}</strong>`;
    // A link to a page this email was let in to: a renewed invite, a pass to that page only, so a stranger's own link sent to someone else gains the stranger nothing and needs no "Log in as …?".
    if (await sharedBy(c, field)) {
      return page(
        'That link has expired',
        `<h1>That link has expired</h1>
<p>A login link works for ${LINK_MINUTES} minutes. We'll email a new link to ${shown}. Click it to open the page.</p>
<form method="post" action="/signin/renew">
${hiddenFields({ email: address.data, v: version, n: nonce, t: token, next })}
<button type="submit" autofocus>Email me a new link</button>
</form>`,
        400,
      );
    }
    // Any other link: one click logs in again as the link's email, as typing it on the login would.
    return page(
      'That link has expired',
      `<h1>That link has expired</h1>
<p>A login link works for ${LINK_MINUTES} minutes. ${c.env.EMAIL_IN_LOG ? `Log in again as ${shown}. ${noEmailNote(c.env)}` : `We'll email a new link and code to ${shown}.`}</p>
<form method="post" action="/signin">
${hiddenFields({ next: fresh, email: address.data, resend: '1' })}
<button type="submit" autofocus>${c.env.EMAIL_IN_LOG ? 'Continue' : 'Email me a new link'}</button>
</form>
<p class="muted">Not you? <a href="${again}">Log in with another email</a></p>`,
      400,
    );
  }
  if (!confirmed && getCookie(c, LINK_COOKIE) !== nonce) return confirmScreen(next, address.data, version, nonce, token);
  try {
    return await loggedIn(c, await signIn(c.var.sql, address.data, version, { env: c.env, waitUntil: c.var.waitUntil, via: 'the login screen (link)' }), next);
  } catch (error) {
    if (!(error instanceof CampfileError)) throw error;
    return page('Not logged in', `<h1>Not logged in</h1>${errorLine(error.message)}`, error.status);
  }
}

manage.get('/signin/link', withDb, (c) => linkLogin(c, (name) => c.req.query(name) ?? '', false));
manage.post('/signin/link', sameOrigin, small, withDb, async (c) => linkLogin(c, await fields(c), true));

/**
 * The page and the person let in to it that an expired link names, each checked by its signature: an invite (`page`, `invite`, within its INVITE_DAYS), or a login link (`email`, `v`, `n`, `t`) at most INVITE_DAYS old whose `next` is that page.
 * `next` is not signed, so a link can be aimed at any page its email is let in to; the invite still goes to that email only. Undefined once they are no longer let in, or the page no longer asks for approval.
 */
async function sharedBy(c: Context<Env>, field: (name: string) => string) {
  let page: string | undefined;
  let address: string | undefined;
  if (field('invite')) {
    page = PAGE_ID.test(field('page')) ? field('page') : undefined;
    address = page && (await invited(c.var.sql, c.env.PREVIEW_SECRET, page, field('invite')))?.email;
  } else {
    page = SHARED.exec(field('next'))?.[1];
    const parsed = email.safeParse(field('email'));
    if (page && parsed.success && (await validLink(c.env.CONSENT_SECRET, parsed.data, field('v'), field('n'), field('t'), Date.now() / 1000 - INVITE_DAYS * 24 * 60 * 60))) address = parsed.data;
  }
  const person = page && address ? await approvedOn(c.var.sql, page, address) : undefined;
  return person && { page: page!, person };
}

// An expired link to a page someone was let in to: a renewed invite to their own address (src/access.ts renewInvite), never a login. A POST, so a mail scanner sends nothing.
manage.post('/signin/renew', sameOrigin, small, withDb, async (c) => {
  const shared = await sharedBy(c, await fields(c));
  if (!shared) return page('That link no longer works', `<h1>That link no longer works</h1><p>Ask the page's owner to share it with you again.</p>`, 400);
  try {
    const sent = await renewInvite(c.var.sql, c.env, c.env.VIEWER_ORIGIN, shared.page, shared.person, c.req.header(CLIENT_IP) ?? 'unknown');
  } catch (error) {
    if (!(error instanceof CampfileError)) throw error;
    return page('Not sent', `<h1>Not sent</h1>${errorLine(error.message)}`, error.status);
  }
  return page(
    'Check your email',
    `<h1>Check your email</h1>
<p>We sent a new link to <strong>${escapeHtml(shared.person.email)}</strong>. Click it to open the page. Not in your inbox? Check your spam folder.</p>`,
  );
});

// --- Logging in on the viewer (docs/SPEC.md "Login") -----------------------------------------------------------------
// The viewer's Log in comes here with its state. Signed in already: straight back with a ticket for that state, no screen. Otherwise, or to use another email (`switch`), the login first.
// An approval email's invite names who was let in: unless that email is the one signed in here, opening it while it lasts gives this browser a pass to that one page (docs/SPEC.md "Publish with approval"), else the invite screen, which offers a renewed invite.
// An approval email's login link comes with no state: the page's own Log in makes one in this browser and returns here, so a link that just logged in opens the page.
manage.get('/viewer-login', withDb, async (c) => {
  const id = c.req.query('page') ?? '';
  const state = c.req.query('state');
  if (!PAGE_ID.test(id) || (state !== undefined && !STATE.test(state))) return c.text('That login link is broken. Open the page and click Log in again.', 400);
  if (state === undefined) return c.redirect(`${c.env.VIEWER_ORIGIN}/${id}/login`, 303);
  const next = `/viewer-login?page=${id}&state=${state}`;
  const signedIn = c.req.query('switch') ? undefined : await session(c);
  const inviteParam = c.req.query('invite');
  const invite = await invited(c.var.sql, c.env.PREVIEW_SECRET, id, inviteParam);
  if (invite && invite.email !== signedIn?.email) {
    // A pass, not a login: a forwarded invite opens this page for its reader and nothing else of that email's.
    const opened = await useInvite(c.var.sql, c.env.PREVIEW_SECRET, id, inviteParam);
    if (!opened) return inviteScreen(id, inviteParam!, invite, `${c.env.VIEWER_ORIGIN}/${id}/logout`);
    try {
      await signIn(c.var.sql, opened.email, TERMS_VERSION, { env: c.env, waitUntil: c.var.waitUntil, via: `an invite to page ${c.env.VIEWER_ORIGIN}/${id}` }); // opening it accepts the terms
    } catch (error) {
      if (!(error instanceof CampfileError)) throw error;
      return page('Not logged in', `<h1>Not logged in</h1>${errorLine(error.message)}`, error.status);
    }
    // Signed with the approval version this open was let through under, so a Say no while the terms are recorded still ends the pass it brings.
    const pass = await signedId(c.env.PREVIEW_SECRET, `pass-ticket:${id}:${state}:${opened.version}`, opened.id, Math.floor(Date.now() / 1000) + TICKET_SECONDS);
    return c.redirect(`${c.env.VIEWER_ORIGIN}/${id}/signed-in?pass=${pass}&v=${opened.version}`, 303);
  }
  if (!signedIn) return c.redirect(`/signin?${new URLSearchParams({ next })}`, 303);
  return handOver(c, id, state, signedIn.tester);
});

/** Back to the viewer with a ticket for this browser's login state: the viewer's login cookie for that workspace, and the page. */
async function handOver(c: Context<Env>, id: string, state: string, tester: number): Promise<Response> {
  const ticket = await signedId(c.env.PREVIEW_SECRET, `ticket:${state}`, tester, Math.floor(Date.now() / 1000) + TICKET_SECONDS);
  return c.redirect(`${c.env.VIEWER_ORIGIN}/${id}/signed-in?t=${ticket}`, 303);
}

// The viewer's Log out ends the app's session too, or the next Log in would skip the code; then back to the page.
// The page view's Log out comes here first (`viewer`), so the session of the address it was on ends too (an alias's is not the main address's), then goes on to the viewer's Log out, which comes back here.
manage.get('/signout', (c) => {
  const id = c.req.query('page') ?? '';
  const next = PAGE_ID.test(id) ? `${c.env.VIEWER_ORIGIN}/${id}${c.req.query('viewer') ? '/logout' : ''}` : '/';
  return new Response(null, { status: 303, headers: [...sessionClearCookies.map((clear): [string, string] => ['Set-Cookie', clear]), ['Location', next]] });
});

// --- The wall and a page's view (docs/SPEC.md "Managing a page") -----------------------------------------------------
// `/my` is the list, and `/my/emails` the same screen with the remembered emails' sheet open. `/p/:id` is one page: the page itself under the owner's bar; `/p/:id/manage` the same with the panel slid over it. Every action is a form POST that redirects back to the panel with `?done=`, so a reload does not repeat it.

interface Who {
  tester: number;
  email: string;
}

interface OwnedPage extends Who {
  id: string;
  title: string;
  published: boolean;
  access: Access;
  sharing: Sharing;
  group_id: string | null;
}

/** The signed-in workspace; otherwise the sign-in that comes back to `next`. */
async function workspace(c: Context<Env>, next: string): Promise<Who | Response> {
  return (await session(c)) ?? c.redirect(`/signin?next=${next}`, 303);
}

/** A page that is not the signed-in workspace's, whoever's it is or whether it exists: a 404 that offers another email. */
const notYours = (who: Who, id: string) =>
  page(
    'Page not found',
    `<h1>This page is gone, or it isn’t yours</h1>
<p>You’re signed in as <strong>${escapeHtml(who.email)}</strong>, and no page of yours has this address. It may have been deleted, or it belongs to another email.</p>
<p><a href="/my">Back to your pages</a></p>
<p><a href="/signin?next=/p/${id}">Use another email</a></p>`,
    404,
  );

/** The page if the browser is signed in to its workspace; otherwise the response to send instead: the sign-in, or the 404. */
async function ownedPage(c: Context<Env>, id: string): Promise<OwnedPage | Response> {
  const who = await workspace(c, `/p/${id}/manage`);
  if (who instanceof Response) return who;
  const [owned] = await c.var.sql<Omit<OwnedPage, keyof Who>[]>`
    select id, title, published_at is not null as published, access, sharing, group_id from pages where id = ${id} and owner = ${who.tester} and status = 'live'`;
  return owned ? { ...owned, ...who } : notYours(who, id);
}

/** A group that is not the signed-in workspace's, or is gone: the 404 of a page that is not yours, for a group. */
const noGroup = (who: Who, id: string) =>
  page(
    'Group not found',
    `<h1>This group is gone, or it isn’t yours</h1>
<p>You’re signed in as <strong>${escapeHtml(who.email)}</strong>, and no group of yours has this address. It may have been deleted, or it belongs to another email.</p>
<p><a href="/my">Back to your pages</a></p>
<p><a href="/signin?next=/my/groups/${id}">Use another email</a></p>`,
    404,
  );

/** The wall's filter, search and order the owner came with (src/wall-view.ts keep()), so the screens they open lead back to the same wall. */
function listState(c: Context<Env>): { show: Show; q: string; sort: Sort } {
  const show = c.req.query('show') ?? '';
  const sort = c.req.query('sort') ?? '';
  return { show: Object.keys(SHOWS).includes(show) ? (show as Show) : 'all', q: (c.req.query('q') ?? '').slice(0, 200), sort: Object.keys(SORTS).includes(sort) ? (sort as Sort) : 'changed' };
}

/** The wall, Your pages or the group `at`'s own, and over it the remembered emails' sheet if `emails`. Reads only what that screen shows. */
async function wall(c: Context<Env>, who: Who, emails = false, refused?: Refused, at?: string): Promise<Response> {
  const { sql } = c.var;
  const [pages, groups] = await Promise.all([wallPages(sql, who.tester), listGroups(sql, who.tester)]);
  const group = at ? groups.find((g) => g.id === at) : undefined;
  // A refused form from a group deleted meanwhile shows Your pages.
  if (at && !group && !refused) return noGroup(who, at);
  // The plain wall catches up pages that have none and are due a try (shootDue's turns), after the response; not with the sheet or after an action, whose own shot may still be running.
  if (!emails && !refused && !c.req.query('done')) c.var.waitUntil(shootDue(sql, c.env, c.var.waitUntil, WALL_SHOTS, who.tester, WALL_ROUND_MS));
  const lone = !group && !groups.length && pages.length === 1 && !pages[0].published;
  // The remembered emails are read where they are shown or ticked: their sheet, the lone draft's Publish, and the wall's button when it has no pages.
  // The author's name is asked when sharing with anyone with the link: the lone draft's Publish, until asked once.
  // The lone draft's Delete form carries the owner's pass (viewTicket), as the panel's does.
  const [book, name, ticket] = await Promise.all([
    emails || pages.length === 0 || lone ? rememberedEmails(sql, who.tester) : [],
    !emails && lone ? nameToAsk(sql, who.tester) : undefined,
    lone ? viewTicket(c, pages[0].id, who.tester) : undefined,
  ]);
  const [g, p] = ['g', 'p'].map((key) => c.req.query(key)?.slice(0, 200));
  const was = c.req.query('was')?.slice(0, 80); // a group's name is at most 80 characters (src/groups.ts)
  return wallScreen({
    email: who.email, viewer: c.env.VIEWER_ORIGIN, pages, groups, group, book, ...listState(c), name, done: c.req.query('done'), n: c.req.query('n'), g, p, was, emails, refused, ticket,
  });
}

// How long the frame's ticket opens the page for its owner (docs/SPEC.md "Managing a page"): a long sitting; every load of the page view mints a new one.
const VIEW_SECONDS = 12 * 60 * 60;
/** The owner's pass for one page and workspace: the frame's ticket (src/viewer.ts /:id/raw), and what the owner's own Delete forms send back (`alreadyDeleted`). */
const viewTicket = (c: Context<Env>, id: string, tester: number) => signedId(c.env.PREVIEW_SECRET, `view:${id}`, tester, Math.floor(Date.now() / 1000) + VIEW_SECONDS);

/** One page's screen: the page under the owner's bar, and the panel over it if `panel`. Reads only what that screen shows. `failed` is a form that was refused: its message and what was typed. */
async function pageView(c: Context<Env>, who: Who, id: string, panel: boolean, failed?: Pick<PageSheet, 'error' | 'typed'>): Promise<Response> {
  const { sql } = c.var;
  const [open] = await wallPages(sql, who.tester, id);
  if (!open) return notYours(who, id);
  // A page with no picture gets one for the wall, after the response; not right after an action (`done`), whose own shot may still be on its way.
  if (!open.thumb && !c.req.query('done')) c.var.waitUntil(shootIfMissing(sql, c.env, c.var.waitUntil, id));
  // The remembered emails are read where the panel ticks them: a draft's Publish and an approval page's Let more people in.
  // The author's name is asked when sharing with anyone with the link: a draft's Publish and a link page's sharing form, until asked once.
  const [book, people, name, tree] = await Promise.all([
    !open.published || open.access === 'approval' ? rememberedEmails(sql, who.tester) : [],
    open.published && open.access === 'approval' ? pagePeople(sql, id) : [],
    !open.published || open.access === 'link' ? nameToAsk(sql, who.tester) : undefined,
    shareTree(sql, id),
  ]);
  // The frame's address carries a ticket that makes the viewer treat this browser as the page's owner (src/viewer.ts /:id/raw).
  const ticket = await viewTicket(c, id, who.tester);
  return pageScreen(
    {
      viewer: c.env.VIEWER_ORIGIN, book, ...listState(c), name, done: c.req.query('done'),
    },
    { page: open, people, spread: tree && spreadCounts(tree, (open.published_at ?? open.created_at).toISOString()), ...failed },
    panel,
    ticket,
    failed?.error ? 400 : 200,
  );
}

/** A wall screen for the signed-in owner; signed out, the sign-in that comes back to `next`. */
async function wallRoute(c: Context<Env>, next: string, emails = false): Promise<Response> {
  const who = await workspace(c, next);
  return who instanceof Response ? who : wall(c, who, emails);
}

/** A page's view for the signed-in owner, the panel open or not; signed out, the sign-in that comes back to the same address. */
async function pageRoute(c: Context<Env>, panel: boolean): Promise<Response> {
  const id = c.req.param('id')!;
  if (c.req.method === 'HEAD') {
    // manage.js's check on Back, whether the page is still there: only that, no screen. Not no-store, which would make Chrome drop the page from its back/forward memory; a HEAD has no body to keep out of caches.
    const owned = await ownedPage(c, id);
    const answer = owned instanceof Response ? owned : c.body(null);
    answer.headers.set('Cache-Control', 'private, no-cache');
    return answer;
  }
  const who = await workspace(c, `/p/${id}${panel ? '/manage' : ''}`);
  return who instanceof Response ? who : pageView(c, who, id, panel);
}

manage.get('/my', withDb, (c) => wallRoute(c, '/my'));
manage.get('/my/emails', withDb, (c) => wallRoute(c, '/my/emails', true));
manage.get(`/my/groups/:gid{${ID}}`, withDb, async (c) => {
  const gid = c.req.param('gid');
  const who = await workspace(c, `/my/groups/${gid}`);
  return who instanceof Response ? who : wall(c, who, false, undefined, gid);
});
manage.get(`/p/:id{${ID}}`, withDb, (c) => pageRoute(c, false));
manage.get(`/p/:id{${ID}}/manage`, withDb, (c) => pageRoute(c, true));

// A page's picture on the wall: its screenshot, for its owner only (the public one is on the viewer, for a published link page). An <img> has no use for a sign-in, so anything else is a plain 404.
manage.get(`/p/:id{${ID}}/thumb.jpg`, withDb, async (c) => {
  // session()'s check and the owner check in one query: each is a round trip to the database, and a wall far from it waits for every one.
  const tester = await readSignedId(c.env.CONSENT_SECRET, 'session', getCookie(c, SESSION_COOKIE) ?? getCookie(c, oldCookie(SESSION_COOKIE)));
  const [row] = tester === undefined
    ? []
    : await c.var.sql<{ preview_file: string | null }[]>`
        select p.preview_file from pages p join testers t on t.id = p.owner
        where p.id = ${c.req.param('id')} and p.owner = ${tester} and p.status = 'live' and t.disabled_at is null`;
  const image = row?.preview_file && (await c.env.PAGES.get(row.preview_file));
  if (!image) return new Response('Not found', { status: 404 });
  // At the address the wall gives it (src/wall-view.ts thumb: ?v= names this screenshot's key, and a new one gets a new address), it never changes: the browser keeps it, so a wall far from the servers loads it once.
  // Kept per cookie (Vary): once the browser signs out or another account signs in, it asks again and the session check above answers.
  const current = c.req.query('v') === row.preview_file!.split('/').pop()!.slice(0, 8);
  return new Response(image.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': current ? 'private, max-age=31536000, immutable' : 'private, max-age=300', Vary: 'Cookie' } });
});

/** `?done=<word>` and what that word says (`n` a count, `g` a group, `p` a page, `was` a name), plus the wall's filter, search and order the form was sent from (src/wall-view.ts keep()), so the browser lands back on the same wall. */
function doneQuery(c: Context<Env>, done: string, about: Record<string, string | number | undefined> = {}): string {
  const query = new URLSearchParams({ done });
  for (const [key, value] of Object.entries(about)) if (value) query.set(key, String(value));
  for (const key of ['show', 'q', 'sort']) {
    const value = c.req.query(key);
    if (value) query.set(key, value.slice(0, 200));
  }
  return `?${query}`;
}

/** Runs an owner action; `done` is the word it returns (what the panel then says happened). A mistake in the form shows the page view again with the panel open, the message and what `typed` keeps of the form. */
async function ownerAction(c: Context<Env>, action: (owned: OwnedPage, field: Field) => Promise<string>, typed: (field: Field) => PageSheet['typed'] = () => undefined): Promise<Response> {
  const owned = await ownedPage(c, c.req.param('id') ?? '');
  if (owned instanceof Response) return owned;
  const field = await fields(c);
  try {
    const done = await action(owned, field);
    // A deleted page's panel goes back to the wall Back leads to (src/page-view.ts): its group's, unless the owner came from a filter or search.
    const wall = wallOf(c.req.query('show') || c.req.query('q')?.trim() ? undefined : (owned.group_id ?? undefined));
    return c.redirect(`${done === 'deleted' ? wall : `/p/${owned.id}/manage`}${doneQuery(c, done)}`, 303);
  } catch (error) {
    if (!(error instanceof CampfileError)) throw error;
    return pageView(c, owned, owned.id, true, { error: error.message, typed: typed(field) });
  }
}

/** The emails ticked and typed, one box's worth: the form posts them all as `emails`. */
const emailsText = (field: Field) => field.all('emails').join('\n');
const typedEmails = (field: Field) => ({ emails: emailsText(field) });
// The sharing boxes send a hidden "off" and the ticked ones; Switch and Undo send none, which keeps the page's (src/wall-view.ts shareBoxes).
const sharingOf = (field: Field): Sharing | undefined => {
  const boxes = field.all('sharing');
  return !boxes.length ? undefined : !boxes.includes('links') ? 'off' : boxes.includes('emails') ? 'emails' : 'links';
};
const typedPublish = (field: Field) => ({ emails: emailsText(field), access: field('access'), sharing: sharingOf(field), name: field.all('name').length ? field('name') : undefined });

manage.post(`/p/:id{${ID}}/publish`, sameOrigin, small, withDb, (c) =>
  ownerAction(
    c,
    async (owned, field) => {
      const access = field('access');
      if (access !== 'link' && access !== 'approval') throw new CampfileError(400, 'Choose who can open the page.');
      const sharing = sharingOf(field);
      // Emails count only with approval: leftover text in the box never blocks publishing to the link.
      const emails = access === 'approval' ? parseEmails(emailsText(field)) : [];
      // The name field counts only with "Anyone with the link".
      if (access === 'link' && field.all('name').length) await saveAuthorName(c.var.sql, owned.tester, field('name'));
      const published = await publishPage(c.var.sql, c.env, c.var.waitUntil, owned.id, access, sharing);
      if (access === 'approval') await addPeople(c.var.sql, c.env, c.env.VIEWER_ORIGIN, owned, emails);
      // Approval stores sharing "off": the word keeps what it was, for the panel's Undo (src/wall-view.ts outcome).
      if (owned.published && owned.access !== access) return access === 'approval' && owned.sharing !== 'off' ? `switched-${owned.sharing}` : 'switched';
      return owned.published && published && published.sharing !== owned.sharing ? 'shared' : 'published';
    },
    typedPublish,
  ),
);

manage.post(`/p/:id{${ID}}/unpublish`, sameOrigin, small, withDb, (c) =>
  ownerAction(c, async (owned) => {
    await unpublishPage(c.var.sql, c.env, c.var.waitUntil, owned.id);
    return 'unpublished';
  }),
);

manage.post(`/p/:id{${ID}}/rename`, sameOrigin, small, withDb, (c) =>
  ownerAction(
    c,
    async (owned, field) => {
      await renamePage(c.var.sql, c.env, c.var.waitUntil, owned.tester, owned.id, field('title'));
      return 'renamed';
    },
    (field) => ({ title: field('title') }),
  ),
);

manage.post(`/p/:id{${ID}}/people`, sameOrigin, small, withDb, (c) =>
  ownerAction(
    c,
    async (owned, field) => {
      const emails = parseEmails(emailsText(field));
      if (!emails.length) throw new CampfileError(400, 'Type an email first, or pick one from the list.');
      await addPeople(c.var.sql, c.env, c.env.VIEWER_ORIGIN, owned, emails);
      return 'letin';
    },
    typedEmails,
  ),
);

const DECIDED: Record<Decision, string> = { approve: 'approved', deny: 'denied', remove: 'removed' };

manage.post(`/p/:id{${ID}}/people/:person{[0-9]{1,9}}`, sameOrigin, small, withDb, (c) =>
  ownerAction(c, async (owned, field) => {
    const decision = field('decision');
    if (decision !== 'approve' && decision !== 'deny' && decision !== 'remove') throw new CampfileError(400, 'Choose Approve, Say no or Remove.');
    await decide(c.var.sql, c.env, c.env.VIEWER_ORIGIN, owned, Number(c.req.param('person')), decision);
    return DECIDED[decision];
  }),
);

/**
 * A delete of a page that is gone already (deleted in another tab, or through the connector) ends as a delete does, for its owner: the form of their own panel or lone-draft screen carries the pass for that page and workspace (viewTicket).
 * Without that pass, or with one for another page, another workspace or past its 12 hours, it is the 404 of a page that is not yours, which tells nothing about other owners' pages (docs/SPEC.md "Deleting pages").
 */
async function alreadyDeleted(c: Context<Env>, notFound: Response): Promise<Response> {
  const who = await session(c);
  const id = c.req.param('id')!;
  const pass = (await fields(c))('ticket');
  if (!who || (await readSignedId(c.env.PREVIEW_SECRET, `view:${id}`, pass)) !== who.tester) return notFound;
  // A row still there (a page taken down, not deleted) is not "deleted".
  const [kept] = await c.var.sql`select 1 from pages where id = ${id}`;
  return kept ? notFound : c.redirect(`/my${doneQuery(c, 'deleted')}`, 303);
}

manage.post(`/p/:id{${ID}}/delete`, sameOrigin, small, withDb, async (c) => {
  const response = await ownerAction(c, async (owned, field) => {
    const tester = await activeTester(c.var.sql, owned.tester);
    if (!tester) throw new CampfileError(404, NO_SUCH_PAGE);
    await pageService(c.var.sql, c.env, tester, c.var.waitUntil)
      .removeMany([owned.id], field('confirm'))
      .catch((error) => {
        // The connector's wording speaks of "the user"; the owner here is the user.
        if (error instanceof DeleteRefused && error.published.length) throw new CampfileError(400, `Nothing was deleted. “${owned.title}” is published: its link stops working for everyone. To delete it, type the word delete.`);
        throw error;
      });
    return 'deleted';
  });
  return response.status === 404 ? alreadyDeleted(c, response) : response;
});

// An address that only a POST answers: Back to a refused delete, or a link someone kept, comes here with a GET. The wall it came from, not a 404.
manage.get('/my/delete', (c) => c.redirect(`/my${keep(listState(c))}`, 303));
manage.get('/my/move', (c) => c.redirect(`/my${keep(listState(c))}`, 303));
manage.get('/my/groups', (c) => c.redirect(`/my${keep(listState(c))}`, 303));
manage.get(`/my/groups/:gid{${ID}}/:act{rename|delete}`, (c) => c.redirect(`/my/groups/${c.req.param('gid')}${keep(listState(c))}`, 303));
manage.get(`/p/:id{${ID}}/delete`, (c) => c.redirect(`/p/${c.req.param('id')}/manage${keep(listState(c))}`, 303));

/** The group whose wall a tick form was sent from (`from`, src/wall-view.ts picker), or none for Your pages. */
const fromGroup = (field: Field) => (PAGE_ID.test(field('from')) ? field('from') : undefined);
const wallOf = (group?: string) => (group ? `/my/groups/${group}` : '/my');

/**
 * A wall form about groups (docs/SPEC.md "Page groups"): `act` returns where to go, with `?done=`. A refusal shows the wall `at` again, the ticked pages still ticked, and says why in the owner's words;
 * the service's own words are for an AI (src/groups.ts).
 */
async function groupAction(c: Context<Env>, at: (field: Field) => string | undefined, act: (who: Who, field: Field) => Promise<string>): Promise<Response> {
  const who = await workspace(c, '/my');
  if (who instanceof Response) return who;
  const field = await fields(c);
  try {
    return c.redirect(await act(who, field), 303);
  } catch (error) {
    if (!(error instanceof CampfileError)) throw error;
    const ids = [...new Set(field.all('id'))].filter((id) => PAGE_ID.test(id));
    let ticked = ids;
    let message = error.message;
    if (error.message === NO_SUCH_GROUP) message = 'That group is gone, maybe deleted in another tab, so nothing changed.';
    else if (error.message === GROUP_CHANGED) message = 'Its pages changed since you opened this, maybe in another tab, so nothing was deleted. Press Delete group again to see them as they are now.';
    else if (field('how') === 'delete' && /^This group has [\d,]+ pages, so nothing was deleted/.test(error.message)) {
      // src/groups.ts checkCap, worded for an AI: the owner deletes on the wall.
      message = `${error.message.split(', so')[0]}; at most ${MAX_DELETE.toLocaleString('en')} can be deleted at once. Delete some of its pages first (tick them and press Delete), then delete the group.`;
    } else if (error instanceof DeleteRefused && error.published.length) {
      const one = error.published.length === 1;
      message = `Nothing was deleted. ${one ? `“${error.published[0].title}” is` : `${error.published.length} of its pages are`} published, so deleting ${one ? 'it' : 'them'} needs the word delete. Press Delete group again, choose Delete its pages too and type it.`;
    } else if (error.status === 404 && ids.length) {
      // A ticked page deleted meanwhile (src/groups.ts moveIn): the others stay ticked.
      ticked = (await c.var.sql<{ id: string }[]>`select id from pages where id in ${c.var.sql(ids)} and owner = ${who.tester} and status = 'live'`).map((row) => row.id);
      const gone = ids.length - ticked.length;
      const making = c.req.path === '/my/groups' || field('to') === 'new'; // the group goes too: it is made with its pages or not at all
      message = `${gone === 1 ? 'A page you ticked was' : `${gone} of the pages you ticked were`} deleted meanwhile, so ${making ? 'the group was not made and ' : ''}nothing was moved.${ticked.length ? ` The ${ticked.length === 1 ? 'other is' : 'others are'} still ticked.` : ''}`;
    }
    return wall(c, who, false, { status: error.status, message, ticked, missing: 0, published: [] }, at(field));
  }
}

// New group: named, and the pages ticked on the wall moved into it if any.
manage.post('/my/groups', sameOrigin, small, withDb, (c) =>
  groupAction(c, fromGroup, async (who, field) => {
    const ids = field.all('id');
    const made = await createGroup(c.var.sql, who.tester, field('name'), ids.length ? ids : undefined);
    return `${wallOf(fromGroup(field))}${doneQuery(c, 'group-made', { g: made.id, n: made.pages })}`;
  }),
);

// Move to… and drag-and-drop (public/manage.js): `to` is a group's id, "new" (named in `name`) or "none" (out of their groups). All of the ticked pages, or none.
manage.post('/my/move', sameOrigin, small, withDb, (c) =>
  groupAction(c, fromGroup, async (who, field) => {
    const ids = [...new Set(field.all('id'))];
    const to = field('to');
    if (!ids.length) throw new CampfileError(400, 'Tick the pages to move first.');
    const back = wallOf(fromGroup(field));
    if (to === 'new') {
      const made = await createGroup(c.var.sql, who.tester, field('name'), ids);
      return `${back}${doneQuery(c, 'group-made', { g: made.id, n: ids.length })}`;
    }
    if (to !== 'none' && !PAGE_ID.test(to)) throw new CampfileError(400, 'Choose where to move the pages.');
    // Out of one group: the line names it.
    const left = to === 'none' ? await c.var.sql<{ group_id: string }[]>`select distinct group_id from pages where id in ${c.var.sql(ids)} and owner = ${who.tester} and group_id is not null` : [];
    const { moved } = await movePages(c.var.sql, who.tester, ids, to === 'none' ? null : to);
    const g = to === 'none' ? (left.length === 1 ? left[0].group_id : undefined) : to;
    return `${back}${doneQuery(c, to === 'none' ? 'moved-out' : 'moved', { g, p: moved.length === 1 ? moved[0].id : undefined, n: moved.length })}`;
  }),
);

manage.post(`/my/groups/:gid{${ID}}/rename`, sameOrigin, small, withDb, (c) =>
  groupAction(
    c,
    () => c.req.param('gid'),
    async (who, field) => {
      const gid = c.req.param('gid');
      const [old] = await c.var.sql<{ name: string }[]>`select name from page_groups where id = ${gid} and owner = ${who.tester}`;
      const back = `/my/groups/${gid}`;
      if (old && field('name').trim() === old.name) return `${back}${keep(listState(c))}`; // saved as it was: nothing to say
      await renameGroup(c.var.sql, who.tester, gid, field('name'));
      return `${back}${doneQuery(c, 'group-renamed', { g: gid, was: old?.name })}`;
    },
  ),
);

// Delete group: its pages kept (in no group) unless `how` is "delete"; then they go only if they are still the ones the dialog listed (`page`), and a published one among them needs the word typed (docs/SPEC.md "Deleting pages").
manage.post(`/my/groups/:gid{${ID}}/delete`, sameOrigin, small, withDb, (c) =>
  groupAction(
    c,
    () => c.req.param('gid'),
    async (who, field) => {
      const how = field('how') === 'delete' ? { pages: 'delete' as const, ids: field.all('page'), confirm: field('confirm') } : { pages: 'keep' as const };
      const gone = await deleteGroup(c.var.sql, c.env, c.var.waitUntil, who.tester, c.req.param('gid'), how);
      const [done, n] = gone.deleted.length ? ['group-deleted-all', gone.deleted.length] : gone.kept ? ['group-deleted-kept', gone.kept] : ['group-deleted', 0];
      return `/my${doneQuery(c, done as string, { was: gone.name, n })}`;
    },
  ),
);

// The wall's tick boxes (docs/SPEC.md "Deleting pages"): every ticked page, or none. A refusal shows the wall again, the pages that are still there ticked, and says why.
manage.post('/my/delete', sameOrigin, small, withDb, async (c) => {
  const who = await workspace(c, '/my');
  if (who instanceof Response) return who;
  const field = await fields(c);
  try {
    const tester = await activeTester(c.var.sql, who.tester);
    if (!tester) throw new CampfileError(404, NO_SUCH_PAGE);
    const { count } = await pageService(c.var.sql, c.env, tester, c.var.waitUntil).removeMany(field.all('id'), field('confirm'));
    return c.redirect(`${wallOf(fromGroup(field))}${count === 1 ? doneQuery(c, 'deleted') : doneQuery(c, 'deleted-many', { n: count })}`, 303);
  } catch (error) {
    if (!(error instanceof CampfileError)) throw error;
    const refused = error instanceof DeleteRefused ? error : undefined;
    const missing = refused?.missing ?? [];
    return wall(
      c,
      who,
      false,
      {
        status: error.status,
        message: error.message,
        ticked: [...new Set(field.all('id'))].filter((id) => !missing.includes(id)),
        missing: missing.length,
        published: refused?.published.map((page) => page.title) ?? [],
      },
      fromGroup(field),
    );
  }
});

// How it spread (docs/SPEC.md): Let anyone with the link see it. Only a published link page can be public.
// Off also drops its link-preview pictures.
// The box sends a hidden "0" and, ticked, a "1" after it.
manage.post(`/p/:id{${ID}}/spread`, sameOrigin, small, withDb, (c) =>
  ownerAction(c, async (owned, field) => {
    const on = field.all('public').includes('1');
    if (on && !(owned.published && owned.access === 'link')) throw new CampfileError(400, 'Only a page anyone with the link can open can show how it spread.');
    await c.var.sql`update pages set spread_public = ${on} where id = ${owned.id}`;
    if (on) c.var.waitUntil(shootSpread(c.var.sql, c.env, owned.id, 'cascade'));
    else {
      await c.var.sql`delete from spread_shots where page = ${owned.id}`;
      await Promise.all(DESIGNS.map((design) => c.env.PAGES.delete(spreadFile(owned.id, design)).catch((error) => console.error(`Could not delete ${spreadFile(owned.id, design)}: ${error}`))));
    }
    return on ? 'spread-public' : 'spread-private';
  }),
);

/**
 * The link-preview picture of a public spread page (src/viewer.ts preview.jpg), which the viewer cannot take: it has no screenshot service.
 * The public view only, never the owner's (no login goes with the shot). One try per page and design every 10 minutes (spread_shots), so crawlers asking at once start one,
 * and one shot every 10 seconds across all pages, so strangers cannot keep the screenshot service busy. Returns false when that cap turned it away.
 */
async function shootSpread(sql: Sql, env: AppEnv, id: string, design: Design): Promise<boolean> {
  // One claim at a time site-wide, so simultaneous requests cannot all see the cap idle; the lock goes with the transaction, before the shot.
  const claim = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('spread_shots'))`;
    const [busy] = await tx`select 1 from spread_shots where tried_at > now() - interval '10 seconds' limit 1`;
    if (busy) return 'busy';
    const [claimed] = await tx`
      insert into spread_shots (page, design)
      select id, ${design} from pages where id = ${id} and status = 'live' and published_at is not null and access = 'link' and spread_public
      on conflict (page, design) do update set tried_at = now() where spread_shots.tried_at < now() - interval '10 minutes'
      returning page`;
    return claimed ? 'claimed' : 'none';
  });
  if (claim === 'busy') return false;
  if (claim === 'none') return true;
  const key = spreadFile(id, design);
  try {
    await env.PAGES.put(key, await takeScreenshot(env.BROWSER!, `${env.VIEWER_ORIGIN}/${id}/spread?design=${design}&shot=1`)); // every deployment has a screenshot service (BROWSER); without one this throws and is logged below
    // Off (or anything else that hid the view) during the shot already deleted its pictures; this one came after, so it goes too.
    const [still] = await sql`
      select 1 from spread_shots s join pages p on p.id = s.page
      where s.page = ${id} and s.design = ${design} and p.status = 'live' and p.published_at is not null and p.access = 'link' and p.spread_public`;
    if (!still) await env.PAGES.delete(key);
  } catch (error) {
    console.error(`Could not make a spread preview for ${id} (${design}): ${error}`);
  }
  return true;
}

// The viewer asks for a spread preview here, signed for one page and design (src/viewer.ts preview.jpg); shootSpread checks again that the view is public.
manage.post(`/spread-shot/:id{${ID}}`, withDb, async (c) => {
  const id = c.req.param('id');
  const design = designOf(c.req.query('design'));
  if ((await readSignedId(c.env.PREVIEW_SECRET, `spread-shot:${id}:${design}`, c.req.query('t'))) !== 0) return c.text('Forbidden', 403);
  if (!(await shootSpread(c.var.sql, c.env, id, design))) return c.text('Busy', 503, { 'Retry-After': '10' });
  return c.body(null, 204);
});

// A self-hosted install's home page (src/home.ts): anyone logged in hides its Get started list for everyone, or shows it again.
manage.post('/setup/instructions', sameOrigin, small, withDb, async (c) => {
  if (!c.env.SELF_HOSTED) return c.notFound();
  const who = await workspace(c, '/');
  if (who instanceof Response) return who;
  if ((await fields(c))('hide') === '1') await c.env.PAGES.put(SETUP_HIDDEN, new Uint8Array());
  else await c.env.PAGES.delete(SETUP_HIDDEN);
  return c.redirect('/', 303);
});

// Forget: the email leaves the remembered emails; with `revoke` it also loses its access to the owner's pages (src/wall.ts).
manage.post('/my/emails/forget', sameOrigin, small, withDb, async (c) => {
  const who = await workspace(c, '/my/emails');
  if (who instanceof Response) return who;
  const field = await fields(c);
  await forgetEmail(c.var.sql, who.tester, field('email'), field('revoke') === '1');
  return c.redirect(`/my/emails${doneQuery(c, 'forgot')}`, 303);
});
