// Whole journeys through an approval page, as people click them: a browser with its own cookies follows redirects across the app and
// the viewer, fills in and submits the forms it is shown, and opens the links in the emails Campfile sends. The email server is the
// Email stand-in in test/helpers.ts: every email the code sends lands in `emails`, and nothing is read from the database (it is written only to make an invite's time run out).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTester, callApp, callViewer, click, createPage, emails, env, form, lastCode, ownerCookie, sessionCookie, sql, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

const APP = 'https://app.test';
describe.each([
  { mode: 'separate sites', viewer: 'https://view.test' },
  { mode: 'one address', viewer: APP },
])('$mode', ({ viewer: VIEWER }) => {
beforeEach(() => { env.VIEWER_ORIGIN = VIEWER; });
afterEach(() => { env.VIEWER_ORIGIN = 'https://view.test'; });

/** A browser: cookies per origin, redirects followed, forms submitted the way the page shows them. */
class Browser {
  private jar = new Map<string, Map<string, string>>();
  url = '';
  html = '';

  /** Starts logged in, as a cookie this browser got earlier. */
  constructor(cookies: Record<string, string> = {}) {
    for (const [origin, cookie] of Object.entries(cookies)) this.cookies(origin).set(cookie.slice(0, cookie.indexOf('=')), cookie.slice(cookie.indexOf('=') + 1));
  }

  private cookies(origin: string) {
    if (!this.jar.has(origin)) this.jar.set(origin, new Map());
    return this.jar.get(origin)!;
  }

  /** Opens a URL, or posts to it, then follows every redirect with a GET, as a browser does after a 303. */
  async go(address: string, init: { method?: string; body?: URLSearchParams; from?: string } = {}): Promise<number> {
    let url = new URL(address, this.url || undefined);
    let request = init;
    for (let hops = 0; hops < 20; hops++) {
      const headers: Record<string, string> = { Accept: 'text/html', Cookie: [...this.cookies(url.origin)].map(([name, value]) => `${name}=${value}`).join('; ') };
      if (request.body) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers.Origin = request.from === undefined || request.from === url.origin ? 'null' : request.from;
        headers['Sec-Fetch-Site'] = request.from === undefined || request.from === url.origin ? 'same-origin' : 'cross-site';
      }
      const requestInit = { method: request.method ?? 'GET', headers, body: request.body };
      const path = url.pathname + url.search;
      const response = VIEWER !== APP && url.origin === VIEWER ? await callViewer(path, VIEWER, requestInit) : await callApp(path, requestInit, env, APP);
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const name = pair.slice(0, pair.indexOf('='));
        if (/max-age=0/i.test(line)) this.cookies(url.origin).delete(name);
        else this.cookies(url.origin).set(name, pair.slice(pair.indexOf('=') + 1));
      }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url);
        request = {};
        continue;
      }
      this.url = url.href;
      this.html = await response.text();
      return response.status;
    }
    throw new Error(`Too many redirects from ${address}`);
  }

  /** Clicks the button labelled `label` (in the first such form after `near`, if given), with these fields typed in. */
  async submit(label: string, typed: Record<string, string> = {}, near = ''): Promise<number> {
    const start = near ? this.html.indexOf(near) : 0;
    if (start < 0) throw new Error(`"${near}" is not on ${this.url}`);
    const form = [...this.html.slice(start).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].find(([, , inner]) =>
      [...inner.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].some(([, text]) => text.replace(/<[^>]+>/g, '').trim() === label),
    );
    if (!form) throw new Error(`No "${label}" button on ${this.url}:\n${this.html}`);
    const attribute = (tag: string, name: string) => unescape(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]);
    const fields = new URLSearchParams();
    for (const [input] of form[2].matchAll(/<input\b[^>]*>/g)) {
      const name = attribute(input, 'name');
      if (name && attribute(input, 'type') !== 'radio') fields.set(name, attribute(input, 'value') ?? '');
    }
    const button = [...form[2].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(([, , text]) => text.replace(/<[^>]+>/g, '').trim() === label)!;
    const buttonName = attribute(button[1], 'name');
    if (buttonName) fields.set(buttonName, attribute(button[1], 'value') ?? '');
    for (const [name, value] of Object.entries(typed)) fields.set(name, value);
    const action = new URL(attribute(form[1], 'action') ?? this.url, this.url);
    return this.go(action.href, { method: (attribute(form[1], 'method') ?? 'get').toUpperCase(), body: fields, from: new URL(this.url).origin });
  }

  /** The page's content reaches this browser: the frame's address (or, on a gate, the page's /raw) loads with its cookies and serves the secret. */
  async opensPage(): Promise<boolean> {
    const [url, html] = [this.url, this.html];
    const src = unescape(/<iframe\b[^>]*\bsrc="([^"]*)"/.exec(html)?.[1]) ?? `${new URL(url).pathname}/raw`;
    const status = await this.go(new URL(src, url).href);
    const opened = status === 200 && this.html.includes('<p>secret</p>');
    [this.url, this.html] = [url, html];
    return opened;
  }

  /** Follows the link whose text is `text`. */
  async follow(text: string): Promise<number> {
    const link = [...this.html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].find(([, , inner]) => inner.replace(/<[^>]+>/g, '').trim() === text);
    if (!link) throw new Error(`No "${text}" link on ${this.url}:\n${this.html}`);
    return this.go(new URL(unescape(link[1])!, this.url).href);
  }
}

/** An attribute's text as the browser reads it: entities such as escapeHtml's `&#38;` decoded. */
const unescape = (text: string | undefined) =>
  text?.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot);/gi, (_entity, code: string) =>
    code.startsWith('#') ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"' } as Record<string, string>)[code.toLowerCase()],
  );

/** Every email sent to `address` so far. */
const inbox = (address: string) => emails.filter((sent) => sent.to.includes(address));
/** The only link in the newest email to `address` that starts with `prefix`. */
function linkIn(address: string, prefix: string): string {
  const text = inbox(address).at(-1)?.text ?? '';
  const links = text.match(new RegExp(`${prefix.replace(/[.]/g, '\\.')}\\S+`, 'g')) ?? [];
  expect(links, `links to ${prefix} in the newest email to ${address}`).toHaveLength(1);
  return links[0]!;
}
const codeIn = (address: string) => /\b(\d{6})\b/.exec(inbox(address).at(-1)?.text ?? '')?.[1];

const OWNER = 'owner@example.com';

/** Nora's page, published with approval, and Nora's browser signed in to the app. */
async function norasPage() {
  const key = await addTester('nora');
  const [{ tester }] = await sql<{ tester: number }[]>`update testers set email = ${OWNER} where name = 'nora' returning id as tester`;
  const page = await createPage(key, 'Secret plan', '<p>secret</p>');
  expect((await click('publish', page.id, env, { access: 'approval' })).status).toBe(303);
  const nora = new Browser({ [APP]: await sessionCookie(tester) });
  return { id: page.id, gate: `${VIEWER}/${page.id}`, nora };
}

/** A stranger types only their email at the gate and asks. */
async function askAtGate(gate: string, address: string) {
  const visitor = new Browser();
  expect(await visitor.go(gate)).toBe(200);
  expect(await visitor.opensPage()).toBe(false);
  await visitor.submit('Ask nora', { email: address });
  expect(visitor.html).toContain('autocomplete="one-time-code"'); // the code screen
  return visitor;
}

/** Nora opens the owner page from the request email and clicks a button on that person's row. */
async function ownerDecides(nora: Browser, address: string, button: 'Approve' | 'Say no') {
  const request = inbox(OWNER).findLast((sent) => sent.text.includes(address));
  expect(request?.subject, 'the request email to the owner').toContain(`${address} wants to see`);
  await nora.go(linkIn(OWNER, `${APP}/p/`));
  expect(nora.html).toContain(address);
  await nora.submit(button, {}, address);
}

it('a stranger asks with only an email: the owner is emailed and sees the request, approves it, and the code from the email opens the page', async () => {
  const { gate, nora } = await norasPage();
  const visitor = await askAtGate(gate, 'ingrid@example.com');
  expect(inbox('ingrid@example.com')).toEqual([]); // no code before the owner decides

  await ownerDecides(nora, 'ingrid@example.com', 'Approve');
  expect(inbox('ingrid@example.com')).toHaveLength(1);
  expect(inbox('ingrid@example.com')[0].subject).toBe('nora let you in on Campfile');

  await visitor.go(`${gate}?email=ingrid%40example.com`);
  await visitor.submit('Open the page', { code: codeIn('ingrid@example.com')! });
  expect(visitor.url).toBe(gate);
  expect(await visitor.opensPage()).toBe(true);
});

it('the login link in the approval email opens the page, in a browser that never asked', async () => {
  const { gate, nora } = await norasPage();
  await askAtGate(gate, 'ingrid@example.com');
  await ownerDecides(nora, 'ingrid@example.com', 'Approve');

  const phone = new Browser();
  await phone.go(linkIn('ingrid@example.com', `${APP}/signin/link`));
  expect(phone.html).toContain('Log in as ingrid@example.com?'); // a mail scanner opening the link logs nobody in
  await phone.submit('Log in as ingrid@example.com');
  expect(phone.url).toBe(gate);
  expect(await phone.opensPage()).toBe(true);
});

it('an approval email opened after its link expired: one click emails a fresh invite, which opens the page with no login', async () => {
  const { gate, nora } = await norasPage();
  await askAtGate(gate, 'ingrid@example.com');
  await ownerDecides(nora, 'ingrid@example.com', 'Approve');
  const old = linkIn('ingrid@example.com', `${APP}/signin/link`);

  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const phone = new Browser();
    await phone.go(old);
    expect(phone.html).toContain('That link has expired');
    await phone.submit('Email me a new link');
    expect(phone.html).toContain('Check your email');
    expect(inbox('ingrid@example.com').at(-1)?.subject).toBe('nora shared a page with you on Campfile');
    await phone.go(linkIn('ingrid@example.com', gate));
    expect(phone.url).toBe(gate);
    expect(await phone.opensPage()).toBe(true);
    await phone.go(`${APP}/my`);
    expect(phone.url).toContain('/signin'); // a pass to the page, not a login
  } finally {
    vi.useRealTimers();
  }
});

it('any other login link opened after it expired: one click emails a new one, which always asks "Log in as …?", even after a send-limit retry', async () => {
  const kim = new Browser();
  await kim.go(`${APP}/signin?next=/my`);
  await kim.submit('Send link and code', { email: 'kim@example.com' });
  const old = linkIn('kim@example.com', `${APP}/signin/link`);

  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    // Kim's own link, sent to someone else: the email comes from a link anyone can make for their own address.
    const other = new Browser();
    await other.go(old);
    expect(other.html).toContain('That link has expired');
    await sql`insert into signin_sends (email, ip) select 'kim@example.com', 'elsewhere' from generate_series(1, 5)`;
    await other.submit('Email me a new link');
    expect(other.html).toContain('codes were already sent to this email');
    await sql`delete from signin_sends where ip = 'elsewhere'`;
    await other.submit('Send link and code');
    expect(inbox('kim@example.com')).toHaveLength(2);
    await other.go(linkIn('kim@example.com', `${APP}/signin/link`));
    expect(other.html).toContain('Log in as kim@example.com?');
  } finally {
    vi.useRealTimers();
  }
});

it('the owner says no: the visitor gets no email and the page stays shut', async () => {
  const { gate, nora } = await norasPage();
  const visitor = await askAtGate(gate, 'ingrid@example.com');
  await ownerDecides(nora, 'ingrid@example.com', 'Say no');
  expect(inbox('ingrid@example.com')).toEqual([]);
  await visitor.go(gate);
  expect(await visitor.opensPage()).toBe(false);
});

it('someone the owner lets in by email: the invite opens the page at once; once its time is up it emails a fresh invite, and that opens the page', async () => {
  const { id, gate, nora } = await norasPage();
  await nora.go(`${APP}/p/${id}`);
  await nora.submit('Let them in', { emails: 'omar@example.com' });
  expect(inbox('omar@example.com')).toHaveLength(1);
  const invite = linkIn('omar@example.com', gate);

  const omar = new Browser();
  await omar.go(invite);
  expect(omar.url).toBe(gate);
  expect(await omar.opensPage()).toBe(true);
  expect(inbox('omar@example.com')).toHaveLength(1); // no login email needed

  // After its 7 days, on another device, the same link offers a fresh invite to that address.
  await sql`update page_people set invite_until = now() - interval '1 second' where email = 'omar@example.com'`;
  const laptop = new Browser();
  await laptop.go(invite);
  expect(laptop.html).toContain('nora shared a page with you');
  await laptop.submit('Email me a new link');
  expect(inbox('omar@example.com')).toHaveLength(2);
  await laptop.go(linkIn('omar@example.com', gate));
  expect(laptop.url).toBe(gate);
  expect(await laptop.opensPage()).toBe(true);
});

it('a forwarded invite: Not you? in a browser logged in as someone else lands on the email box, and the other email asks the owner before any code is sent', async () => {
  const { id, gate, nora } = await norasPage();
  await nora.go(`${APP}/p/${id}`);
  await nora.submit('Let them in', { emails: 'omar@example.com' });

  // Tess got Omar's used invite, in a browser already logged in on the page as Nora.
  await sql`update page_people set invite_until = now() - interval '1 second' where email = 'omar@example.com'`;
  const tess = new Browser();
  await tess.go(`${gate}/login`);
  await tess.submit('Send link and code', { email: OWNER });
  await tess.go(linkIn(OWNER, `${APP}/signin/link`));
  expect(tess.url).toBe(`${APP}/p/${id}`); // logged in as Nora on the viewer, which sends its owner on to the page on the app
  const sentBefore = emails.length;

  await tess.go(linkIn('omar@example.com', gate));
  expect(tess.html).toContain('nora shared a page with you');
  await tess.follow('Ask with another email');
  expect(tess.url).toBe(gate);
  expect(tess.html).toContain('name="email"');
  expect(await tess.opensPage()).toBe(false);

  await tess.submit('Ask nora', { email: 'tess@example.com' });
  expect(emails.slice(sentBefore).map((sent) => sent.to)).toEqual([[OWNER]]); // the owner is asked; Tess gets nothing yet
  await nora.go(`${APP}/p/${id}`);
  expect(nora.html).toMatch(/Waiting for you · <span class="num">1<\/span><\/h4><ul><li class="pr"><div class="pi"><span class="em">tess@example\.com<\/span>/);
});

it('someone let in earlier comes back: typing their email at the gate sends a fresh code at once, and it opens the page', async () => {
  const { gate, nora } = await norasPage();
  await askAtGate(gate, 'ingrid@example.com');
  await ownerDecides(nora, 'ingrid@example.com', 'Approve');

  const later = await askAtGate(gate, 'ingrid@example.com');
  expect(inbox('ingrid@example.com')).toHaveLength(2);
  await later.submit('Open the page', { code: codeIn('ingrid@example.com')! });
  expect(await later.opensPage()).toBe(true);
});

it('creates a private draft through the API, logs its owner in, publishes it, hands the viewer login over, and logs both sides out', async () => {
  const key = await addTester('nora');
  await sql`update testers set email = ${OWNER} where name = 'nora'`;
  const page = await createPage(key, 'Secret plan', '<p>secret</p>');
  expect(page.url).toBe(`${VIEWER}/${page.id}`);
  const nora = new Browser();
  await nora.go(`${APP}/p/${page.id}`);
  expect(new URL(nora.url).pathname).toBe('/signin');
  await nora.submit('Send link and code', { email: OWNER });
  await nora.submit('Log in', { code: lastCode(OWNER) });
  expect(nora.url).toBe(`${APP}/p/${page.id}`);
  expect(await nora.opensPage()).toBe(true);

  const visitor = new Browser();
  expect(await visitor.go(`${VIEWER}/${page.id}`)).toBe(404);
  expect(await visitor.opensPage()).toBe(false);
  await nora.go(`${APP}/p/${page.id}/manage`);
  await nora.submit('Publish', { access: 'link', sharing: '', name: 'nora' });
  expect(await visitor.go(`${VIEWER}/${page.id}-a1B2`)).toBe(200);
  expect(await visitor.opensPage()).toBe(true);

  await nora.go(`${VIEWER}/${page.id}/login`);
  expect(nora.url).toBe(`${APP}/p/${page.id}`); // the existing app session skips another code
  expect(await nora.opensPage()).toBe(true);
  await nora.go(`${APP}/signout?page=${page.id}&viewer=1`);
  expect(nora.url).toBe(`${VIEWER}/${page.id}`);
  expect(await nora.opensPage()).toBe(true); // public, but no longer the owner
  await nora.go(`${APP}/p/${page.id}`);
  expect(new URL(nora.url).pathname).toBe('/signin');
});

it('keeps uploaded HTML opaque and its trusted parent unframeable, without treating app cookies as viewer authorization', async () => {
  const key = await addTester('nora');
  const hostile = '<p>secret</p><script>parent.document.body.textContent = document.cookie + localStorage.getItem("owner")</script>';
  const page = await createPage(key, 'Secret plan', hostile);
  const cookie = await ownerCookie(page.id);
  const owner = await callApp(`/p/${page.id}`, { headers: { Cookie: cookie } });
  expect(owner.status).toBe(200);
  expect(owner.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(owner.headers.get('x-frame-options')).toBe('DENY');
  const ownerHtml = await owner.text();
  expect(ownerHtml).toContain('sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"');
  const frameUrl = new URL(unescape(/<iframe\b[^>]*\bsrc="([^"]*)"/.exec(ownerHtml)?.[1])!);
  const viewerRequest = (path: string, init?: RequestInit) => VIEWER === APP ? callApp(path, init) : callViewer(path, VIEWER, init);
  const denied = await viewerRequest(`/${page.id}/raw`, { headers: { Cookie: cookie } });
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain(hostile);
  const raw = await viewerRequest(frameUrl.pathname + frameUrl.search, { headers: { Cookie: cookie } });
  expect(raw.status).toBe(200);
  expect(await raw.text()).toContain(hostile);
  expect(raw.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;');
  expect(raw.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(raw.headers.get('content-security-policy')).not.toMatch(/allow-same-origin|allow-top-navigation|allow-forms/);
  expect(raw.headers.get('referrer-policy')).toBe('no-referrer');
  expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
  expect(raw.headers.get('x-frame-options')).toBeNull(); // the owner's iframe must still load

  expect((await click('publish', page.id)).status).toBe(303);
  const frame = await viewerRequest(`/${page.id}`);
  expect(frame.status).toBe(200);
  expect(await frame.text()).toContain(`src="/${page.id}/raw"`);
  if (VIEWER === APP) {
    expect(owner.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(frame.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(frame.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(frame.headers.get('x-frame-options')).toBe('DENY');
  }
  const source = await viewerRequest(`/${page.id}/source`);
  expect(source.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
  expect(await source.text()).not.toContain('<script>');
  expect((await callApp('/api/pages', { headers: { Cookie: cookie } })).status).toBe(401);
  expect((await callApp('/.well-known/oauth-authorization-server')).status).toBe(200);
  expect((await callApp('/mcp', { method: 'POST', body: '{}' })).status).toBe(401);
  const missing = await viewerRequest('/ZZZZZZZZ');
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain('This page was removed');
  const appMissing = await callApp('/does-not-exist');
  expect(appMissing.status).toBe(404);
  expect(await appMissing.json()).toMatchObject({ error: expect.stringContaining('There is nothing at') });
});

it('refuses opaque-origin owner actions and login CSRF even with cookies, while legitimate no-referrer forms still work', async () => {
  const { id, gate, nora } = await norasPage();
  const visitor = await askAtGate(gate, 'ingrid@example.com');
  await ownerDecides(nora, 'ingrid@example.com', 'Approve');
  const cookie = await ownerCookie(id);
  const attack = { ...form, Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' };
  for (const action of ['publish', 'unpublish', 'rename', 'people', 'delete']) {
    const forged = await callApp(`/p/${id}/${action}`, { method: 'POST', headers: attack, body: new URLSearchParams({ access: 'link', title: 'Stolen', emails: 'mallory@example.com' }) });
    expect(forged.status, action).toBe(403);
    expect(forged.headers.getSetCookie(), action).toEqual([]);
  }
  await callApp('/signin', { method: 'POST', headers: form, body: new URLSearchParams({ email: 'mallory@example.com', next: '/my' }) });
  const forgedLogin = await callApp('/signin', { method: 'POST', headers: attack, body: new URLSearchParams({ email: 'mallory@example.com', code: lastCode('mallory@example.com'), next: '/my' }) });
  expect(forgedLogin.status).toBe(403);
  expect(forgedLogin.headers.getSetCookie()).toEqual([]);
  const fields = new URLSearchParams({ email: 'ingrid@example.com', code: codeIn('ingrid@example.com')! });
  const entered = VIEWER === APP
    ? await callApp(`/${id}/enter`, { method: 'POST', headers: attack, body: fields })
    : await callViewer(`/${id}/enter`, VIEWER, { method: 'POST', headers: attack, body: fields });
  expect(entered.status).toBe(403);
  expect(entered.headers.getSetCookie()).toEqual([]);
  await visitor.go(`${gate}?email=ingrid%40example.com`);
  await visitor.submit('Open the page', { code: codeIn('ingrid@example.com')! });
  expect(await visitor.opensPage()).toBe(true); // the forged post did not use up the code
  await nora.go(`${APP}/p/${id}/manage`);
  expect(nora.html).not.toContain('Stolen');
  expect(nora.html).not.toContain('mallory@example.com');
  await nora.submit('Unpublish');
  await visitor.go(gate);
  expect(await visitor.opensPage()).toBe(false);
});

});
