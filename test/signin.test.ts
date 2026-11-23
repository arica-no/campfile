import { expect, it, vi } from 'vitest';
import { HAS_TERMS } from '../src/hosted.ts';
import { sha256Hex } from '../src/keys.ts';
import { CODE_MINUTES, CODES_PER_EMAIL_PER_HOUR, CODES_PER_IP_PER_DAY, EMAILS_PER_DAY, MAX_TRIES, purgeExpired, TERMS_VERSION } from '../src/signin.ts';
import { adminEmails, api, callApp, createPage, emails, env, json, lastCode, sql, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

const post = (path: string, body: unknown, ip = '203.0.113.1', bindings = env) =>
  callApp(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Campfile-Client-IP': ip }, body: JSON.stringify(body) }, bindings);
const askCode = (email: string, ip?: string) => post('/api/signin', { email }, ip);
const verify = (email: string, code: string) => post('/api/signin/verify', { email, code });

/** Signs in from the CLI and returns the new key. */
async function signIn(email: string): Promise<string> {
  expect((await askCode(email)).status).toBe(200);
  const response = await verify(email, lastCode(email));
  expect(response.status).toBe(200);
  return (await json(response)).key;
}

it('signs in from the CLI: the first code makes the workspace, a second machine gets its own key, and both keys work', async () => {
  const asked = await askCode('  Amy@Example.COM ');
  expect(asked.status).toBe(200);
  expect(await json(asked)).toMatchObject({ sent: true });
  expect(emails).toHaveLength(1);
  expect(emails[0]).toMatchObject({ from: env.EMAIL_FROM, to: ['amy@example.com'] });
  const code = lastCode('amy@example.com');
  expect(emails[0].subject).toContain(code);

  const first = await verify('amy@example.com', code);
  expect(first.status).toBe(200);
  const { email, key: laptop } = await json(first);
  expect(email).toBe('amy@example.com');
  const { id } = await createPage(laptop);

  const desktop = await signIn('amy@example.com');
  expect(desktop).not.toBe(laptop);
  for (const key of [laptop, desktop]) {
    expect((await json(await api(key, 'GET', '/api/pages'))).pages.map((page: { id: string }) => page.id)).toEqual([id]);
  }
  expect(await sql`select email from testers`).toEqual([{ email: 'amy@example.com' }]);
  // Only hashes are stored.
  const stored = (await sql<{ key_hash: string }[]>`select key_hash from credentials order by id`).map((row) => row.key_hash);
  expect(stored).toEqual([await sha256Hex(laptop), await sha256Hex(desktop)]);
});

it('emails the admin about a new workspace once, naming the door, and never about a new page', async () => {
  const key = await signIn('amy@example.com');
  await signIn('amy@example.com');
  await createPage(key, 'Trip plan');
  expect(adminEmails).toEqual([
    { from: env.EMAIL_FROM, to: [env.ADMIN_EMAIL], subject: 'New sign-up: amy@example.com', text: 'amy@example.com signed up on Campfile, through the CLI sign-in (an AI that runs commands).' },
  ]);
});

it('where there are terms, records which version each workspace accepted, once per version, and the code email says using it accepts them; nothing where there are none', async () => {
  await signIn('amy@example.com');
  expect(emails[0].text.includes(`accept the Campfile Terms (${env.APP_ORIGIN}/terms) and Privacy Policy (${env.APP_ORIGIN}/privacy)`)).toBe(HAS_TERMS);
  await signIn('amy@example.com');
  expect(await sql`select email, version from terms_acceptances`).toEqual(HAS_TERMS ? [{ email: 'amy@example.com', version: TERMS_VERSION }] : []);
  if (!HAS_TERMS) return;

  // An account that accepted an older version accepts the current one at its next sign-in, and the old record stays.
  await sql`update terms_acceptances set version = '2000-01-01'`;
  await signIn('amy@example.com');
  expect((await sql`select version from terms_acceptances order by accepted_at`).map((row) => row.version)).toEqual(['2000-01-01', TERMS_VERSION]);

  // A code emailed before the terms existed named none, so using it records nothing.
  await sql`truncate terms_acceptances`;
  await askCode('amy@example.com');
  await sql`update signin_codes set terms_version = null`;
  expect((await verify('amy@example.com', lastCode('amy@example.com'))).status).toBe(200);
  expect(await sql`select 1 from terms_acceptances`).toHaveLength(0);
});

it('the daily purge drops expired codes and send records older than a day, and keeps the rest', async () => {
  await askCode('old@example.com');
  await askCode('new@example.com');
  await sql`update signin_codes set expires_at = now() - interval '1 second' where email = 'old@example.com'`;
  await sql`update signin_sends set sent_at = now() - interval '25 hours' where email = 'old@example.com'`;

  await purgeExpired(sql);

  expect(await sql`select email from signin_codes`).toEqual([{ email: 'new@example.com' }]);
  expect(await sql`select email from signin_sends where email like '%old%'`).toEqual([]);
});

it('answers the bare key for Accept: text/plain, so curl can save it without printing it; errors stay JSON', async () => {
  await askCode('amy@example.com');
  const plain = (code: string) =>
    callApp('/api/signin/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/plain' }, body: JSON.stringify({ email: 'amy@example.com', code }) });
  const code = lastCode('amy@example.com');
  const wrong = await plain(code === '000000' ? '111111' : '000000');
  expect(wrong.status).toBe(400);
  expect(await json(wrong)).toEqual({ error: expect.any(String) });

  const response = await plain(code);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  const key = await response.text();
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect((await api(key, 'GET', '/api/pages')).status).toBe(200);
});

it('keeps workspaces apart', async () => {
  const amy = await signIn('amy@example.com');
  const bob = await signIn('bob@example.com');
  await createPage(amy);
  expect((await json(await api(bob, 'GET', '/api/pages'))).pages).toEqual([]);
});

it('answers the same whether or not the email has a workspace yet', async () => {
  await signIn('amy@example.com');
  const known = await askCode('amy@example.com');
  const unknown = await askCode('new@example.com');
  expect([known.status, unknown.status]).toEqual([200, 200]);
  expect(Object.keys(await json(known))).toEqual(Object.keys(await json(unknown)));
  expect(await sql`select email from testers`).toHaveLength(1); // asking for a code makes nothing
});

it(`lets a code work once, for ${CODE_MINUTES} minutes, and ends it after ${MAX_TRIES} wrong tries`, async () => {
  await askCode('amy@example.com');
  let code = lastCode('amy@example.com');
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < MAX_TRIES; i++) expect((await verify('amy@example.com', wrong)).status).toBe(400);
  expect((await verify('amy@example.com', code)).status).toBe(400);

  await askCode('amy@example.com');
  code = lastCode('amy@example.com');
  await sql`update signin_codes set expires_at = now() - interval '1 second'`;
  expect((await verify('amy@example.com', code)).status).toBe(400);

  await askCode('amy@example.com');
  const replaced = lastCode('amy@example.com');
  await askCode('amy@example.com');
  code = lastCode('amy@example.com');
  if (replaced !== code) expect((await verify('amy@example.com', replaced)).status).toBe(400);
  expect((await verify('amy@example.com', code)).status).toBe(200);
  expect((await verify('amy@example.com', code)).status).toBe(400);
  expect((await verify('bob@example.com', code)).status).toBe(400); // a code belongs to its email
});

it(`counts guesses sent at the same time: ${MAX_TRIES * 4} at once still get ${MAX_TRIES} tries`, async () => {
  await askCode('amy@example.com');
  const code = lastCode('amy@example.com');
  const wrong = code === '000000' ? '111111' : '000000';
  await Promise.all(Array.from({ length: MAX_TRIES * 4 }, () => verify('amy@example.com', wrong)));
  expect(await sql`select attempts from signin_codes`).toEqual([{ attempts: MAX_TRIES }]);
  expect((await verify('amy@example.com', code)).status).toBe(400);
});

it('accepts the code with spaces or a trailing dot, and explains bad input', async () => {
  await askCode('amy@example.com');
  const code = lastCode('amy@example.com');
  expect((await verify('amy@example.com', `${code.slice(0, 3)} ${code.slice(3)}.`)).status).toBe(200);

  for (const body of [{}, { email: 'not an email' }, { email: 42 }]) {
    const response = await post('/api/signin', body);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(await json(response)).toEqual({ error: expect.any(String) });
  }
  expect((await verify('amy@example.com', 'abc')).status).toBe(400);
  expect(emails).toHaveLength(1);
});

it(`sends at most ${CODES_PER_EMAIL_PER_HOUR} codes per email per hour and ${CODES_PER_IP_PER_DAY} per network per day`, async () => {
  for (let i = 0; i < CODES_PER_EMAIL_PER_HOUR; i++) expect((await askCode('amy@example.com', '203.0.113.1')).status).toBe(200);
  expect((await askCode('amy@example.com', '203.0.113.2')).status).toBe(429);
  await sql`update signin_sends set sent_at = now() - interval '61 minutes'`;
  expect((await askCode('amy@example.com', '203.0.113.2')).status).toBe(200);

  for (let i = 0; i < CODES_PER_IP_PER_DAY; i++) expect((await askCode(`user${i}@example.com`, '198.51.100.7')).status).toBe(200);
  expect((await askCode('one-more@example.com', '198.51.100.7')).status).toBe(429);
  expect((await askCode('one-more@example.com', '198.51.100.8')).status).toBe(200);
  expect(emails).toHaveLength(CODES_PER_EMAIL_PER_HOUR + 1 + CODES_PER_IP_PER_DAY + 1);
});

it('counts an IPv6 network by its /64, however its addresses are written', async () => {
  for (let i = 0; i < CODES_PER_IP_PER_DAY; i++) expect((await askCode(`user${i}@example.com`, `2001:db8:0:1::${(i + 1).toString(16)}`)).status).toBe(200);
  expect((await askCode('one-more@example.com', '2001:DB8:0000:0001:ffff:1:2:3')).status).toBe(429);
  expect((await askCode('one-more@example.com', '2001:db8:0:2::1')).status).toBe(200); // the next /64
});

it(`sends at most ${EMAILS_PER_DAY} emails a day in all`, async () => {
  await sql`insert into signin_sends (email, ip) select 'someone' || i || '@example.com', 'ip' || i from generate_series(1, ${EMAILS_PER_DAY - 1}) i`;
  expect((await askCode('amy@example.com', '203.0.113.1')).status).toBe(200);
  const refused = await askCode('bob@example.com', '203.0.113.2');
  expect(refused.status).toBe(429);
  expect((await json(refused)).error).toMatch(/all the emails it can today/);
});

it('does not sign in to a disabled workspace', async () => {
  const key = await signIn('amy@example.com');
  await sql`update testers set disabled_at = now()`;
  await askCode('amy@example.com');
  expect((await verify('amy@example.com', lastCode('amy@example.com'))).status).toBe(403);
  expect((await api(key, 'GET', '/api/pages')).status).toBe(401);
});

it('logs the code in local dev without an email transport, and refuses to run without one anywhere else', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const none = {
    ...env,
    SEND_EMAIL: undefined,
  };
  const local = { ...none, APP_ORIGIN: 'http://localhost:8787' };
  expect((await post('/api/signin', { email: 'amy@example.com' }, undefined, local)).status).toBe(200);
  const code = /code is (\d{6})/.exec(String(log.mock.calls[0]?.[0]))?.[1];
  expect((await verify('amy@example.com', code!)).status).toBe(200);
  expect(emails).toHaveLength(0);

  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await post('/api/signin', { email: 'amy@example.com' }, undefined, none)).status).toBe(500);
  expect(error).toHaveBeenCalled();
});

it('in single-user mode takes the owner password, as typed, in place of the code, for the owner email only, within the tries', async () => {
  const single = { ...env, OWNER_LOGIN: { email: 'amy@example.com', password: ' correct horse 42 ' } };
  const verifyAs = (email: string, code: string) => post('/api/signin/verify', { email, code }, undefined, single);
  expect((await post('/api/signin', { email: 'amy@example.com' }, undefined, single)).status).toBe(200);
  expect((await verifyAs('amy@example.com', 'correcthorse42')).status).toBe(400);
  const signedIn = await verifyAs('amy@example.com', ' correct horse 42 ');
  expect(signedIn.status).toBe(200);
  expect((await json(signedIn)).email).toBe('amy@example.com');
  // The password is used up with the code it stands in for, and wrong ones use up the tries.
  expect((await verifyAs('amy@example.com', ' correct horse 42 ')).status).toBe(400);
  expect((await post('/api/signin', { email: 'amy@example.com' }, undefined, single)).status).toBe(200);
  for (let i = 0; i < MAX_TRIES; i++) await verifyAs('amy@example.com', 'wrong password');
  expect((await verifyAs('amy@example.com', ' correct horse 42 ')).status).toBe(400);
  // Another email, or the same server without single-user mode, needs the code.
  expect((await post('/api/signin', { email: 'bob@example.com' }, undefined, single)).status).toBe(200);
  expect((await json(await verifyAs('bob@example.com', ' correct horse 42 '))).error).toBe('The code is the 6 digits from the email.');
  expect((await askCode('amy@example.com')).status).toBe(200);
  expect((await verify('amy@example.com', ' correct horse 42 ')).status).toBe(400);
});

it("tells the AI where the user finds what to type: the inbox, the server log, or the owner's password", async () => {
  const message = async (email: string, extra: object) => (await json(await post('/api/signin', { email }, undefined, { ...env, ...extra }))).message as string;
  expect(await message('amy@example.com', {})).toContain('spam');
  const inLog = { EMAIL_IN_LOG: true, OWNER_LOGIN: { email: 'amy@example.com', password: 'correct horse 42' } };
  const owner = await message('Amy@example.com', inLog);
  expect(owner).toContain('OWNER_PASSWORD');
  expect(owner).not.toContain('spam');
  const other = await message('bob@example.com', inLog);
  expect(other).toContain('docker compose logs campfile');
  expect(other).not.toContain('spam');
});

it('does not report a sent code or send it another way when the configured transport fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const failed = { ...env, SEND_EMAIL: async () => { throw new Error('SMTP refused delivery'); } };
  expect((await post('/api/signin', { email: 'amy@example.com' }, undefined, failed)).status).toBe(500);
  expect(emails).toHaveLength(0);
});

