import { beforeEach, expect, it, vi } from 'vitest';
import type * as PreviewModule from '../src/preview.ts';
import app from '../src/app.ts';
import { CRON_SHOTS, shootDue } from '../src/pages.ts';
import { PREVIEW_WAIT_MS } from '../src/preview.ts';
import { addTester, api, callViewer, click, createPage, env, fakeBrowser, files, jpeg, json, previewOf, publishedPage, SHOT, sql, startApi, startClick, stored, useCleanDatabase } from './helpers.ts';

// Publishing and updating a published page wait up to 8 s for the screenshot. Here they wait 200 ms instead, and the tests check that the service asks for the real PREVIEW_WAIT_MS.
const { waits } = vi.hoisted(() => ({ waits: [] as number[] }));
vi.mock('../src/preview.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof PreviewModule>();
  return { ...actual, within: (ms: number, work: Promise<unknown>) => (waits.push(ms), actual.within(200, work)) };
});

useCleanDatabase();
beforeEach(() => {
  waits.length = 0;
});

const OTHER_SHOT = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x02]);

const frame = async (id: string) => (await callViewer(`/${id}`)).text();
const ogImage = (html: string) => /<meta property="og:image" content="([^"]+)">/.exec(html)?.[1];

/** True if the promise is still unsettled once the queued work has run. */
const isPending = (promise: Promise<unknown>) => Promise.race([promise.then(() => false), new Promise<boolean>((resolve) => setImmediate(() => resolve(true)))]);

/** A browser whose screenshot stays unfinished until `finish` is called. `started` resolves once it has been asked for one. */
function heldBrowser() {
  const started = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Response>();
  const { browser } = fakeBrowser(() => {
    started.resolve();
    return answer.promise;
  });
  return { browser, started: started.promise, finish: (bytes = SHOT) => answer.resolve(jpeg(bytes)) };
}

/** The page is live and has no preview: no stored image, a summary card, no og:image, and /preview.jpg is a 404. */
async function expectNoPreview(id: string) {
  expect(await previewOf(id)).toBeNull();
  expect(stored('previews/')).toEqual([]);
  const html = await frame(id);
  expect(html).not.toContain('og:image');
  expect(html).toContain('<meta name="twitter:card" content="summary">');
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(404);
  expect((await callViewer(`/${id}/raw`)).status).toBe(200);
}

it('screenshots the framed page when the page is published, stores the image and links it from the frame page', async () => {
  const key = await addTester('amy');
  const { browser, requests } = fakeBrowser();
  const bindings = { ...env, BROWSER: browser };
  const created = await api(key, 'POST', '/api/pages', { title: 'Hi', html: '<h1>Hi</h1>' }, bindings);
  expect(created.status).toBe(201);
  const { id, url } = await json(created);
  expect(requests.map((request) => request.cookies?.length)).toEqual([1]); // a draft is shot for the wall, as its owner
  requests.length = 0;
  expect((await click('publish', id, bindings)).status).toBe(303);

  // The framed viewer page, so the iframe sandbox and frame-src 'self' apply, at the size link previews use.
  expect(requests).toEqual([
    {
      url: `https://view.test/${id}`,
      viewport: { width: 1200, height: 630 },
      gotoOptions: { waitUntil: 'load', timeout: 10_000 },
      waitForTimeout: 2500,
      actionTimeout: 10_000,
      cacheTTL: 0,
      screenshotOptions: { type: 'jpeg', quality: 80 },
    },
  ]);
  const preview = await previewOf(id);
  expect(preview).toMatch(new RegExp(`^previews/${id}/[0-9a-f-]{36}\\.jpg$`));
  expect(files.get(preview!)).toEqual(SHOT);

  const html = await frame(id);
  const image = ogImage(html);
  expect(image).toMatch(new RegExp(`^https://view\\.test/${id}/preview\\.jpg\\?v=[0-9a-f]{8}$`));
  for (const tag of [
    '<meta property="og:type" content="website">',
    '<meta property="og:title" content="Hi">',
    '<meta property="og:description" content="Made for sharing">',
    `<meta property="og:url" content="${url}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:type" content="image/jpeg">',
    '<meta name="twitter:card" content="summary_large_image">',
  ]) {
    expect(html).toContain(tag);
  }

  const served = await callViewer(image!.replace('https://view.test', ''));
  expect(served.status).toBe(200);
  expect(served.headers.get('content-type')).toBe('image/jpeg');
  expect(served.headers.get('cache-control')).toBe('public, max-age=300'); // the only viewer response that may be cached
  expect(served.headers.get('x-content-type-options')).toBe('nosniff');
  expect(served.headers.get('referrer-policy')).toBe('no-referrer');
  expect(served.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(SHOT);
});

it.each([
  ['the screenshot service cannot be reached', () => Promise.reject(new Error('the binding is down'))],
  [
    'the screenshot service is over its limit (429)',
    () => new Response('{"success":false,"errors":[{"message":"Too many requests"}]}', { status: 429, headers: { 'Content-Type': 'application/json' } }),
  ],
  ['the screenshot service answers with something that is not a JPEG', () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } })],
])('still publishes, with a summary card instead of an image, when %s', async (_name, answer) => {
  const key = await addTester('amy');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { id } = await createPage(key, 'x', '<p>x</p>');
    const published = await click('publish', id, { ...env, BROWSER: fakeBrowser(answer).browser });
    expect(published.status).toBe(303);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${id}: Error: \\S`))); // the reason in the line itself: the log host drops an Error's message
    await expectNoPreview(id);
  } finally {
    log.mockRestore();
  }
});

it('still publishes, without a preview, when the image cannot be stored', async () => {
  const key = await addTester('amy');
  const put = (name: string, value: Uint8Array<ArrayBuffer>) => (name.startsWith('previews/') ? Promise.reject(new Error('The bucket is down')) : env.PAGES.put(name, value));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { id } = await createPage(key, 'x', '<p>x</p>');
    const published = await click('publish', id, { ...env, PAGES: { ...env.PAGES, put } });
    expect(published.status).toBe(303);
    await expectNoPreview(id);
  } finally {
    log.mockRestore();
  }
});

/** The request answers although its screenshot is still held; the screenshot then finishes, and only then does the page get its preview. */
async function expectLatePreview(request: ReturnType<typeof startApi>, id: string, slow: ReturnType<typeof heldBrowser>, status: number) {
  const response = await request.response;
  expect(response.status).toBe(status);
  expect(waits).toEqual([8000]);
  expect(PREVIEW_WAIT_MS).toBe(8000);

  // No image yet, and waitUntil still holds the request open for the screenshot.
  expect(await isPending(request.settled())).toBe(true);
  expect(await previewOf(id)).toBeNull();
  const early = await frame(id);
  expect(early).not.toContain('og:image');
  expect(early).toContain('<meta name="twitter:card" content="summary">');

  slow.finish();
  await request.settled();
  expect(files.get((await previewOf(id))!)).toEqual(SHOT);
  expect(ogImage(await frame(id))).toMatch(new RegExp(`^https://view\\.test/${id}/preview\\.jpg\\?v=`));
}

it('publishes without waiting for a slow screenshot, which is attached when it finishes', async () => {
  const key = await addTester('amy');
  const slow = heldBrowser();
  const { id } = await createPage(key, 'Slow', '<p>slow</p>');
  await expectLatePreview(await startClick('publish', id, { ...env, BROWSER: slow.browser }), id, slow, 303);
});

it('updates without waiting for a slow screenshot, which is attached when it finishes', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key);
  waits.length = 0;
  const slow = heldBrowser();
  await expectLatePreview(startApi(key, 'PUT', `/api/pages/${id}`, { html: '<p>slow</p>' }, { ...env, BROWSER: slow.browser }), id, slow, 200);
});

it('does not attach the screenshot of an older version to the newer page', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key);
  const slow = heldBrowser();
  const first = startApi(key, 'PUT', `/api/pages/${id}`, { html: '<p>one</p>' }, { ...env, BROWSER: slow.browser });
  await slow.started; // the page now has version one, whose screenshot is still running

  const second = await api(key, 'PUT', `/api/pages/${id}`, { html: '<p>two</p>' }, { ...env, BROWSER: fakeBrowser(() => jpeg(OTHER_SHOT)).browser });
  expect(second.status).toBe(200);
  const current = await previewOf(id);
  expect(files.get(current!)).toEqual(OTHER_SHOT);

  slow.finish(); // version one's screenshot arrives after version two's
  await first.settled();
  expect((await first.response).status).toBe(200);
  expect(await previewOf(id)).toBe(current);
  expect(stored('previews/')).toEqual([current]); // the stale image was thrown away
  expect(files.get(current!)).toEqual(OTHER_SHOT);
});

it('drops the old preview when a page is updated, and attaches the new one once it is ready', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key);
  const before = await previewOf(id);
  const imageBefore = ogImage(await frame(id));
  expect(before).not.toBeNull();

  const slow = heldBrowser();
  const updating = startApi(key, 'PUT', `/api/pages/${id}`, { html: '<p>new</p>' }, { ...env, BROWSER: slow.browser });
  await slow.started;
  // A thumbnail of the old content would mislead, so there is none until the new screenshot is ready.
  expect(await previewOf(id)).toBeNull();
  expect(files.has(before!)).toBe(false);
  expect(await frame(id)).not.toContain('og:image');

  slow.finish(OTHER_SHOT);
  await updating.settled();
  const after = await previewOf(id);
  expect(after).not.toBe(before);
  expect(files.get(after!)).toEqual(OTHER_SHOT);
  expect(stored('previews/')).toEqual([after]);
  const imageAfter = ogImage(await frame(id));
  expect(imageAfter).toBeDefined();
  expect(imageAfter).not.toBe(imageBefore); // apps that cached the old image ask for the new one
});

it('leaves a page without a preview, not with the old one, when the screenshot of an update fails', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key);
  expect(await previewOf(id)).not.toBeNull();

  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const updated = await api(key, 'PUT', `/api/pages/${id}`, { html: '<p>new</p>' }, { ...env, BROWSER: fakeBrowser(() => Promise.reject(new Error('down'))).browser });
    expect(updated.status).toBe(200);
  } finally {
    log.mockRestore();
  }
  await expectNoPreview(id);
});

it('deletes the preview with the page', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key);
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(200);

  expect((await api(key, 'DELETE', `/api/pages/${id}`)).status).toBe(200);
  expect(files.size).toBe(0);
  const gone = await callViewer(`/${id}/preview.jpg`);
  expect(gone.status).toBe(404);
  expect(await gone.text()).toContain('This page was removed');
});

it('throws away a screenshot that finishes after its page was deleted', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key);
  const slow = heldBrowser();
  const updating = startApi(key, 'PUT', `/api/pages/${id}`, { html: '<p>new</p>' }, { ...env, BROWSER: slow.browser });
  await slow.started;

  expect((await api(key, 'DELETE', `/api/pages/${id}`)).status).toBe(200);
  slow.finish();
  await updating.settled();
  expect((await updating.response).status).toBe(200);
  expect(files.size).toBe(0);
  expect(await sql`select id from pages`).toHaveLength(0);
});

it("throws away a screenshot that finishes after its page was unpublished, so a draft never has a link preview, only its own wall picture", async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  const slow = heldBrowser();
  const publishing = await startClick('publish', id, { ...env, BROWSER: slow.browser });
  await slow.started;

  expect((await click('unpublish', id)).status).toBe(303);
  slow.finish();
  await publishing.settled();
  expect((await publishing.response).status).toBe(303);
  const drafted = await previewOf(id);
  expect(drafted).not.toBeNull(); // the draft's own, taken at unpublish
  expect(stored('previews/')).toEqual([drafted]); // the late link-preview shot went
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(404);
});

it.each(['hidden', 'deleted'])('serves no preview image for a page whose status is %s, even though it is still stored', async (status) => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key);
  expect(stored('previews/')).toHaveLength(1);
  await sql`update pages set status = ${status} where id = ${id}`;

  for (const path of [`/${id}`, `/${id}/preview.jpg`]) {
    const response = await callViewer(path);
    expect(response.status, path).toBe(404);
    expect(await response.text()).toContain('This page was removed');
  }
});

it('escapes every value in the link-preview tags', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key, `<b>"Tom" & 'Jerry'</b>`);

  const html = await frame(id);
  expect(html).toContain('<meta property="og:title" content="&#60;b&#62;&#34;Tom&#34; &#38; &#39;Jerry&#39;&#60;/b&#62;">');
  expect(html).not.toContain('<b>');

  // The origin comes from the request, so a quote in the host must not end the attribute.
  const hostile = await (await callViewer(`/${id}`, 'https://a"b.test')).text();
  expect(hostile).toContain(`<meta property="og:url" content="https://a&#34;b.test/${id}">`);
  expect(hostile).toMatch(new RegExp(`<meta property="og:image" content="https://a&#34;b\\.test/${id}/preview\\.jpg\\?v=[0-9a-f]{8}">`));
  expect(hostile).not.toContain('a"b');
});

it('retries missing screenshots from the 10-minute cron in turns, so pages whose shot keeps failing cannot keep a healthy one from its turn', async () => {
  const key = await addTester('amy');
  const broken: string[] = [];
  for (let i = 0; i < CRON_SHOTS; i++) broken.push((await publishedPage(key, `Broken ${i}`)).id);
  const healthy = await publishedPage(key, 'Healthy');
  await sql`update pages set preview_file = null`; // all lost their screenshot; the broken ones were published first
  const urlOf = (id: string) => `${env.VIEWER_ORIGIN}/${id}`;
  const { browser, requests } = fakeBrowser((options) => (broken.some((id) => options.url === urlOf(id)) ? new Response('boom', { status: 500 }) : jpeg()));
  const cron = () => app.scheduled({ cron: '*/10 * * * *' }, { ...env, BROWSER: browser }, { waitUntil() {} });

  await cron();
  expect(requests.map((r) => r.url).sort()).toEqual(broken.map(urlOf).sort()); // a full run of the oldest; two at a time, so in any order
  expect(await previewOf(healthy.id)).toBeNull();
  await cron();
  expect(requests.at(-1)?.url).toBe(urlOf(healthy.id)); // the broken ones now wait: its turn
  expect(await previewOf(healthy.id)).not.toBeNull();
  await cron();
  expect(requests).toHaveLength(CRON_SHOTS + 1); // nothing is due

  // The wait doubles with each failed try: 2 h after the first, 4 h after the second.
  await sql`update pages set preview_tried_at = now() - interval '121 minutes' where id = ${broken[0]}`;
  await cron();
  expect(requests.at(-1)?.url).toBe(urlOf(broken[0]));
  await sql`update pages set preview_tried_at = now() - interval '3 hours' where id = ${broken[0]}`;
  await cron();
  expect(requests).toHaveLength(CRON_SHOTS + 2);
});

it('shoots each page once when the cron and a wall load catch up at the same time', async () => {
  const key = await addTester('amy');
  for (let i = 0; i < 4; i++) await publishedPage(key, `Page ${i}`);
  await sql`update pages set preview_file = null`;
  const { browser, requests } = fakeBrowser(async () => (await new Promise((resolve) => setTimeout(resolve, 50)), jpeg()));

  await Promise.all([shootDue(sql, { ...env, BROWSER: browser }, () => {}, 4), shootDue(sql, { ...env, BROWSER: browser }, () => {}, 4)]);
  expect(requests).toHaveLength(4);
  expect(new Set(requests.map((r) => r.url)).size).toBe(4);
  expect(await sql`select id from pages where preview_claimed_at is not null`).toHaveLength(0); // released after
});

it("starts no second round of the wall's shots when the first was slow, since work after the response is cut off", async () => {
  const key = await addTester('amy');
  for (let i = 0; i < 4; i++) await publishedPage(key, `Page ${i}`);
  await sql`update pages set preview_file = null`;
  const { browser, requests } = fakeBrowser(async () => (await new Promise((resolve) => setTimeout(resolve, 50)), jpeg()));

  await shootDue(sql, { ...env, BROWSER: browser }, () => {}, 4, undefined, 20);
  expect(requests).toHaveLength(2); // one round, two at once
  await shootDue(sql, { ...env, BROWSER: browser }, () => {}, 4, undefined, 1_000);
  expect(requests).toHaveLength(4); // a quick round leaves time for the next
});

it('does not count a refusal for lack of capacity (429 over the limit, 503 too busy) as a failed try, so the page keeps its turn', async () => {
  const key = await addTester('amy');
  const page = await publishedPage(key, 'Busy');
  await sql`update pages set preview_file = null where id = ${page.id}`;
  const refusals = [429, 503];
  const { browser, requests } = fakeBrowser(() => (refusals.length ? new Response('{"success":false}', { status: refusals.shift() }) : jpeg()));
  const cron = () => app.scheduled({ cron: '*/10 * * * *' }, { ...env, BROWSER: browser }, { waitUntil() {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});

  await cron();
  await cron();
  expect(requests).toHaveLength(2); // due again at once, not 2 h later
  expect(await sql`select preview_tries, preview_tried_at from pages where id = ${page.id}`).toEqual([{ preview_tries: 0, preview_tried_at: null }]);
  await cron();
  expect(await previewOf(page.id)).not.toBeNull();
});
