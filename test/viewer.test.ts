import { expect, it, vi } from 'vitest';
import { signedId } from '../src/keys.ts';
import { HEADLINE, LEDE, sentences } from '../src/pitch.ts';
import { purgeExpired } from '../src/signin.ts';
import viewer from '../src/viewer.ts';
import { addTester, callViewer, click, createPage, env, fileOf, files, publishedPage, served, sql, useCleanDatabase, viewerOwner } from './helpers.ts';

useCleanDatabase();

// docs/SPEC.md "Raw CSP", with frame-ancestors 'self' (the viewer's own frame page) and the app's origins (its page view frames its owner's page).
let RAW_CSP =
  `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self' https://app.test`;

async function publish(title = 'A page', html = '<p>hello</p>') {
  return publishedPage(await addTester('amy'), title, html);
}

it('serves the uploaded HTML at /:id/raw with the sandbox CSP and no-sniff, no-referrer, no-store headers', async () => {
  const html = '<!doctype html><title>Hi</title><h1>Hi</h1><script>document.title = "x"</script>';
  const { id } = await publish('Hi', html);

  const raw = await callViewer(`/${id}/raw`);
  expect(raw.status).toBe(200);
  expect(await raw.text()).toBe(served(html));
  expect(raw.headers.get('content-security-policy')).toBe(RAW_CSP);
  expect(raw.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
  expect(raw.headers.get('referrer-policy')).toBe('no-referrer');
  expect(raw.headers.get('cache-control')).toBe('no-store');
});

// docs/SPEC.md "GET /:id/raw": the page never opens alone in a tab, where it could pass itself off as any site.
it('sends /raw and /source opened in a tab to the frame page, and serves a browser that names no destination a notice without the page', async () => {
  const html = '<h1>Your bank</h1>';
  const { id } = await publish('Hi', html);

  for (const [kind, dest] of [['raw', 'document'], ['raw', 'embed'], ['raw', 'object'], ['raw', ''], ['source', 'document']]) {
    const response = await callViewer(`/${id}/${kind}`, undefined, { headers: { 'Sec-Fetch-Dest': dest } }); // '' is a value, not an old browser
    expect(response.status, `${kind} ${dest}`).toBe(302);
    expect(response.headers.get('location')).toBe(`/${id}`);
    expect(response.headers.get('vary')).toBe('Sec-Fetch-Dest');
  }
  const source = await callViewer(`/${id}/source`); // AI fetchers and curl send no Sec-Fetch-Dest
  expect(source.status).toBe(200);
  expect(source.headers.get('vary')).toBe('Sec-Fetch-Dest');
  expect((await callViewer(`/${id}/raw`)).headers.get('vary')).toBe('Sec-Fetch-Dest');

  // Past the test helpers, which give every /raw request the iframe's header: here it has none, as Safari before 16.4 or curl.
  const background: Promise<unknown>[] = [];
  const bare = await viewer.fetch(new Request(`https://view.test/${id}/raw`), env, { waitUntil: (p: Promise<unknown>) => void background.push(p), passThroughOnException() {}, props: {} });
  await Promise.all(background);
  expect(bare.status).toBe(400);
  expect(bare.headers.get('content-security-policy')).toMatch(/^sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none';/); // runs nothing
  const text = await bare.text();
  expect(text).toContain(`<a href="/${id}" target="_blank">`);
  expect(text).not.toContain(html);

  // The frame may load this page's own /raw only, never another page under this page's bar.
  expect((await callViewer(`/${id}`)).headers.get('content-security-policy')).toContain(`frame-src https://view.test/${id}/raw;`);
});

// Claude's fetcher, as Anthropic documents it, and Gemini's, as the host's request log showed it.
const CLAUDE = { headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)' } };
const GEMINI = { headers: { 'User-Agent': 'Google' } };

it('gives AI fetchers the page source as inert HTML, scripts included, and points other readers at /:id/source', async () => {
  // Like the logo-options page: its words exist only inside a script, so an HTML-to-text reader would lose them. The </pre> tries to break out.
  const html = '<div id="root"></div><script>root.innerHTML = "<h2>Option C: Page Kindling</h2>"</script></pre><svg viewBox="0 0 32 32"><rect width="32" height="32"/></svg>';
  const { id } = await publish('Logo options', html);

  for (const response of [await callViewer(`/${id}`, undefined, CLAUDE), await callViewer(`/${id}`, undefined, GEMINI), await callViewer(`/${id}/source`)]) {
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    expect(body.match(/</g)).toHaveLength(4); // <!doctype, <meta, <pre>, </pre>: every tag of the page is escaped
    expect(body.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))).toContain(html);
  }

  const frame = await (await callViewer(`/${id}`)).text(); // a browser
  expect(frame).toContain('<iframe');
  expect(frame).toContain(`as text at <a href="https://view.test/${id}/source" tabindex="-1">https://view.test/${id}/source</a>`); // the URL survives an HTML-to-text reader
});

let head = (_id: string) => 'Shared on Campfile.';
it.each(['source', 'ai'])('streams %s before the file ends and preserves split UTF-8 while escaping', async (route) => {
  const { id } = await publish();
  let input!: ReadableStreamDefaultController<Uint8Array>;
  vi.spyOn(env.PAGES, 'get').mockResolvedValueOnce({ body: new ReadableStream({ start: (out) => { input = out; } }) });
  const response = await callViewer(route === 'source' ? `/${id}/source` : `/${id}`, undefined, CLAUDE);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = (await reader.read()).value!;
  expect(text).toBe(`<!doctype html><meta charset="utf-8"><pre>\n${head(id)}\n\n`); // the file is still open
  const bytes = new TextEncoder().encode('\uFEFFé雪<&"\'>');
  for (const byte of bytes) input.enqueue(Uint8Array.of(byte));
  input.close();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
  }
  expect(text).toBe(`<!doctype html><meta charset="utf-8"><pre>\n${head(id)}\n\né雪&#60;&#38;&#34;&#39;&#62;</pre>`);
});

it('does not drain a source file for a stalled reader and cancels it when the reader leaves', async () => {
  const { id } = await publish();
  const cancelled = Promise.withResolvers<unknown>();
  const chunk = new TextEncoder().encode('&'.repeat(1024));
  let pulled = 0;
  vi.spyOn(env.PAGES, 'get').mockResolvedValueOnce({ body: new ReadableStream({
    pull(out) {
      out.enqueue(chunk);
      if (++pulled === 100) out.close();
    },
    cancel: cancelled.resolve,
  }) });
  const response = await callViewer(`/${id}/source`);
  const reader = response.body!.getReader();
  await reader.read();
  expect(pulled).toBeLessThan(100);
  await reader.cancel('reader left');
  expect(await cancelled.promise).toBe('reader left');
});

it('keeps /:id/source as shut as /raw, and gives AI fetchers no way past a draft or an approval page', async () => {
  const key = await addTester('amy');
  const draft = await createPage(key, 'Secret draft', '<p>secret</p>');
  const approval = await publishedPage(key, 'Team only', '<p>team</p>');
  await sql`update pages set access = 'approval' where id = ${approval.id}`;

  for (const id of [draft.id, approval.id]) {
    const source = await callViewer(`/${id}/source`, undefined, CLAUDE);
    expect(source.status, id).toBe(404);
    expect(await source.text()).not.toMatch(/secret|team/);
    const page = await (await callViewer(`/${id}`, undefined, CLAUDE)).text();
    expect(page, id).not.toMatch(/<p>(secret|team)<\/p>/);
  }
  // The draft screen points the owner's AI at the connector; it says nothing of the page itself.
  expect(await (await callViewer(`/${draft.id}`, undefined, CLAUDE)).text()).toContain(`get_page tool, id ${draft.id}`);
  expect(await (await callViewer(`/${draft.id}`)).text()).not.toContain('get_page');
});

it('sends the bare viewer address to the landing page on the app', async () => {
  const response = await callViewer('/');
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('https://app.test/');
});

it('shows the title in a bar above a sandboxed frame of /:id/raw, with the title escaped', async () => {
  const { id } = await publish('<b>"Tom" & Jerry</b>');

  const frame = await callViewer(`/${id}`);
  expect(frame.status).toBe(200);
  expect(frame.headers.get('content-type')).toContain('text/html');
  expect(frame.headers.get('cache-control')).toBe('no-store');
  expect(frame.headers.get('cross-origin-opener-policy')).toBe('same-origin'); // a window the page opens cannot send this tab elsewhere
  const html = await frame.text();
  expect(html).toContain(`sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="/${id}/raw"`);
  expect(html).toContain('Jerry');
  expect(html).not.toContain('<b>');
});

it("opens the About dialog with the landing page's headline and lede, then a link to the landing", async () => {
  const { id } = await publish();

  const html = await (await callViewer(`/${id}`)).text();
  expect(html).toContain(`<h2 id="about-title">${sentences(HEADLINE)}</h2>`);
  expect(html).toContain(`<p>${LEDE.join(' ')}</p>`);
  expect(html).toContain(`<a class="go" href="${env.APP_ORIGIN}/" target="_blank" rel="noopener" aria-label="See what Campfile does (opens in a new tab)">See what Campfile does</a>`);
});

it.each(['hidden', 'deleted'])('says the page was removed when its status is %s, even though the file is still stored', async (status) => {
  const { id } = await publish();
  await sql`update pages set status = ${status} where id = ${id}`;
  expect(files.has(await fileOf(id))).toBe(true);

  for (const path of [`/${id}`, `/${id}/raw`]) {
    const response = await callViewer(path);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('This page was removed');
  }
});

it('checks the status on every request: a page that was live is removed the moment it is hidden', async () => {
  const { id } = await publish();
  expect((await callViewer(`/${id}/raw`)).status).toBe(200);
  await sql`update pages set status = 'hidden' where id = ${id}`;
  expect((await callViewer(`/${id}/raw`)).status).toBe(404);
});

it('says the page was removed for an unknown id, a live page without a file, and paths that are not ids', async () => {
  const { id } = await publish();
  files.delete(await fileOf(id));
  for (const path of [`/${id}/raw`, '/ZZZZZZZZ', '/ZZZZZZZZ/raw', '/abc', '/favicon.ico']) {
    const response = await callViewer(path);
    expect(response.status, path).toBe(404);
    expect(await response.text()).toContain('This page was removed');
  }
});

// docs/SPEC.md "Open counts". A visitor's browser loads /raw into the frame page's iframe.
const FRAME = { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'same-origin', 'Campfile-Client-Country': 'NO' };
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const open = (id: string, ip: string, agent = CHROME, more: Record<string, string> = {}) =>
  callViewer(`/${id}/raw`, undefined, { headers: { ...FRAME, 'Campfile-Client-IP': ip, 'User-Agent': agent, ...more } });
// collate "C": byte order, like the JS sort below; CI's Postgres (glibc en_US) would sort ids case-insensitively.
const counts = () =>
  sql<{ page: string; opens: number; visitors: number; countries: string[] }[]>`
    select page, sum(opens)::int as opens, count(*)::int as visitors, array_agg(distinct country) as countries from page_visits group by page order by page collate "C"`;

it('counts opens and approximate visitors per page and day, keeping a hash and the country but no IP or browser', async () => {
  const key = await addTester('amy');
  const [a, b] = [await publishedPage(key, 'A'), await publishedPage(key, 'B')].sort((x, y) => (x.id < y.id ? -1 : 1));

  await open(a.id, '203.0.113.7');
  await open(a.id, '203.0.113.7'); // a reload, or someone else on the same Wi-Fi with the same browser: one visitor
  await open(a.id, '203.0.113.7', SAFARI); // another browser on the same Wi-Fi: another visitor
  await open(a.id, '198.51.100.2'); // the first phone, now on mobile data: counted again
  await open(b.id, '203.0.113.7'); // the first visitor on another page
  expect(await counts()).toEqual([
    { page: a.id, opens: 4, visitors: 3, countries: ['NO'] },
    { page: b.id, opens: 1, visitors: 1, countries: ['NO'] },
  ]);
  const stored = JSON.stringify(await sql`select * from page_visits`);
  expect(stored).not.toMatch(/203\.0\.113\.7|198\.51\.100\.2|Chrome|Safari/);

  // A new salt (the next day's, once the cron deleted this one) can't match the same visitor again.
  await sql`delete from visit_salts`;
  await open(b.id, '203.0.113.7');
  expect((await counts())[1]).toMatchObject({ opens: 2, visitors: 2 });
});

it('counts no owner, bot, link-preview screenshot, top-level or cross-site load, and no /source or frame page fetch', async () => {
  const { id } = await publishedPage(await addTester('amy'));
  const ip = '203.0.113.7';

  await callViewer(`/${id}/raw`, undefined, { headers: { ...FRAME, 'User-Agent': CHROME, Cookie: await viewerOwner(id) } });
  await open(id, ip, 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
  await open(id, ip, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36');
  await open(id, ip, CHROME, { 'Campfile-Screenshot': '1' }); // the screenshot service sends a normal Chrome User-Agent
  await open(id, ip, CHROME, { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none' }); // /raw typed into the address bar
  await open(id, ip, CHROME, { 'Sec-Fetch-Site': 'cross-site' }); // another site's iframe
  await callViewer(`/${id}/source`, undefined, { headers: { ...FRAME, 'User-Agent': CHROME } });
  await callViewer(`/${id}`, undefined, { headers: { 'User-Agent': CHROME } });
  expect(await counts()).toEqual([]);

  expect((await open(id, ip)).status).toBe(200);
  expect(await counts()).toMatchObject([{ opens: 1, visitors: 1 }]);
});

// docs/SPEC.md "Managing a page": the app's page view frames its owner's /raw with a ticket (src/page-view.ts), since the login cookie does not reach a frame on another site.
const now = () => Math.floor(Date.now() / 1000);
const ownerOf = async (id: string) => (await sql<{ owner: number }[]>`select owner from pages where id = ${id}`)[0].owner;
const ticket = (id: string, tester: number, until = now() + 12 * 3600) => signedId(env.PREVIEW_SECRET, `view:${id}`, tester, until);
const framed = (id: string, kind: string, t: string) => callViewer(`/${id}/${kind}?t=${t}`, undefined, { headers: { ...FRAME, 'User-Agent': CHROME } });

it("opens a draft, a live page and an approval page at /raw and /source for their owner's ticket, for the app to frame, and counts no open", async () => {
  const key = await addTester('amy');
  const draft = await createPage(key, 'Draft', '<p>draft</p>');
  const live = await publishedPage(key, 'Live', '<p>live</p>');
  const gated = await createPage(key, 'Gated', '<p>gated</p>');
  expect((await click('publish', gated.id, env, { access: 'approval' })).status).toBe(303);

  for (const [{ id }, html] of [[draft, '<p>draft</p>'], [live, '<p>live</p>'], [gated, '<p>gated</p>']]) {
    const t = await ticket(id, await ownerOf(id));
    const raw = await framed(id, 'raw', t);
    expect(raw.status, id).toBe(200);
    expect(await raw.text(), id).toBe(served(html));
    expect(raw.headers.get('content-security-policy'), id).toBe(RAW_CSP);
    expect((await framed(id, 'source', t)).status, id).toBe(200);
  }
  expect(await counts()).toEqual([]);
  expect((await open(live.id, '203.0.113.7')).status).toBe(200); // the same load with no ticket is a visitor's
  expect(await counts()).toMatchObject([{ opens: 1, visitors: 1 }]);
});

it("keeps a draft's /raw and /source shut for a ticket that is not its owner's: for another page or workspace, expired, altered, or a login's", async () => {
  const key = await addTester('amy');
  await addTester('bob');
  const [{ id: bob }] = await sql<{ id: number }[]>`select id from testers where name = 'bob'`;
  const draft = await createPage(key, 'Secret draft', '<p>secret</p>');
  const other = await createPage(key, 'Other draft', '<p>other</p>');
  const owner = await ownerOf(draft.id);
  const good = await ticket(draft.id, owner);

  for (const [name, t] of [
    ["another page's ticket", await ticket(other.id, owner)],
    ["another workspace's ticket", await ticket(draft.id, bob)],
    ['an expired ticket', await ticket(draft.id, owner, now() - 1)],
    ["the owner's id swapped for another workspace's", good.replace(/^\d+/, String(bob))],
    ['a longer expiry', good.replace(/\.\d+\./, '.9999999999.')],
    ["a login cookie's value", await signedId(env.PREVIEW_SECRET, 'owner', owner, now() + 60)],
    ['no ticket', ''],
  ]) {
    for (const kind of ['raw', 'source']) {
      const response = await framed(draft.id, kind, t);
      expect(response.status, `${name} at /${kind}`).toBe(404);
      const text = await response.text();
      expect(text, `${name} at /${kind}`).toContain("This page isn't published");
      expect(text, `${name} at /${kind}`).not.toMatch(/secret|other/i);
    }
  }
  expect((await framed(draft.id, 'raw', good)).status).toBe(200); // the right one still works
  // Only /raw and /source read a ticket.
  const visitor = await callViewer(`/${draft.id}?t=${good}`);
  expect(visitor.status).toBe(404);
  expect(await visitor.text()).toContain('or took it offline. Is it yours? Log in to see it.'); // a logged-out visitor at GET /:id
  expect((await callViewer(`/${draft.id}/spread?t=${good}`)).status).toBe(404);
});

it("counts an open that arrives while another request is making the day's salt", async () => {
  const { id } = await publishedPage(await addTester('amy'));
  let opening: Promise<Response> | undefined;
  await sql.begin(async (tx) => {
    await tx`insert into visit_salts (day, salt) values (current_date, 'first')`;
    opening = open(id, '203.0.113.7');
    // Hold the salt uncommitted until the open's own salt insert waits on it (each check is a round trip, no timer).
    while (!(await sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%visit_salts%'`).length);
  });
  expect((await opening!).status).toBe(200);
  expect(await counts()).toMatchObject([{ opens: 1, visitors: 1 }]);
  expect(await sql`select salt from visit_salts`).toEqual([{ salt: 'first' }]);
});

it("deletes past days' salts in the daily cron and keeps today's", async () => {
  await sql`insert into visit_salts (day, salt) values (current_date - 1, 'old'), (current_date, 'new')`;
  await purgeExpired(sql);
  expect(await sql`select salt from visit_salts`).toEqual([{ salt: 'new' }]);
});
