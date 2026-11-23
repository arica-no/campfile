// What selfhost/server.ts is built from, apart from the stores (test/selfhost-storage.test.ts) and the client address (test/selfhost-ip.test.ts): the cron timer, the settings check and the static files.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { staticFiles } from '../selfhost/assets.ts';
import { readConfig } from '../selfhost/config.ts';
import { CRONS, due } from '../selfhost/cron.ts';
import { newContext } from '../selfhost/http.ts';
import { singleOriginHandler } from '../selfhost/routing.ts';

const at = (time: string) => new Date(`2026-03-04T${time}Z`); // a Wednesday

it('knows the minutes a cron fires in, and can read every cron it runs', () => {
  expect(due('17 3 * * *', at('03:17:30'))).toBe(true);
  expect(due('17 3 * * *', at('03:18:00'))).toBe(false);
  expect(due('17 3 * * *', at('04:17:00'))).toBe(false);
  expect(due('*/10 * * * *', at('11:50:00'))).toBe(true);
  expect(due('*/10 * * * *', at('11:55:00'))).toBe(false);
  expect(due('5-59/10 * * * *', at('11:15:00'))).toBe(true);
  expect(due('5-59/10 * * * *', at('11:10:00'))).toBe(false);
  expect(due('0,30 9-17 * * 1-5', at('12:30:00'))).toBe(true);
  expect(due('0,30 9-17 * * 1-5', at('12:15:00'))).toBe(false);
  expect(due('0,30 9-17 * * 0,6', at('12:30:00'))).toBe(false); // not on a weekday
  expect(due('0 0 4 3 *', at('00:00:00'))).toBe(true);
  expect(due('0 0 5 3 *', at('00:00:00'))).toBe(false);
  for (const cron of CRONS) expect(() => due(cron, at('00:00:00')), cron).not.toThrow();
});

it('refuses a cron it cannot read, so a job never silently stops', () => {
  for (const bad of ['abc', '60 * * * *', '0 0 * * 7', '*abc', '* * * *', '* * * * * *', '*/0 * * * *', '5-2 * * * *', 'MON * * * *']) expect(() => due(bad, at('00:00:00')), bad).toThrow();
});

const good = {
  DATABASE_URL: 'postgres://campfile:secret@db:5432/campfile',
  APP_ORIGIN: 'https://campfile.example.com',
  VIEWER_ORIGIN: 'https://campfile-pages.example.net',
  PREVIEW_SECRET: 'p'.repeat(32),
  CONSENT_SECRET: 'c'.repeat(32),
  EMAIL_FROM: 'Campfile <signin@example.com>',
  ADMIN_EMAIL: 'me@example.com',
  SMTP_HOST: 'smtp.example.com',
};
const problems = (vars: Record<string, string | undefined>) => {
  try {
    readConfig({ ...good, ...vars });
  } catch (error) {
    return (error as Error).message;
  }
  return '';
};

it('lists every missing internal setting at once', () => {
  const message = problems({ DATABASE_URL: '', PREVIEW_SECRET: undefined, CONSENT_SECRET: undefined });
  for (const name of ['DATABASE_URL', 'PREVIEW_SECRET', 'CONSENT_SECRET']) expect(message, name).toContain(`${name} is not set.`);
});

it('defaults to one localhost address and local email identities, with explicit settings taking precedence', () => {
  const local = readConfig({ DATABASE_URL: good.DATABASE_URL, PREVIEW_SECRET: good.PREVIEW_SECRET, CONSENT_SECRET: good.CONSENT_SECRET });
  expect(local.appOrigin).toBe('http://localhost:8787');
  expect(local.viewerOrigin).toBe('http://localhost:8787');
  expect(local.emailFrom).toBe('Campfile <signin@localhost>');
  expect(local.adminEmail).toBe('admin@localhost');
  expect(local.warnings).toContain('SMTP_HOST is not set: every email, sign-in codes included, is printed in this log instead of sent.');
  for (const viewer of [undefined, '', good.APP_ORIGIN, `${good.APP_ORIGIN}/`]) {
    const configured = readConfig({ ...good, VIEWER_ORIGIN: viewer, APP_PORT: '9000', VIEWER_PORT: '9000' });
    expect(configured.appOrigin).toBe(good.APP_ORIGIN);
    expect(configured.viewerOrigin).toBe(good.APP_ORIGIN);
    expect(configured.emailFrom).toBe(good.EMAIL_FROM);
    expect(configured.adminEmail).toBe(good.ADMIN_EMAIL);
    expect(configured.warnings).toEqual([]);
  }
  expect(readConfig({ ...good, APP_ORIGIN: '', VIEWER_ORIGIN: '' }).appOrigin).toBe('http://localhost:8787');
});

it('refuses settings that would break the install or its isolation', () => {
  expect(problems({ DATABASE_URL: 'mysql://db/x' })).toContain('DATABASE_URL must be a postgres:// connection string');
  expect(problems({ PREVIEW_SECRET: 'short' })).toContain('PREVIEW_SECRET must be at least 32 characters');
  expect(problems({ ADMIN_EMAIL: 'me' })).toContain('ADMIN_EMAIL must be an email address');
  expect(problems({ APP_ORIGIN: 'https://example.com/app' })).toContain('APP_ORIGIN must be an address like');
  expect(problems({ APP_ORIGIN: 'campfile.example.com' })).toContain('APP_ORIGIN must be an address like');
  expect(problems({ TRUSTED_PROXIES: '10.0.0.0/33' })).toContain('TRUSTED_PROXIES');
  expect(problems({ APP_PORT: '9000', VIEWER_PORT: '9000' })).toContain('must differ');
  expect(problems({ APP_PORT: 'http' })).toContain('APP_PORT must be a port number');
  // Different origins retain the advanced mode's separate-site restrictions.
  expect(problems({ VIEWER_ORIGIN: 'https://campfile.example.com:8443' })).toContain('different sites');
  expect(problems({ VIEWER_ORIGIN: 'https://pages.campfile.example.com' })).toContain('different sites');
  expect(problems({ APP_ORIGIN: 'https://campfile.example.com', VIEWER_ORIGIN: 'https://pages.example.com' })).toBe(''); // only a warning, below
  // The login cookies are Secure: over http a browser drops them, so only a trial on this machine may use it.
  expect(problems({ APP_ORIGIN: 'http://campfile.example.com' })).toContain('APP_ORIGIN must be https:// unless it is localhost');
  expect(problems({ VIEWER_ORIGIN: 'http://pages.example.net:8788' })).toContain('VIEWER_ORIGIN must be https:// unless it is localhost');
  for (const [app, viewer] of [['http://localhost:8787', 'http://127.0.0.1:8788'], ['http://[::1]:8787', 'http://localhost:8788']]) expect(problems({ APP_ORIGIN: app, VIEWER_ORIGIN: viewer })).toBe('');
});

it('rejects incomplete SMTP credentials and ports, and preserves password whitespace', () => {
  expect(problems({ SMTP_HOST: undefined, SMTP_PORT: '587' })).toContain('SMTP_HOST');
  expect(problems({ SMTP_HOST: undefined, SMTP_USER: 'sender', SMTP_PASSWORD: 'secret' })).toContain('SMTP_HOST');
  expect(problems({ SMTP_USER: 'sender' })).toContain('SMTP_USER and SMTP_PASSWORD');
  expect(problems({ SMTP_PASSWORD: 'secret' })).toContain('SMTP_USER and SMTP_PASSWORD');
  for (const value of ['0', '65536', '1.5', 'smtp']) expect(problems({ SMTP_PORT: value }), value).toContain('SMTP_PORT');
  const configured = readConfig({ ...good, SMTP_USER: 'sender', SMTP_PASSWORD: ' secret $ value ' });
  expect(configured.smtp?.auth).toEqual({ user: 'sender', pass: ' secret $ value ' });
  expect(readConfig(good).smtp?.auth).toBeUndefined();
});

it('turns single-user mode on only without SMTP, keeping the password as typed', () => {
  const owner = { OWNER_EMAIL: ' Me@Example.com ', OWNER_PASSWORD: ' long $ password ' };
  expect(readConfig({ ...good, ...owner, SMTP_HOST: undefined }).ownerLogin).toEqual({ email: 'me@example.com', password: ' long $ password ' });
  const withSmtp = readConfig({ ...good, ...owner });
  expect(withSmtp.ownerLogin).toBeUndefined();
  expect(withSmtp.warnings).toContain('OWNER_PASSWORD is ignored: SMTP is set, so everyone signs in with an emailed code.');
  expect(problems({ OWNER_EMAIL: 'me@example.com' })).toContain('OWNER_EMAIL and OWNER_PASSWORD must be set together.');
  expect(problems({ ...owner, OWNER_PASSWORD: 'short' })).toContain('OWNER_PASSWORD must be at least 12 characters.');
});

it('warns about what works but is probably not meant', () => {
  const shared = readConfig({ ...good, APP_ORIGIN: 'https://a.example.com', VIEWER_ORIGIN: 'https://b.example.com' }).warnings;
  expect(shared).toHaveLength(1);
  expect(shared[0]).toContain('both end in example.com');
  expect(shared[0]).toContain('public suffix');
  // Two names under one ending start with a warning, not a refusal: only the reader can tell whether that ending is a public suffix (duckdns.org is, cloudapp.azure.com and sslip.io are not).
  const suffix = readConfig({ ...good, APP_ORIGIN: 'https://campfile.duckdns.org', VIEWER_ORIGIN: 'https://pages.duckdns.org' }).warnings;
  expect(suffix).toHaveLength(1);
  expect(suffix[0]).toContain('both end in duckdns.org');
  const azure = readConfig({ ...good, APP_ORIGIN: 'https://campfile.westeurope.cloudapp.azure.com', VIEWER_ORIGIN: 'https://pages.westeurope.cloudapp.azure.com' }).warnings;
  expect(azure).toHaveLength(1);
  expect(azure[0]).toContain('both end in westeurope.cloudapp.azure.com');
  expect(readConfig({ ...good, APP_ORIGIN: 'https://1-2-3-4.sslip.io', VIEWER_ORIGIN: 'https://1-2-3-4.nip.io' }).warnings).toEqual([]); // two services, two sites
});

it('serves the viewer bar and spread assets and the owner script at one address, without serving HTML fragments as uploads', async () => {
  const appFiles = staticFiles(fileURLToPath(new URL('../public', import.meta.url)));
  const viewerFiles = staticFiles(fileURLToPath(new URL('../viewer/public', import.meta.url)));
  const handler = singleOriginHandler(
    async (request) => (await appFiles.exact(request)) ?? new Response('Not found', { status: 404 }),
    async (request) => (await viewerFiles.exact(request)) ?? new Response('Not found', { status: 404 }),
  );
  for (const [path, type] of [
    ['/bar.js', 'text/javascript'],
    ['/spread/shell.css', 'text/css'],
    ['/spread/cascade.js', 'text/javascript'],
    ['/manage.js', 'text/javascript'],
  ]) {
    const response = await handler(get(path), newContext());
    expect(response.status, path).toBe(200);
    expect(response.headers.get('content-type'), path).toContain(type);
  }
  expect((await handler(get('/bar.js', { method: 'HEAD' }), newContext())).status).toBe(200);
  for (const path of ['/spread/../docs.html', '/docs.html', '/bar.jsx', '/spread/missing.css']) expect((await handler(get(path), newContext())).status, path).toBe(404);
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'campfile-static-'));
  await mkdir(join(dir, 'sub'));
  await mkdir(join(dir, '.well-known'));
  await writeFile(join(dir, 'docs.html'), '<p>docs</p>');
  await writeFile(join(dir, 'app.js'), 'let x');
  await writeFile(join(dir, 'sub/index.html'), '<p>sub</p>');
  await writeFile(join(dir, '.hidden'), 'secret');
  await writeFile(join(dir, '.well-known/security.txt'), 'Contact: me');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const get = (path: string, init?: RequestInit) => new Request(`https://app.test${path}`, init);

it('serves public/ as the hosted site does: files by name, .html pages without the extension, folders by their index', async () => {
  const { assets } = staticFiles(dir);
  for (const [path, body, type] of [
    ['/docs', '<p>docs</p>', 'text/html; charset=utf-8'],
    ['/docs.html', '<p>docs</p>', 'text/html; charset=utf-8'],
    ['/app.js', 'let x', 'text/javascript; charset=utf-8'],
    ['/sub', '<p>sub</p>', 'text/html; charset=utf-8'],
    ['/sub/', '<p>sub</p>', 'text/html; charset=utf-8'],
    ['/.well-known/security.txt', 'Contact: me', 'text/plain; charset=utf-8'],
  ]) {
    const response = await assets.fetch(get(path));
    expect([path, response.status, response.headers.get('Content-Type'), await response.text()]).toEqual([path, 200, type, body]);
  }
  for (const path of ['/', '/nope', '/.hidden', '/%2e%2e/etc/passwd', '/sub/../../x', '/%00', '/%zz', '/app.js/', '/docs.html/x']) expect((await assets.fetch(get(path))).status, path).toBe(404);
  expect((await assets.fetch(get('/docs', { method: 'POST' }))).status).toBe(404);
});

it('lets a file answer before the app only when it is a file by its own name, never an .html fragment', async () => {
  const { exact } = staticFiles(dir);
  expect((await exact(get('/app.js')))?.status).toBe(200);
  expect((await exact(get('/.well-known/security.txt')))?.status).toBe(200);
  for (const path of ['/docs', '/docs.html', '/sub', '/sub/index.html', '/', '/.hidden', '/nope', '/%2e%2e/x']) expect(await exact(get(path)), path).toBeUndefined();
  expect(await exact(get('/app.js', { method: 'POST' }))).toBeUndefined();
});

it('gives each file an ETag, answers a matching If-None-Match with 304 and a HEAD without a body', async () => {
  const { assets } = staticFiles(dir);
  const first = await assets.fetch(get('/app.js'));
  const etag = first.headers.get('ETag')!;
  expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
  expect(first.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  const again = await assets.fetch(get('/app.js', { headers: { 'If-None-Match': `"nope", W/${etag}` } }));
  expect([again.status, await again.text()]).toEqual([304, '']);
  const head = await assets.fetch(get('/app.js', { method: 'HEAD' }));
  expect([head.status, head.headers.get('Content-Type'), await head.text()]).toEqual([200, 'text/javascript; charset=utf-8', '']);
});
