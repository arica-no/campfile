import { expect, it, vi } from 'vitest';
import type { Bucket } from '../src/env.ts';
import { MAX_BODY_BYTES, MAX_HTML_BYTES, MAX_HTML_BYTES_UNLIMITED, MAX_NEW_PAGES_PER_DAY, MAX_PAGES, MAX_READ_CHARS, MAX_STORAGE_BYTES, NO_SUCH_PAGE, sweepOrphans } from '../src/pages.ts';
import { addTester, api, callApp, callViewer, createPage, env, fileOf, files, json, publishedPage, served, sql, stored, uploaded, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

it('answers GET / with plain-text instructions built from APP_ORIGIN', async () => {
  const response = await callApp('/');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  const text = await response.text();
  expect(text).toContain('curl -sS -X POST https://app.test/api/pages -H "Authorization: Bearer $(cat ~/.config/campfile/credentials 2>/dev/null || cat ~/.config/campfire/credentials)"');
  expect(text).toContain('curl -sS -X PUT https://app.test/api/pages/PAGE_ID');
  expect(text).toContain('curl -sS -X DELETE https://app.test/api/pages/PAGE_ID');
  expect(text).toContain('curl -sS https://app.test/api/pages -H');
  expect(text).toContain('curl -sS -X POST https://app.test/api/pages/PAGE_ID/publish');
  expect(text).toContain('curl -sS -X POST https://app.test/api/pages/PAGE_ID/unpublish');
  expect(text).toContain('curl -sS -X POST https://app.test/api/pages/PAGE_ID/people/decide');
});

it('gives agents the same instructions at /agents as at /', async () => {
  const agents = await callApp('/agents');
  expect(agents.headers.get('content-type')).toContain('text/plain');
  expect(await agents.text()).toBe(await (await callApp('/')).text());
});

it.each([
  ['no key', undefined],
  ['a wrong key', 'Bearer not-a-real-key'],
  ['a key that is not a Bearer token', 'Basic abc'],
])('answers 401 for %s', async (_name, authorization) => {
  const response = await callApp('/api/pages', authorization ? { headers: { Authorization: authorization } } : undefined);
  expect(response.status).toBe(401);
  expect(await json(response)).toEqual({ error: expect.any(String) });
});

it('answers 401 once a tester is disabled', async () => {
  const key = await addTester('amy');
  expect((await api(key, 'GET', '/api/pages')).status).toBe(200);
  await sql`update testers set disabled_at = now() where name = 'amy'`;
  expect((await api(key, 'GET', '/api/pages')).status).toBe(401);
});

it('creates a draft and lists it', async () => {
  const key = await addTester('amy');
  const created = await api(key, 'POST', '/api/pages', { title: '  My page  ', html: '<p>hello</p>' });
  expect(created.status).toBe(201);
  const { id, url, published } = await json(created);
  expect(id).toMatch(/^[A-Za-z0-9]{8}$/);
  expect(url).toBe(`https://view.test/${id}`);
  expect(published).toBe(false);
  const file = await fileOf(id);
  expect(file).toMatch(new RegExp(`^pages/${id}/[0-9a-f-]{36}\\.html$`));
  expect(files.get(file)).toEqual(new TextEncoder().encode('<p>hello</p>'));
  expect(stored('previews/')).toHaveLength(1); // the wall's picture of the draft, taken as its owner

  const listed = await json(await api(key, 'GET', '/api/pages'));
  expect(listed).toEqual({
    pages: [{ id, title: 'My page', url, published: false, access: 'link', sharing: 'off', updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), group: null }],
  });
});

it("reads the owner's own page, drafts included, cuts a long source with a note, and hides another tester's page", async () => {
  const amy = await addTester('amy');
  const bob = await addTester('bob');
  const { id, url } = await createPage(amy, 'Draft', '<p>draft</p>');
  expect(await json(await api(amy, 'GET', `/api/pages/${id}`))).toMatchObject({ id, url, published: false, title: 'Draft', access: 'link', html: '<p>draft</p>' });
  expect((await api(bob, 'GET', `/api/pages/${id}`)).status).toBe(404);

  const long = 'a'.repeat(MAX_READ_CHARS) + '<p>end</p>';
  await api(amy, 'PUT', `/api/pages/${id}`, { html: long });
  const read = await json(await api(amy, 'GET', `/api/pages/${id}`));
  expect(read.html).toBe(long.slice(0, MAX_READ_CHARS));
  expect(read.truncated).toBe(true);
  expect(read.note).toContain('cannot be sent back with update_page');
});

it('cuts a 25 MB source of control characters without escaping the whole of it', async () => {
  const key = await addTester('amy');
  await sql`update testers set unlimited = true`;
  vi.mocked(fetch).mockImplementationOnce(async () => new Response('\u0001'.repeat(MAX_HTML_BYTES_UNLIMITED)));
  const { id } = await json(await api(key, 'POST', '/api/pages', { title: 'Big', source_url: 'https://example.com/big.html' }));
  // Each character escapes to 6 (\u0001): escaping the whole page would be a 150 MB string, past the app's 128 MB.
  const stringify = vi.spyOn(JSON, 'stringify');
  const read = await json(await api(key, 'GET', `/api/pages/${id}`));
  const longest = Math.max(...stringify.mock.calls.map(([value]) => (typeof value === 'string' ? value.length : 0)));
  stringify.mockRestore();
  expect(longest).toBeLessThanOrEqual(MAX_READ_CHARS);
  expect(read.truncated).toBe(true);
  expect(read.html).toBe('\u0001'.repeat(Math.floor(MAX_READ_CHARS / 6)));
});

it('publishes when asked, checks that the public link opens, and unpublishes', async () => {
  const key = await addTester('amy');
  const { id, url } = await createPage(key, 'Hi', '<h1>Hi</h1>');

  const published = await api(key, 'POST', `/api/pages/${id}/publish`, {});
  expect(published.status).toBe(200);
  expect(await json(published)).toEqual({ id, url, published: true, access: 'link', sharing: 'off', public_link_works: true });
  expect((await callViewer(`/${id}/raw`)).status).toBe(200);

  const unpublished = await api(key, 'POST', `/api/pages/${id}/unpublish`);
  expect(await json(unpublished)).toMatchObject({ id, published: false });
  expect((await callViewer(`/${id}`)).status).toBe(404);
});

it('says when the public link does not open after publishing', async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  vi.mocked(fetch).mockImplementationOnce(async () => new Response('down', { status: 503 }));
  expect(await json(await api(key, 'POST', `/api/pages/${id}/publish`, { access: 'link' }))).toMatchObject({ published: true, public_link_works: false, public_link_status: 503 });
});

it("says the public link does not work when the page's file is missing, though its frame page opens", async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  files.delete((await fileOf(id))!);
  expect(await json(await api(key, 'POST', `/api/pages/${id}/publish`, { access: 'link' }))).toMatchObject({ published: true, public_link_works: false, public_link_status: 404 });
});

it('publishes with approval, lets people in and decides about them by email, like the owner page', async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  expect((await api(key, 'POST', `/api/pages/${id}/people`, { emails: 'ingrid@example.com' })).status).toBe(400); // a draft has nobody to let in

  const published = await json(await api(key, 'POST', `/api/pages/${id}/publish`, { access: 'approval', emails: 'ingrid@example.com' }));
  expect(published).toMatchObject({ published: true, access: 'approval', public_link_works: true }); // the ask-for-access page opens
  await api(key, 'POST', `/api/pages/${id}/people`, { emails: 'omar@example.com, Pia@Example.com' });
  const decided = await json(await api(key, 'POST', `/api/pages/${id}/people/decide`, { email: 'omar@example.com', decision: 'remove' }));
  expect(decided.people.map((person: { email: string; status: string }) => `${person.email} ${person.status}`).sort()).toEqual(['ingrid@example.com approved', 'pia@example.com approved']);
  expect(await json(await api(key, 'GET', `/api/pages/${id}/people`))).toEqual(decided);
  expect((await api(key, 'POST', `/api/pages/${id}/people/decide`, { email: 'nobody@example.com', decision: 'approve' })).status).toBe(404);
});

it.each([
  ['emails with access "link"', { access: 'link', emails: 'ingrid@example.com' }, 400],
  ['an unknown access', { access: 'everyone' }, 400],
  ['a body that is not JSON', 'oops', 400],
])('does not publish with %s', async (_name, body, status) => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  expect((await api(key, 'POST', `/api/pages/${id}/publish`, body)).status).toBe(status);
  expect(await sql`select id from pages where published_at is not null`).toHaveLength(0);
});

it("cannot publish, unpublish or see the people of another tester's page", async () => {
  const amy = await addTester('amy');
  const bob = await addTester('bob');
  const { id } = await createPage(amy);
  for (const [method, path] of [['POST', 'publish'], ['POST', 'unpublish'], ['GET', 'people']]) {
    expect((await api(bob, method, `/api/pages/${id}/${path}`, method === 'POST' ? {} : undefined)).status, path).toBe(404);
  }
  expect(await sql`select id from pages where published_at is not null`).toHaveLength(0);
});

it.each([
  ['a body that is not JSON', 'oops', 'must be JSON'],
  ['a body that is not an object', '[1]', 'Send a JSON object'],
  ['no html', '{"title":"x"}', 'Send "html", the page itself, or "source_url"'],
  ['both html and source_url', '{"title":"x","html":"<p>x</p>","source_url":"https://example.com/p.html"}', 'one of the two'],
  ['a source_url that is not https', '{"title":"x","source_url":"http://example.com/p.html"}', 'must be an https:// link'],
  ['empty html', '{"title":"x","html":""}', 'The html must not be empty.'],
  ['no title', '{"html":"<p>x</p>"}', 'The title must be text.'],
  ['a blank title', '{"title":"  ","html":"<p>x</p>"}', 'The title must not be empty.'],
  ['a title over 200 characters', JSON.stringify({ title: 'x'.repeat(201), html: '<p>x</p>' }), '200 characters or fewer'],
])('answers 400 with a plain message for %s', async (_name, body, message) => {
  const key = await addTester('amy');
  const response = await callApp('/api/pages', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body });
  expect(response.status).toBe(400);
  expect(await json(response)).toEqual({ error: expect.stringContaining(message) });
  expect(await sql`select id from pages`).toHaveLength(0);
});

it('updates a page in place: same id, same links, new content', async () => {
  const key = await addTester('amy');
  const { id, url } = await publishedPage(key, 'One', '<p>one</p>');

  const updated = await api(key, 'PUT', `/api/pages/${id}`, { html: '<p>two</p>' });
  expect(updated.status).toBe(200);
  expect(await json(updated)).toEqual({ id, url, published: true });
  expect(await (await callViewer(`/${id}/raw`)).text()).toBe(served('<p>two</p>'));
  expect((await json(await api(key, 'GET', '/api/pages'))).pages).toMatchObject([{ id, title: 'One' }]);

  await api(key, 'PUT', `/api/pages/${id}`, { title: 'Two', html: '<p>three</p>' });
  expect((await json(await api(key, 'GET', '/api/pages'))).pages).toMatchObject([{ id, title: 'Two' }]);
  expect(await sql`select id from pages`).toHaveLength(1);
  expect(stored('pages/')).toHaveLength(1); // each update deleted the file it replaced
});

it('does not let another tester update, delete or list a page', async () => {
  const amy = await addTester('amy');
  const bob = await addTester('bob');
  const { id } = await publishedPage(amy, 'Amy', '<p>amy</p>');

  const put = await api(bob, 'PUT', `/api/pages/${id}`, { html: '<p>bob</p>' });
  expect(put.status).toBe(404);
  expect(await json(put)).toEqual({ error: expect.stringContaining('No page with that id') });
  expect((await api(bob, 'DELETE', `/api/pages/${id}`)).status).toBe(404);
  expect(await json(await api(bob, 'GET', '/api/pages'))).toEqual({ pages: [] });

  expect(await (await callViewer(`/${id}/raw`)).text()).toBe(served('<p>amy</p>'));
  expect(stored('pages/')).toHaveLength(1); // bob's rejected update wrote nothing
  expect((await json(await api(amy, 'GET', '/api/pages'))).pages).toHaveLength(1);
});

it('deletes the row and the stored file, and the viewer says the page was removed', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key);
  const file = await fileOf(id);
  expect(files.has(file)).toBe(true);
  expect((await callViewer(`/${id}/raw`)).status).toBe(200);

  const deleted = await api(key, 'DELETE', `/api/pages/${id}`);
  expect(deleted.status).toBe(200);
  expect(await json(deleted)).toEqual({ id, deleted: true });
  expect(files.has(file)).toBe(false);
  expect(await sql`select id from pages`).toHaveLength(0);
  for (const path of [`/${id}`, `/${id}/raw`]) {
    const response = await callViewer(path);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('This page was removed');
  }
  const again = await api(key, 'DELETE', `/api/pages/${id}`);
  expect(again.status).toBe(404);
  expect(await json(again)).toEqual({ error: NO_SUCH_PAGE }); // the API's own words, not the connector's plan-again steps
});

it('the daily sweep deletes files a failed delete left behind, and keeps live files and fresh uploads', async () => {
  const key = await addTester('amy');
  const kept = await createPage(key);
  const gone = await createPage(key);
  const orphan = await fileOf(gone.id);
  const brokenBucket = { ...env.PAGES, delete: async () => Promise.reject(new Error('The bucket is down')) };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await api(key, 'DELETE', `/api/pages/${gone.id}`, undefined, { ...env, PAGES: brokenBucket })).status).toBe(200);
  } finally {
    log.mockRestore();
  }
  expect(files.has(orphan)).toBe(true);

  await sweepOrphans(sql, env.PAGES);
  expect(files.has(orphan)).toBe(true); // under an hour old: its upload may not have reached its row yet

  const hourAgo = new Date(Date.now() - 61 * 60 * 1000);
  for (const file of files.keys()) uploaded.set(file, hourAgo);
  await sweepOrphans(sql, env.PAGES);
  expect(stored('pages/')).toEqual([await fileOf(kept.id)]);
});

it('never issues an id again, even after its page was deleted', async () => {
  const key = await addTester('amy');
  await sql`insert into page_ids (id) values ('AAAAAAAA')`; // issued before, page since deleted
  const randomValues = crypto.getRandomValues.bind(crypto);
  let first = true;
  const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(((bytes: Uint8Array<ArrayBuffer>) => {
    if (first && bytes.length === 16) {
      first = false;
      return bytes.fill(0); // the generator's first draw would be AAAAAAAA
    }
    return randomValues(bytes);
  }) as typeof crypto.getRandomValues);
  try {
    const { id } = await createPage(key);
    expect(first).toBe(false);
    expect(id).not.toBe('AAAAAAAA');
  } finally {
    spy.mockRestore();
  }
});

it('refuses more than 5 MB of HTML, counted in bytes', async () => {
  const key = await addTester('amy');
  const atLimit = await api(key, 'POST', '/api/pages', { title: 'Big', html: 'a'.repeat(MAX_HTML_BYTES) });
  expect(atLimit.status).toBe(201);
  const { id } = await json(atLimit);

  const tooBig = await api(key, 'POST', '/api/pages', { title: 'Big', html: 'a'.repeat(MAX_HTML_BYTES + 1) });
  expect(tooBig.status).toBe(413);
  expect(await json(tooBig)).toEqual({ error: expect.stringContaining('5 MB') });

  // Half as many characters, but two bytes each.
  const multibyte = await api(key, 'POST', '/api/pages', { title: 'Big', html: 'é'.repeat(MAX_HTML_BYTES / 2 + 1) });
  expect(multibyte.status).toBe(413);

  const update = await api(key, 'PUT', `/api/pages/${id}`, { html: 'a'.repeat(MAX_HTML_BYTES + 1) });
  expect(update.status).toBe(413);
  expect(files.get(await fileOf(id))).toHaveLength(MAX_HTML_BYTES);
  expect(stored('pages/')).toHaveLength(1);
  expect(await sql`select id from pages`).toHaveLength(1);
});

it('refuses a request body far over the limit', async () => {
  const key = await addTester('amy');
  const response = await callApp('/api/pages', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: 'x'.repeat(MAX_BODY_BYTES + 1) });
  expect(response.status).toBe(413);
  expect(await json(response)).toEqual({ error: expect.stringContaining('5 MB') });
});

it('stops a tester at 200 pages until one is deleted', async () => {
  const key = await addTester('amy');
  const [{ id: owner }] = await sql`select id from testers`;
  await sql`insert into page_ids (id) select lpad(n::text, 8, '0') from generate_series(1, ${MAX_PAGES}::int) n`;
  await sql`insert into pages (id, owner, title, size, file) select lpad(n::text, 8, '0'), ${owner}, 'p', 1, 'pages/none' from generate_series(1, ${MAX_PAGES}::int) n`;

  const full = await api(key, 'POST', '/api/pages', { title: 'One too many', html: '<p>x</p>' });
  expect(full.status).toBe(403);
  expect(await json(full)).toEqual({ error: expect.stringContaining('200 pages') });

  await api(key, 'DELETE', '/api/pages/00000001');
  expect((await api(key, 'POST', '/api/pages', { title: 'Fits now', html: '<p>x</p>' })).status).toBe(201);
});

it(`stops a tester after ${MAX_NEW_PAGES_PER_DAY} new pages in a UTC day; updates never count`, async () => {
  const key = await addTester('amy');
  const other = await addTester('bob');
  const { id } = await createPage(key);
  await sql`update testers set writes = ${MAX_NEW_PAGES_PER_DAY - 1} where name = 'amy'`;

  expect((await api(key, 'PUT', `/api/pages/${id}`, { html: '<p>update</p>' })).status).toBe(200);
  expect((await api(key, 'POST', '/api/pages', { title: 'Fiftieth', html: '<p>50</p>' })).status).toBe(201);
  const over = await api(key, 'POST', '/api/pages', { title: 'One too many', html: '<p>x</p>' });
  expect(over.status).toBe(429);
  expect(await json(over)).toEqual({ error: expect.stringContaining('50 new pages today, which is the daily limit') });
  // Over the limit, updating an existing page still works and does not count.
  expect((await api(key, 'PUT', `/api/pages/${id}`, { html: '<p>changed</p>' })).status).toBe(200);
  expect(new TextDecoder().decode(files.get(await fileOf(id)))).toBe('<p>changed</p>');
  expect(await sql`select writes from testers where name = 'amy'`).toEqual([{ writes: MAX_NEW_PAGES_PER_DAY + 1 }]);

  // Deleting still works, and another tester has their own count.
  expect((await api(key, 'DELETE', `/api/pages/${id}`)).status).toBe(200);
  expect((await createPage(other)).id).toBeDefined();

  // A new day starts over.
  await sql`update testers set writes_day = writes_day - 1 where name = 'amy'`;
  expect((await api(key, 'POST', '/api/pages', { title: 'Tomorrow', html: '<p>x</p>' })).status).toBe(201);
  expect(await sql`select writes from testers where name = 'amy'`).toEqual([{ writes: 1 }]);
});

it('lets an unlimited workspace past the page, storage and daily caps, and up to 25 MB a page by source_url', async () => {
  const key = await addTester('amy');
  const [{ id: owner }] = await sql`update testers set unlimited = true, writes = ${MAX_NEW_PAGES_PER_DAY}, writes_day = (now() at time zone 'utc')::date returning id`;
  await sql`insert into page_ids (id) select lpad(n::text, 8, '0') from generate_series(1, ${MAX_PAGES}::int) n`;
  await sql`insert into pages (id, owner, title, size, file) select lpad(n::text, 8, '0'), ${owner}, 'p', ${MAX_STORAGE_BYTES / MAX_PAGES}, 'pages/none' from generate_series(1, ${MAX_PAGES}::int) n`;

  const created = await api(key, 'POST', '/api/pages', { title: 'Past every cap', html: '<p>x</p>' });
  expect(created.status).toBe(201);
  const { id } = await json(created);
  expect((await api(key, 'PUT', `/api/pages/${id}`, { html: 'x'.repeat(MAX_HTML_BYTES + 1) })).status).toBe(200);

  const url = 'https://example.com/big.html';
  vi.mocked(fetch).mockImplementationOnce(async () => new Response('x'.repeat(MAX_HTML_BYTES_UNLIMITED)));
  expect((await api(key, 'PUT', `/api/pages/${id}`, { source_url: url })).status).toBe(200);
  expect(files.get(await fileOf(id))).toHaveLength(MAX_HTML_BYTES_UNLIMITED);

  vi.mocked(fetch).mockImplementationOnce(async () => new Response('x'.repeat(MAX_HTML_BYTES_UNLIMITED + 1)));
  const tooBig = await api(key, 'PUT', `/api/pages/${id}`, { source_url: url });
  expect(tooBig.status).toBe(413);
  expect(await json(tooBig)).toEqual({ error: expect.stringContaining('25 MB') });
  expect(files.get(await fileOf(id))).toHaveLength(MAX_HTML_BYTES_UNLIMITED);

  // Inline, a page that big is past the request cap: the answer points to source_url.
  const inline = await callApp(`/api/pages/${id}`, { method: 'PUT', headers: { Authorization: `Bearer ${key}` }, body: 'x'.repeat(MAX_BODY_BYTES + 1) });
  expect(inline.status).toBe(413);
  expect(await json(inline)).toEqual({ error: expect.stringContaining('"source_url"') });
});

it('makes a page from the file at source_url, within the 5 MB limit, and saves nothing when the download fails', async () => {
  const key = await addTester('amy');
  const url = 'https://raw.githubusercontent.com/someone/site/main/index.html';
  vi.mocked(fetch).mockImplementationOnce(async (input) => new Response(String(input) === url ? '<p>from the link</p>' : null, { status: String(input) === url ? 200 : 404 }));
  const created = await api(key, 'POST', '/api/pages', { title: 'Linked', source_url: url });
  expect(created.status).toBe(201);
  const { id } = await json(created);
  expect(new TextDecoder().decode(files.get(await fileOf(id)))).toBe('<p>from the link</p>');

  vi.mocked(fetch).mockImplementationOnce(async () => new Response('x'.repeat(MAX_HTML_BYTES + 1)));
  const tooBig = await api(key, 'POST', '/api/pages', { title: 'Big', source_url: url });
  expect(tooBig.status).toBe(413);
  expect(await json(tooBig)).toEqual({ error: expect.stringContaining('5 MB') });

  vi.mocked(fetch).mockImplementationOnce(async () => new Response('gone', { status: 404 }));
  const missing = await api(key, 'PUT', `/api/pages/${id}`, { source_url: url });
  expect(missing.status).toBe(400);
  expect(await json(missing)).toEqual({ error: expect.stringContaining('it answered 404') });

  vi.mocked(fetch).mockImplementationOnce(async () => Promise.reject(new TypeError('fetch failed')));
  expect(await json(await api(key, 'POST', '/api/pages', { title: 'Nowhere', source_url: url }))).toEqual({ error: expect.stringContaining('nothing answered') });

  expect(new TextDecoder().decode(files.get(await fileOf(id)))).toBe('<p>from the link</p>');
  expect(await sql`select id from pages`).toHaveLength(1);
  // A refused download counts no write.
  expect(await sql`select writes from testers`).toEqual([{ writes: 1 }]);
});

it('refuses a source_url download while the pages downloaded or being written hold the memory for downloads, and takes one again once they finish', async () => {
  const key = await addTester('amy');
  await sql`update testers set unlimited = true`; // 25 MB a page: one such download holds most of the budget
  let finish: (() => void) | undefined;
  vi.mocked(fetch).mockImplementationOnce(
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('<p>slow</p>'));
            finish = () => stream.close();
          },
        }),
      ),
  );
  const slow = api(key, 'POST', '/api/pages', { title: 'Slow', source_url: 'https://example.com/slow.html' });
  await vi.waitFor(() => expect(finish).toBeDefined());

  const busy = await api(key, 'POST', '/api/pages', { title: 'Busy', source_url: 'https://example.com/busy.html' });
  expect(busy.status).toBe(429);
  expect(await json(busy)).toEqual({ error: expect.stringContaining('downloading other pages') });

  finish!();
  expect((await slow).status).toBe(201);
  vi.mocked(fetch).mockImplementationOnce(async () => new Response('<p>later</p>'));
  expect((await api(key, 'POST', '/api/pages', { title: 'Later', source_url: 'https://example.com/later.html' })).status).toBe(201);

  // Downloaded at once, but its write is slow: the page still holds its room until it is written.
  const put = env.PAGES.put.bind(env.PAGES);
  const writing = Promise.withResolvers<void>();
  let writes = 0;
  vi.spyOn(env.PAGES, 'put').mockImplementationOnce(async (...args: Parameters<typeof put>) => {
    writes++;
    await writing.promise;
    return put(...args);
  });
  vi.mocked(fetch).mockImplementationOnce(async () => new Response('<p>fast</p>'));
  const stalled = api(key, 'POST', '/api/pages', { title: 'Stalled', source_url: 'https://example.com/fast.html' });
  await vi.waitFor(() => expect(writes).toBe(1));
  expect((await api(key, 'POST', '/api/pages', { title: 'Busy', source_url: 'https://example.com/busy.html' })).status).toBe(429);
  writing.resolve();
  expect((await stalled).status).toBe(201);
});

it('stops a tester at 100 MB of pages, drafts included, until they make room', async () => {
  const key = await addTester('amy');
  const [{ id: owner }] = await sql`select id from testers`;
  const used = '<p>hello</p>'.length;
  const { id } = await createPage(key);
  // A draft that leaves 10 bytes free, plus a taken-down page, which does not count: its owner cannot delete it.
  await sql`insert into page_ids (id) values ('00000001'), ('00000002')`;
  await sql`insert into pages (id, owner, title, size, file) values ('00000001', ${owner}, 'big', ${MAX_STORAGE_BYTES - used - 10}, 'pages/none')`;
  await sql`insert into pages (id, owner, title, size, file, status) values ('00000002', ${owner}, 'gone', ${MAX_HTML_BYTES}, 'pages/none', 'hidden')`;

  expect((await api(key, 'POST', '/api/pages', { title: 'Fits', html: 'a'.repeat(10) })).status).toBe(201);
  const full = await api(key, 'POST', '/api/pages', { title: 'Over', html: 'a' });
  expect(full.status).toBe(403);
  // One byte over shows as 100.1, never a confusing 100.0.
  expect(await json(full)).toEqual({ error: expect.stringContaining('bring your pages to 100.1 MB, drafts included, and the limit is 100 MB') });

  // Growing a page is refused; shrinking it always works.
  expect((await api(key, 'PUT', `/api/pages/${id}`, { html: 'a'.repeat(used + 1) })).status).toBe(403);
  expect((await api(key, 'PUT', `/api/pages/${id}`, { html: 'a' })).status).toBe(200);
  expect((await api(key, 'POST', '/api/pages', { title: 'Fits again', html: 'a'.repeat(used - 1) })).status).toBe(201);

  await api(key, 'DELETE', '/api/pages/00000001');
  expect((await api(key, 'POST', '/api/pages', { title: 'Room now', html: 'a'.repeat(MAX_HTML_BYTES) })).status).toBe(201);
});

it('does not keep a page whose file could not be stored', async () => {
  const key = await addTester('amy');
  const brokenBucket = { ...env.PAGES, put: async () => Promise.reject(new Error('The bucket is down')) };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await api(key, 'POST', '/api/pages', { title: 'x', html: '<p>x</p>' }, { ...env, PAGES: brokenBucket });
    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({ error: expect.stringContaining('Something went wrong') });
    expect(await sql`select id from pages`).toHaveLength(0);
  } finally {
    log.mockRestore();
  }
});

it('keeps the old page, title and size when an update cannot be stored', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key, 'Old title', '<p>old</p>');
  const [before] = await sql`select title, size, file from pages where id = ${id}`;
  const brokenBucket = { ...env.PAGES, put: async () => Promise.reject(new Error('The bucket is down')) };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await api(key, 'PUT', `/api/pages/${id}`, { title: 'New title', html: '<p>new and longer</p>' }, { ...env, PAGES: brokenBucket });
    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({ error: expect.stringContaining('Something went wrong') });
  } finally {
    log.mockRestore();
  }
  const [after] = await sql`select title, size, file from pages where id = ${id}`;
  expect(after).toEqual(before);
  expect(await (await callViewer(`/${id}/raw`)).text()).toBe(served('<p>old</p>'));
  expect(stored('pages/')).toHaveLength(1);
});

/** A bucket whose first put waits for release(), so a test can run other requests while that put is in flight. */
function gatedBucket() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let puts = 0;
  const bucket: Bucket = {
    ...env.PAGES,
    async put(key, value) {
      if (puts++ === 0) await gate;
      return env.PAGES.put(key, value);
    },
  };
  return { bucket, release, firstPutStarted: () => vi.waitFor(() => expect(puts).toBeGreaterThan(0)) };
}

it('ends with one consistent version when two updates overlap', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key, 'Old', '<p>old</p>');
  const slow = gatedBucket();

  // A is stuck uploading. B starts after A, commits first and is replaced when A commits last.
  const a = api(key, 'PUT', `/api/pages/${id}`, { title: 'A', html: '<p>a</p>' }, { ...env, PAGES: slow.bucket });
  await slow.firstPutStarted();
  const b = await api(key, 'PUT', `/api/pages/${id}`, { title: 'B', html: '<p>bb</p>' }, { ...env, PAGES: slow.bucket });
  expect(b.status).toBe(200);
  slow.release();
  expect((await a).status).toBe(200);

  const [row] = await sql<{ title: string; size: number; file: string }[]>`select title, size, file from pages where id = ${id}`;
  expect(row).toMatchObject({ title: 'A', size: new TextEncoder().encode('<p>a</p>').length });
  expect(files.get(row.file)).toEqual(new TextEncoder().encode('<p>a</p>'));
  expect(stored('pages/')).toEqual([row.file]);
  expect(await (await callViewer(`/${id}/raw`)).text()).toBe(served('<p>a</p>'));
});

it('removes the uploaded file and answers 404 when the page is deleted during an update', async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  const slow = gatedBucket();

  const update = api(key, 'PUT', `/api/pages/${id}`, { html: '<p>new</p>' }, { ...env, PAGES: slow.bucket });
  await slow.firstPutStarted();
  expect((await api(key, 'DELETE', `/api/pages/${id}`)).status).toBe(200);
  slow.release();

  expect((await update).status).toBe(404);
  expect(files.size).toBe(0);
});

it('keeps a page as it was taken down when the takedown lands during an update', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key, 'Bad', '<p>bad</p>');
  const [{ file }] = await sql<{ file: string }[]>`select file from pages where id = ${id}`;
  const slow = gatedBucket();

  const update = api(key, 'PUT', `/api/pages/${id}`, { html: '<p>harmless</p>' }, { ...env, PAGES: slow.bucket });
  await slow.firstPutStarted();
  await sql`update pages set status = 'hidden' where id = ${id}`;
  slow.release();

  expect((await update).status).toBe(404);
  expect(await sql`select file from pages where id = ${id}`).toEqual([{ file }]);
  expect(stored('pages/')).toEqual([file]);
});
