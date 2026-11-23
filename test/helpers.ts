import type { ExecutionContext } from 'hono';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';
import { singleOriginHandler } from '../selfhost/routing.ts';
import app from '../src/app.ts';
import type { AppEnv, Browser, Bucket, KeyValueStore, ScreenshotOptions } from '../src/env.ts';
import { createGroup, groupService } from '../src/groups.ts';
import { newKey, sha256Hex, signedId } from '../src/keys.ts';
import { handleMcp } from '../src/mcp.ts';
import { authenticate, pageService } from '../src/pages.ts';
import viewer, { BAR_REPORTER } from '../src/viewer.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set: point it at an empty Postgres, then run "pnpm migrate && pnpm test"');

/** A direct connection, for setting up and checking the database. */
export const sql = postgres(databaseUrl, { max: 2 });

/** In-memory stand-in for the bucket, with each key's upload time. */
export const files = new Map<string, Uint8Array<ArrayBuffer>>();
export const uploaded = new Map<string, Date>();
const bucket: Bucket = {
  async put(key, value) {
    files.set(key, value);
    uploaded.set(key, new Date());
  },
  async get(key) {
    const bytes = files.get(key);
    return bytes ? { body: new Blob([bytes]).stream(), uploaded: uploaded.get(key) } : null;
  },
  async delete(keys) {
    for (const key of [keys].flat()) files.delete(key);
  },
  async list({ prefix }) {
    const keys = [...files.keys()].filter((key) => key.startsWith(prefix));
    return { objects: keys.map((key) => ({ key, uploaded: uploaded.get(key) ?? new Date() })), truncated: false };
  },
};

/** The stored keys under a prefix: `pages/` holds page HTML, `previews/` holds link-preview images. */
export const stored = (prefix: string) => [...files.keys()].filter((key) => key.startsWith(prefix));

/** What the screenshot service answers with on success: a JPEG. The tests only need bytes they can recognise. */
export const SHOT = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01]);
export const jpeg = (bytes: Uint8Array<ArrayBuffer> = SHOT) => new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } });

/** Stands in for the screenshot service binding. `answer` makes each screenshot's response (a good JPEG unless told otherwise); `requests` records what was asked for. */
export function fakeBrowser(answer: (options: ScreenshotOptions) => Response | Promise<Response> = () => jpeg()) {
  const requests: ScreenshotOptions[] = [];
  const browser: Browser = {
    async quickAction(_action, options) {
      requests.push(options);
      return answer(options);
    },
  };
  return { browser, requests };
}

/** In-memory stand-in for the OAUTH_KV key-value store: what the OAuth library uses (get, put with expiry and metadata, delete, list by prefix). */
export const kvEntries = new Map<string, { value: string; expires?: number; metadata?: unknown }>();
const kv: KeyValueStore = {
  async get(key, options) {
    const entry = kvEntries.get(key);
    if (!entry || (entry.expires !== undefined && entry.expires <= Date.now() / 1000)) return null;
    const type = typeof options === 'string' ? options : (options as { type?: string } | undefined)?.type;
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  },
  async put(key, value, options) {
    const expires = options?.expiration ?? (options?.expirationTtl === undefined ? undefined : Date.now() / 1000 + options.expirationTtl);
    kvEntries.set(key, { value, expires, metadata: options?.metadata });
  },
  async delete(key) {
    kvEntries.delete(key);
  },
  async list(options) {
    const names = [...kvEntries.keys()].filter((name) => name.startsWith(options?.prefix ?? '')).sort();
    return { keys: names.map((name) => ({ name, metadata: kvEntries.get(name)?.metadata })), list_complete: true };
  },
};

/** The emails to people (sign-in codes, approvals) sent during the current test. */
export const emails: { from: string; to: string[]; subject: string; text: string }[] = [];
/** The emails to the admin (ADMIN_EMAIL), kept apart so they never count as emails to people. */
export const adminEmails: typeof emails = [];

/** The code in the newest sign-in email to `address`: in its subject, or in its text when the subject names who let them in. */
export function lastCode(address: string): string {
  const email = emails.findLast((sent) => sent.to.includes(address));
  const code = email && (/^(\d{6}) is your Campfile sign-in code$/.exec(email.subject) ?? /Or type this code: (\d{6})/.exec(email.text))?.[1];
  if (!code) throw new Error(`No sign-in email was sent to ${address}`);
  return code;
}

/** Catches every email the code sends. */
let transport: AppEnv['SEND_EMAIL'] = async (to, subject, text) => void (to === 'admin@app.test' ? adminEmails : emails).push({ from: 'Campfile <signin@app.test>', to: [to], subject, text });

/** DATABASE_URL stands in for the connection pool's connection string. */
export const env: AppEnv = {
  DB: { connectionString: databaseUrl },
  PAGES: bucket,
  BROWSER: fakeBrowser().browser,
  APP_ORIGIN: 'https://app.test',
  VIEWER_ORIGIN: 'https://view.test',
  PREVIEW_SECRET: 'test-preview-secret',
  OAUTH_KV: kv,
  CONSENT_SECRET: 'test-consent-secret-at-least-32-characters',
  SEND_EMAIL: transport,
  EMAIL_FROM: 'Campfile <signin@app.test>',
  ADMIN_EMAIL: 'admin@app.test',
  ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
};

/** The `signup` argument of signIn for tests that sign in directly: the admin's email lands in adminEmails like any other. */
export const signup = { env, waitUntil: (work: Promise<unknown>) => void work, via: 'a test' };

/** Empty database, bucket, KV and outbox before every test; no request leaves the test; close the connection after the last test. */
export function useCleanDatabase() {
  beforeEach(async () => {
    await sql`truncate testers, page_ids, pages, page_groups, page_people, credentials, signin_codes, signin_sends, terms_acceptances, page_visits, visit_salts, remembered_emails, share_links, spread_shots restart identity`;
    files.clear();
    uploaded.clear();
    kvEntries.clear();
    emails.length = 0;
    adminEmails.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      // The app's own requests reach the viewer with exactly the headers it sent: no test default for /raw.
      if (env.APP_ORIGIN === env.VIEWER_ORIGIN && url.startsWith(`${env.APP_ORIGIN}/`)) return finish(start(selfhost, url, init, env));
      if (url.startsWith(`${env.VIEWER_ORIGIN}/`)) return finish(start(viewer, url, init, env)); // the app opening a public link
      if (url.startsWith(`${env.APP_ORIGIN}/`)) return callApp(url.slice(env.APP_ORIGIN.length), init); // the viewer asking the app for a spread preview
      throw new Error(`Unexpected fetch in a test: ${url}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => sql.end());
}

/**
 * One request with its own execution context. `response` resolves when the app answers.
 * `settled()` resolves once everything the request handed to waitUntil is done: its database connection is closed and any late link-preview work has finished.
 */
function start(target: { fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Response | Promise<Response> }, url: string, init: RequestInit | undefined, bindings: AppEnv) {
  const background: Promise<unknown>[] = [];
  const ctx: ExecutionContext = { waitUntil: (promise) => void background.push(promise), passThroughOnException() {}, props: {} };
  const request = new Request(url, init);
  const response = Promise.resolve(target.fetch(request, bindings, ctx));
  // Safe to call more than once, and to call early to ask whether the work is still running. Work may hand more work to waitUntil, hence the loop.
  const settled = async () => {
    await response;
    for (let count = -1; count !== background.length; ) {
      count = background.length;
      await Promise.all(background);
    }
  };
  return { response, settled };
}

async function finish(request: ReturnType<typeof start>) {
  const response = await request.response;
  await request.settled();
  return response;
}

const selfhost = {
  fetch(request: Request, bindings: AppEnv, ctx: ExecutionContext) {
    return singleOriginHandler((request, ctx) => app.fetch(request, bindings, ctx), (request, ctx) => viewer.fetch(request, bindings, ctx))(request, ctx);
  },
};

// A browser loads /raw only as a frame page's iframe; tests that mean another load say so with their own Sec-Fetch-Dest.
const asFrame = (path: string, init?: RequestInit): RequestInit | undefined => {
  if (!path.split('?')[0].endsWith('/raw') || new Headers(init?.headers).has('Sec-Fetch-Dest')) return init;
  const headers = new Headers(init?.headers);
  headers.set('Sec-Fetch-Dest', 'iframe');
  return { ...init, headers };
};
/** Shared-origin journeys run the production selector; separate-origin tests keep the app boundary. */
export const startApp = (path: string, init?: RequestInit, bindings = env) => start(bindings.APP_ORIGIN === bindings.VIEWER_ORIGIN ? selfhost : app, `https://app.test${path}`, asFrame(path, init), bindings);
export const callApp = (path: string, init?: RequestInit, bindings = env, origin = 'https://app.test') => finish(start(bindings.APP_ORIGIN === bindings.VIEWER_ORIGIN ? selfhost : app, `${origin}${path}`, asFrame(path, init), bindings));
export const callViewer = (path: string, origin = 'https://view.test', init?: RequestInit) => finish(start(viewer, `${origin}${path}`, asFrame(path, init), env));
/** What /:id/raw serves for a stored page: the page, then the bar's scroll reporter. */
export const served = (html: string) => html + BAR_REPORTER;

/** Creates a tester directly in the database, with one key, and returns the key. */
export async function addTester(name: string): Promise<string> {
  const key = newKey();
  await sql`with t as (insert into testers (name) values (${name}) returning id) insert into credentials (tester, key_hash) select id, ${await sha256Hex(key)} from t`;
  return key;
}

/** The bucket key the page's row currently points at. */
export async function fileOf(id: string): Promise<string> {
  const [row] = await sql<{ file: string }[]>`select file from pages where id = ${id}`;
  return row.file;
}

/** The bucket key of the page's link-preview image, or null while it has none. */
export async function previewOf(id: string): Promise<string | null> {
  const [row] = await sql<{ preview_file: string | null }[]>`select preview_file from pages where id = ${id}`;
  return row.preview_file;
}

/** The response body as JSON. Loosely typed on purpose: tests assert on the shape. */
export const json = (response: Response): Promise<any> => response.json();

const apiInit = (key: string, method: string, body?: unknown): RequestInit => ({
  method,
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** A JSON API call with a bearer key. */
export const api = (key: string, method: string, path: string, body?: unknown, bindings = env) => callApp(path, apiInit(key, method, body), bindings);

/** The same call, not waited for: see `start`. */
export const startApi = (key: string, method: string, path: string, body?: unknown, bindings = env) => startApp(path, apiInit(key, method, body), bindings);

/** One JSON-RPC message to the MCP tools, as the workspace that owns `key`. Over HTTP they sit behind OAuth at /mcp (test/connector.test.ts). */
export function mcp(key: string, message: unknown, bindings = env) {
  const tools = {
    fetch: async (request: Request, env: AppEnv, ctx: ExecutionContext) => {
      const tester = await authenticate(sql, key);
      const waitUntil = (work: Promise<unknown>) => ctx.waitUntil(work);
      return handleMcp(request, pageService(sql, env, tester, waitUntil), groupService(sql, env, tester, waitUntil), () => Promise.reject(new Error('who_am_i needs the connector: test it there')));
    },
  };
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(message) };
  return finish(start(tools, 'https://app.test/mcp', init, bindings));
}

/** Creates a page with the API. It is a draft. Returns the answer: {id, url, published}. */
export const createPage = async (key: string, title = 'A page', html = '<p>hello</p>') => json(await api(key, 'POST', '/api/pages', { title, html }));

/** A form POST from one of the app's own pages, as a browser sends it: their Referrer-Policy: no-referrer makes Origin `null`, and Sec-Fetch-Site says same-origin. */
export const form = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null', 'Sec-Fetch-Site': 'same-origin' };

/** A Cookie header that signs the browser in to a workspace, as the email sign-in does. */
export const sessionCookie = async (tester: number) =>
  `__Host-campfile-session=${await signedId(env.CONSENT_SECRET, 'session', tester, Math.floor(Date.now() / 1000) + 3600)}`;

/** A Cookie header signed in to the workspace that owns the page. */
export async function ownerCookie(id: string): Promise<string> {
  return sessionCookie(await ownerOf(id));
}

const ownerOf = async (id: string) => (await sql<{ owner: number }[]>`select owner from pages where id = ${id}`)[0].owner;

/** A Cookie header that logs the browser in on the viewer as a workspace, as the owner login does. */
export const viewerLogin = async (tester: number) =>
  `__Host-campfile-owner=${await signedId(env.PREVIEW_SECRET, 'owner', tester, Math.floor(Date.now() / 1000) + 3600)}`;

/** A Cookie header logged in on the viewer as the page's owner. */
export const viewerOwner = async (id: string) => viewerLogin(await ownerOf(id));

/**
 * What the Publish and Unpublish buttons on the owner page send: a form POST to the app, signed in as the page's owner (a page that does not exist: not signed in).
 * Publish opens the page to anyone with the link unless `fields` say otherwise. `startClick` is not waited for: see `start`.
 */
export async function startClick(button: 'publish' | 'unpublish', id: string, bindings = env, fields: Record<string, string> = { access: 'link' }) {
  const [page] = await sql`select 1 from pages where id = ${id}`;
  const cookie = page ? await ownerCookie(id) : '';
  return startApp(`/p/${id}/${button}`, { method: 'POST', headers: { ...form, Cookie: cookie }, body: new URLSearchParams(button === 'publish' ? fields : {}) }, bindings);
}
export const click = async (button: 'publish' | 'unpublish', id: string, bindings = env, fields?: Record<string, string>) =>
  finish(await startClick(button, id, bindings, fields));

/** A form POST to the viewer, with an optional Cookie header. */
export const postViewer = (path: string, fields: Record<string, string>, cookie = '') =>
  finish(start(viewer, `https://view.test${path}`, { method: 'POST', headers: { ...form, Cookie: cookie }, body: new URLSearchParams(fields) }, env));

/** A GET of a viewer page with a Cookie header, as a returning visitor's or a logged-in owner's browser sends it. */
export const getViewer = (path: string, cookie: string, origin = 'https://view.test') => finish(start(viewer, `${origin}${path}`, asFrame(path, { headers: { Cookie: cookie } }), env));

/** Creates a page and clicks Publish on it, which takes its link preview with the default fake browser. Returns {id, url, published: true}. */
export async function publishedPage(key: string, title?: string, html?: string) {
  const page = await createPage(key, title, html);
  expect((await click('publish', page.id)).status).toBe(303);
  return { ...page, published: true };
}

/**
 * Pages and groups of `key`'s workspace where the wall's five orders differ (test/mcp.test.ts, test/wall-routes.test.ts). Pages (newest change first) C, A, D, B, E; added D, C, B, A, E.
 * Visitors this week: E 5, A 3, D 2, B 1, and C 9 but a draft, so 0. Let in: B 2 (approval), A 4 but a link page and C 5 but a draft, so 0. Groups "Group 12" {A} (changed last) and "Group 2" {B, C} (made last); D and E in none.
 */
export async function sortSeed(key: string) {
  const owner = (await authenticate(sql, key)).id;
  const [a, b, c, d, e] = [await publishedPage(key, 'round 12'), await createPage(key, 'round 2'), await createPage(key, 'Draft'), await publishedPage(key, 'Zed'), await publishedPage(key, 'Apple')].map((page) => page.id as string);
  expect((await click('publish', b, env, { access: 'approval' })).status).toBe(303);
  const [g12, g2] = [(await createGroup(sql, owner, 'Group 12', [a])).id, (await createGroup(sql, owner, 'Group 2', [b, c])).id];
  for (const [id, days, hours, visitors, approved] of [[a, 4, 2, 3, 4], [b, 3, 4, 1, 2], [c, 2, 1, 9, 5], [d, 1, 3, 2, 0], [e, 5, 5, 5, 0]] as const) {
    await sql`update pages set created_at = now() - make_interval(days => ${days}), updated_at = now() - make_interval(hours => ${hours}) where id = ${id}`;
    await sql`insert into page_visits (page, day, visitor) select ${id}::text, current_date, sha256(convert_to(${id}::text || n::text, 'UTF8')) from generate_series(1, ${visitors}::int) n`;
    await sql`insert into page_people (page, email, status) select ${id}::text, 'p' || n || '@example.com', 'approved' from generate_series(1, ${approved}::int) n`;
  }
  await sql`update page_groups set created_at = now() - interval '5 days', updated_at = now() where id = ${g12}`;
  await sql`update page_groups set created_at = now() - interval '4 days', updated_at = now() - interval '10 days' where id = ${g2}`;
  return { a, b, c, d, e, g12, g2 };
}
