// Link previews on a self-hosted install: the drawn title card (selfhost/title-card.ts, served by src/viewer.ts at /:id/card.png) and the screenshot service's adapter (selfhost/screenshot-client.ts).
import { once } from 'node:events';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readConfig } from '../selfhost/config.ts';
import { serve, trustedProxies } from '../selfhost/http.ts';
import { screenshotService } from '../selfhost/screenshot-client.ts';
import { titleCard } from '../selfhost/title-card.ts';
import { BrowserBusy, takeScreenshot } from '../src/preview.ts';
import { addTester, callViewer, click, createPage, env, publishedPage, sql, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

const size = (png: Uint8Array) => ({ signature: [...png.slice(0, 8)], width: new DataView(png.buffer, png.byteOffset).getUint32(16), height: new DataView(png.buffer, png.byteOffset).getUint32(20) });
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

it('draws a 1200x630 PNG for a title of any length or script', async () => {
  for (const title of ['A', 'Quarterly numbers for the whole team', 'A very long title '.repeat(20), 'x'.repeat(400), '你好，世界', 'مرحبا', '🔥🔥🔥', '']) {
    expect(size(await titleCard(title)), title.slice(0, 20)).toEqual({ signature: PNG_SIGNATURE, width: 1200, height: 630 });
  }
});

it('draws the same title once and gives every asker the same card', async () => {
  expect(await titleCard('Same title')).toBe(await titleCard('Same title'));
});

// The viewer: the card stands in where a screenshot is missing, and only where the deployment draws one (env.TITLE_CARD, set by selfhost/server.ts alone).
const drawn = async (title: string) => new TextEncoder().encode(`card of ${title}`);
beforeEach(() => void (env.TITLE_CARD = drawn));
afterEach(() => void delete env.TITLE_CARD);

const ogImage = (html: string) => /<meta property="og:image" content="([^"]*)">/.exec(html)?.[1];
const withoutShot = async (id: string) => void (await sql`update pages set preview_file = null where id = ${id}`);

it('points og:image at the title card of a published page with no screenshot, and serves the card', async () => {
  const { id } = await publishedPage(await addTester('amy'), 'Hello & <welcome>');
  await withoutShot(id);
  const html = await (await callViewer(`/${id}`)).text();
  expect(ogImage(html)).toMatch(new RegExp(`^https://view\\.test/${id}/card\\.png\\?v=[0-9a-f]+$`));
  expect(html).toContain('<meta property="og:image:width" content="1200">');
  expect(html).toContain('<meta property="og:image:height" content="630">');
  expect(html).toContain('<meta property="og:image:type" content="image/png">');
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  const card = await callViewer(`/${id}/card.png`);
  expect(card.status).toBe(200);
  expect(card.headers.get('content-type')).toBe('image/png');
  expect(card.headers.get('cache-control')).toBe('public, max-age=86400');
  expect(await card.text()).toBe('card of Hello & <welcome>');
});

it('gives a retitled page another card address, so chat apps fetch the new card', async () => {
  const { id } = await publishedPage(await addTester('amy'), 'First');
  await withoutShot(id);
  const before = ogImage(await (await callViewer(`/${id}`)).text());
  await sql`update pages set title = 'Second' where id = ${id}`;
  expect(ogImage(await (await callViewer(`/${id}`)).text())).not.toBe(before);
});

it('keeps the screenshot as og:image when the page has one', async () => {
  const { id } = await publishedPage(await addTester('amy'), 'Shot');
  await sql`update pages set preview_file = 'previews/shot' where id = ${id}`;
  expect(ogImage(await (await callViewer(`/${id}`)).text())).toMatch(new RegExp(`^https://view\\.test/${id}/preview\\.jpg\\?v=`));
});

it('draws no card where the deployment has no card drawer, for a draft, or for a page that is gone', async () => {
  const key = await addTester('amy');
  const { id } = await publishedPage(key, 'Plain');
  await withoutShot(id);
  delete env.TITLE_CARD;
  expect(ogImage(await (await callViewer(`/${id}`)).text())).toBeUndefined();
  expect((await callViewer(`/${id}/card.png`)).status).toBe(404);
  env.TITLE_CARD = drawn;
  const draft = await createPage(key, 'Draft');
  expect((await callViewer(`/${draft.id}/card.png`)).status).toBe(404);
  expect((await callViewer('/abcd2345/card.png')).status).toBe(404);
  await sql`update pages set status = 'deleted' where id = ${id}`;
  expect((await callViewer(`/${id}/card.png`)).status).toBe(404);
});

it('gives an approval page the card too, on its gate: the gate shows the title to anyone already, and a screenshot is never taken', async () => {
  const { id } = await createPage(await addTester('amy'), 'Private plans');
  expect((await click('publish', id, env, { access: 'approval' })).status).toBe(303);
  await withoutShot(id);
  const gate = await (await callViewer(`/${id}`)).text();
  expect(gate).toContain('Private plans');
  expect(ogImage(gate)).toMatch(new RegExp(`/${id}/card\\.png\\?v=`));
  expect((await callViewer(`/${id}/card.png`)).status).toBe(200);
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(404);
});

// The adapter: the service answers like any HTTP server, and src/preview.ts reads 429 and 503 as "busy".
const options = { url: 'https://view.test/abc12345', viewport: { width: 1200, height: 630 }, gotoOptions: { waitUntil: 'load' as const, timeout: 10_000 }, waitForTimeout: 2500, actionTimeout: 10_000, cacheTTL: 0, screenshotOptions: { type: 'jpeg' as const, quality: 80 } };

it('sends the shot to the service with its secret, and hands back what it answers', async () => {
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  vi.mocked(fetch).mockResolvedValue(new Response(jpegBytes, { headers: { 'Content-Type': 'image/jpeg' } }));
  const bytes = await takeScreenshot(screenshotService('http://screenshot:3000', 's'.repeat(32)), 'https://view.test/abc12345');
  expect([...bytes]).toEqual([...jpegBytes]);
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe('http://screenshot:3000/screenshot');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'s'.repeat(32)}`);
  expect(JSON.parse(String(init?.body))).toMatchObject({ url: 'https://view.test/abc12345', viewport: { width: 1200, height: 630 }, screenshotOptions: { type: 'jpeg', quality: 80 } });
});

it.each([503, 429])('reads the service’s %i as busy, not as a failed shot', async (status) => {
  vi.mocked(fetch).mockResolvedValue(new Response('Busy', { status }));
  await expect(takeScreenshot(screenshotService('http://screenshot:3000', 's'.repeat(32)), 'https://view.test/abc12345')).rejects.toBeInstanceOf(BrowserBusy);
});

it('reads any other refusal as a failed shot', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('The shot failed', { status: 502 }));
  const failure = await takeScreenshot(screenshotService('http://screenshot:3000', 's'.repeat(32)), options.url).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(BrowserBusy);
});

// Config: SCREENSHOT_URL turns the service on, and needs the secret.
const good = { DATABASE_URL: 'postgres://campfile:secret@db:5432/campfile', PREVIEW_SECRET: 'p'.repeat(32), CONSENT_SECRET: 'c'.repeat(32) };

it('has no screenshot service unless SCREENSHOT_URL is set, and then needs its secret', () => {
  expect(readConfig(good).screenshot).toBeUndefined();
  expect(readConfig({ ...good, SCREENSHOT_URL: 'http://screenshot:3000/', SCREENSHOT_SECRET: 's'.repeat(32) }).screenshot).toEqual({ url: 'http://screenshot:3000', secret: 's'.repeat(32) });
  expect(() => readConfig({ ...good, SCREENSHOT_URL: 'http://screenshot:3000' })).toThrow('SCREENSHOT_SECRET is not set.');
  expect(() => readConfig({ ...good, SCREENSHOT_URL: 'http://screenshot:3000', SCREENSHOT_SECRET: 'short' })).toThrow('SCREENSHOT_SECRET must be at least 32 characters.');
  for (const bad of ['screenshot:3000', 'ftp://screenshot', 'http://screenshot:3000/shots', 'http://user@screenshot:3000']) {
    expect(() => readConfig({ ...good, SCREENSHOT_URL: bad, SCREENSHOT_SECRET: 's'.repeat(32) }), bad).toThrow('SCREENSHOT_URL must be an address');
  }
});

// The header that marks the screenshot browser (src/client.ts SCREENSHOT) is the server's own, so only the service's secret keeps it.
async function headersSeen(server: Server, headers: Record<string, string>) {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, string>>();
  request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, agent: false, headers }, (res) => {
    let text = '';
    res.setEncoding('utf8').on('data', (chunk) => (text += chunk)).on('end', () => resolve(JSON.parse(text).headers));
  }).on('error', reject).end();
  return promise;
}

it('keeps Campfile-Screenshot only when it carries the service’s secret', async () => {
  const secret = 's'.repeat(32);
  const server = serve({ origin: env.APP_ORIGIN, trusted: trustedProxies(''), screenshotSecret: secret, handler: (req) => Response.json({ headers: Object.fromEntries(req.headers) }) });
  server.listen(0);
  await once(server, 'listening');
  try {
    expect((await headersSeen(server, { 'Campfile-Screenshot': secret }))['campfile-screenshot']).toBe('1');
    expect((await headersSeen(server, { 'Campfile-Screenshot': '1' }))['campfile-screenshot']).toBeUndefined();
    expect((await headersSeen(server, { 'Campfile-Screenshot': 's'.repeat(31) }))['campfile-screenshot']).toBeUndefined();
    expect((await headersSeen(server, {}))['campfile-screenshot']).toBeUndefined();
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
