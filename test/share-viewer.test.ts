// docs/SPEC.md "See how it's shared", on the viewer: readers' own links /<id>-<code>, the consent banner's place, /:id/arrive, AI readers and og:url.
import { expect, it } from 'vitest';
import { escapeHtml } from '../src/html.ts';
import { SHARE_CAP, shareTree, type Sharing } from '../src/sharing.ts';
import { signIn } from '../src/signin.ts';
import { addTester, callViewer, publishedPage, served, signup, sql, useCleanDatabase, viewerLogin, viewerOwner } from './helpers.ts';

useCleanDatabase();

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CLAUDE = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)';
const HTML = '<p>the secret plan</p>';
let head = (_id: string) => 'Shared on Campfile.';
const sourceOf = (id: string) => `<!doctype html><meta charset="utf-8"><pre>\n${head(id)}\n\n${escapeHtml(HTML)}</pre>`; // /source: Campfile's line, then the page escaped, so an AI reads it as text
const BROWSER = { 'User-Agent': CHROME };

async function page(sharing: Sharing, owner = 'amy') {
  const { id } = await publishedPage(await addTester(owner), 'The plan', HTML);
  await sql`update pages set sharing = ${sharing} where id = ${id}`;
  return id;
}

/** A browser's random key for one page, as bar.js makes it. */
const key = (n: number) => `k${String(n).padStart(21, '0')}`;
const get = (path: string, headers: Record<string, string> = BROWSER) => callViewer(path, undefined, { headers });
/** bar.js's fetch: a JSON body, from the frame page. */
const script = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  callViewer(`/${id}/arrive`, undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'same-origin', ...BROWSER, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
async function arrival(id: string, body: { via: string | null; key: string; email?: string }, headers?: Record<string, string>) {
  const response = await script(id, body, headers);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ url: string | null; ask?: true }>;
}
const codeOf = (url: string | null) => url?.match(/-([A-Za-z0-9]{4})$/)?.[1] ?? null;
const ogUrl = (html: string) => html.match(/<meta property="og:url" content="([^"]*)">/)?.[1];
const entries = async (id: string) => (await shareTree(sql, id)).entries;

it('/<id>-<code> opens the page; an unknown code or another page\'s opens it as the plain link; only the frame page takes a code', async () => {
  const id = await page('links');
  const other = await page('links', 'bea');
  const foreign = codeOf((await arrival(other, { via: null, key: key(1) })).url)!;
  for (const path of [`/${id}`, `/${id}-zzzz`, `/${id}-${foreign}`]) {
    const frame = await get(path);
    expect(frame.status, path).toBe(200);
    const html = await frame.text();
    expect(html, path).toContain(`src="/${id}/raw"`);
    expect(ogUrl(html), path).toBe(`https://view.test/${id}`);
  }
  // A foreign code files the reader under the author's link.
  await arrival(id, { via: foreign, key: key(2) });
  expect((await shareTree(sql, id)).brought).toBe(1);
  for (const path of [`/${id}-${foreign}/raw`, `/${id}-${foreign}/source`, `/${id}-${foreign}/preview.jpg`, `/${id}-abc`, `/${id}-abcde`]) {
    expect((await get(path)).status, path).toBe(404);
  }
});

it('the banner and data-share go only to a stranger\'s browser on a page open to anyone with the link and shared', async () => {
  const links = await page('links');
  const emails = await page('emails', 'bea');
  for (const [id, sharing] of [[links, 'links'], [emails, 'emails']] as const) {
    const frame = await get(`/${id}`);
    const html = await frame.text();
    expect(html).toContain(`<body data-share="${sharing}">`);
    expect(html).toMatch(/class="consent-yes"[\s\S]*<\/body>/);
    expect(html.indexOf('class="consent-tool"')).toBeGreaterThan(html.indexOf('<div class="tools">'));
    expect(html.includes('class="consent-field"'), sharing).toBe(sharing === 'emails');
    expect(frame.headers.get('content-security-policy')).toContain("connect-src 'self'");
  }
  const none = async (id: string, headers: Record<string, string>, why: string) => {
    const frame = await get(`/${id}`, headers);
    const html = await frame.text();
    expect(html, why).not.toMatch(/data-share|class="consent-|\.consent-yes/); // no banner markup, no banner css
    expect(frame.headers.get('content-security-policy'), why).not.toContain('connect-src');
  };
  expect((await get(`/${links}`, { ...BROWSER, Cookie: await viewerOwner(links) })).status).toBe(302); // the owner is sent on to the app: no frame page, so no banner
  await none(links, { 'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' }, 'bot');
  await none(links, { ...BROWSER, 'Campfile-Screenshot': '1' }, 'the screenshot service');
  const off = await page('off', 'cat');
  await none(off, BROWSER, 'off, no entries');
  // Sharing off with entries left: no banner either.
  await arrival(links, { via: null, key: key(1) });
  await sql`update pages set sharing = 'off' where id = ${links}`;
  await none(links, BROWSER, 'off, entries left');
  expect(await (await get(`/${links}`, { 'User-Agent': CLAUDE })).text()).toBe(sourceOf(links)); // an AI gets the source, no banner
  // An approval page (sharing forced off) with entries from its link days: an approved visitor gets nothing.
  await arrival(emails, { via: null, key: key(1), email: 'ann@example.com' });
  await sql`update pages set access = 'approval', sharing = 'off' where id = ${emails}`;
  await sql`insert into page_people (page, email, status) values (${emails}, 'ann@example.com', 'approved')`;
  const ann = await viewerLogin(await signIn(sql, 'ann@example.com', null, signup));
  expect(await (await get(`/${emails}`, { ...BROWSER, Cookie: ann })).text()).toContain('<iframe');
  await none(emails, { ...BROWSER, Cookie: ann }, 'approval');

  // The page always opens: no email screen, /raw and /source open to anyone.
  const id = await page('emails', 'dan');
  expect(await (await get(`/${id}`)).text()).toContain('<iframe');
  expect(await (await get(`/${id}/raw`)).text()).toBe(served(HTML));
  expect(await (await get(`/${id}/source`)).text()).toBe(sourceOf(id));
});

it('the dialog names the author by the name they chose or one made from their email, never by the email', async () => {
  const address = 'amy.rivera@example.com';
  const id = await page('emails', address);
  await sql`update testers set email = ${address} where name = ${address}`;
  const frame = async () => (await get(`/${id}`)).text();
  for (const [chosen, shown] of [[null, 'Amy Rivera'], ['', 'Amy Rivera'], ['Captain Amy', 'Captain Amy']] as const) {
    await sql`update testers set display_name = ${chosen} where name = ${address}`;
    const html = await frame();
    expect(html, String(chosen)).toContain(shown);
    expect(html, String(chosen)).not.toMatch(/amy\.rivera|@example\.com/);
  }
});

it("'links': Allow files the browser under the link in the address; the same key gets the same link from any link", async () => {
  const id = await page('links');
  const amy = await arrival(id, { via: null, key: key(1) }, { 'Campfile-Client-Country': 'NL' });
  expect(amy.url).toMatch(new RegExp(`^https://view\\.test/${id}-[A-Za-z0-9]{4}$`));
  const code = codeOf(amy.url)!;
  expect(await arrival(id, { via: null, key: key(1) })).toEqual(amy); // a later load
  const ben = await arrival(id, { via: code, key: key(2) }, { 'User-Agent': IPHONE });
  expect(ben.url).not.toBe(amy.url);
  expect(await arrival(id, { via: codeOf(ben.url), key: key(1) })).toEqual(amy); // Amy opens Ben's link: still hers, no new entry
  expect(await shareTree(sql, id)).toMatchObject({
    entries: 2,
    brought: 1,
    children: [{ label: null, ai: null, country: 'NL', device: 'computer', reached: 1, children: [{ device: 'phone', country: null }] }],
  });
  expect(ogUrl(await (await get(`/${id}-${code}`)).text())).toBe(`https://view.test/${id}-${code}`);
  // Sharing off: the code no longer shows in og:url, and nothing is filed.
  await sql`update pages set sharing = 'off' where id = ${id}`;
  expect(ogUrl(await (await get(`/${id}-${code}`)).text())).toBe(`https://view.test/${id}`);
  expect(await arrival(id, { via: code, key: key(3) })).toEqual({ url: null });
  expect(await entries(id)).toBe(2);
});

it("'emails': a new browser needs an email, which labels its entry; a known one doesn't; a 'links' page ignores one", async () => {
  const id = await page('emails');
  for (const email of [undefined, 'not an email', `${'a'.repeat(250)}@b.co`]) {
    expect(await arrival(id, { via: null, key: key(1), email }), String(email)).toEqual({ url: null, ask: true });
  }
  expect(await entries(id)).toBe(0);
  const ben = await arrival(id, { via: null, key: key(1), email: ' Ben@Example.com ' });
  expect(ben.url).toMatch(new RegExp(`^https://view\\.test/${id}-[A-Za-z0-9]{4}$`));
  expect(await arrival(id, { via: null, key: key(1) })).toEqual(ben); // later loads send no email
  await arrival(id, { via: codeOf(ben.url), key: key(2), email: 'cat@example.com' });
  expect(await shareTree(sql, id)).toMatchObject({ entries: 2, children: [{ label: 'ben@example.com', children: [{ label: 'cat@example.com' }] }] });

  const links = await page('links', 'bea');
  await arrival(links, { via: null, key: key(1), email: 'ben@example.com' });
  expect((await shareTree(sql, links)).children[0].label).toBeNull();
});

it('refuses a bad key or body with 400, and makes nothing for the owner, a bot or a call that is not the bar script', async () => {
  const id = await page('links');
  for (const body of ['not json', '[]', { via: null }, { via: null, key: 'short' }, { via: null, key: `${key(1)}!` }, { via: null, key: 7 }]) {
    expect((await script(id, body)).status, JSON.stringify(body)).toBe(400);
  }
  expect((await script(id, { via: null, key: key(1), pad: 'x'.repeat(5000) })).status).toBe(413);
  const refused = { url: null };
  expect(await arrival(id, { via: null, key: key(1) }, { Cookie: await viewerOwner(id) })).toEqual(refused);
  expect(await arrival(id, { via: null, key: key(2) }, { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' })).toEqual(refused);
  expect(await arrival(id, { via: null, key: key(3) }, { 'Campfile-Screenshot': '1' })).toEqual(refused);
  expect(await arrival(id, { via: null, key: key(4) }, { 'Sec-Fetch-Site': 'cross-site' })).toEqual(refused);
  expect(await arrival(id, { via: null, key: key(5) }, { 'Sec-Fetch-Dest': 'document' })).toEqual(refused); // a navigation or form post
  expect(await arrival(id, { via: null, key: key(6) }, { 'Sec-Fetch-Dest': '' })).toEqual(refused); // no Fetch Metadata at all
  expect(await entries(id)).toBe(0);
});

it('an AI reader gets the source and one entry per link it came through, named after the AI', async () => {
  const id = await page('emails');
  const ben = codeOf((await arrival(id, { via: null, key: key(1), email: 'ben@example.com' })).url)!;
  for (const path of [`/${id}`, `/${id}`, `/${id}-${ben}`, `/${id}-${ben}`]) {
    const source = await get(path, { 'User-Agent': CLAUDE, 'Campfile-Client-Country': 'DE' });
    expect(source.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await source.text()).toBe(sourceOf(id));
  }
  await get(`/${id}`, { 'User-Agent': 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)' });
  await get(`/${id}`, { 'User-Agent': 'Google' }); // Gemini's whole User-Agent
  await get(`/${id}`, { 'User-Agent': 'Claude-User', Cookie: await viewerOwner(id) }); // the owner's own AI fetch with a login: sent on to the app, nothing recorded
  const tree = await shareTree(sql, id);
  expect(tree.entries).toBe(5);
  expect(tree.children.map((e) => e.ai ?? e.label).sort()).toEqual(['ChatGPT', 'Claude', 'Gemini', 'ben@example.com']);
  expect(tree.children.find((e) => e.label)!.children).toMatchObject([{ ai: 'Claude', label: null, country: 'DE', device: null }]);
});

it('at the cap Allow gives no link, and a key already in keeps its own', async () => {
  const id = await page('links');
  const first = await arrival(id, { via: null, key: key(1) });
  await sql`insert into share_links (page, code, key_hash) select ${id}, lpad(n::text, 4, '0'), md5(n::text) from generate_series(1, ${SHARE_CAP - 1}) as n`;
  expect(await arrival(id, { via: null, key: key(2) })).toEqual({ url: null });
  expect(await arrival(id, { via: null, key: key(1) })).toEqual(first);
  expect(await entries(id)).toBe(SHARE_CAP);
});
