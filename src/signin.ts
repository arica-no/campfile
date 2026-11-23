import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Sql, WaitUntil } from './db.ts';
import type { AppEnv, ViewerEnv } from './env.ts';
import { HAS_TERMS } from './hosted.ts';
import { newKey, readSignedId, sha256Hex, signedId } from './keys.ts';
import { CampfileError, parse } from './pages.ts';

export const CODE_MINUTES = 5;
/** How long a login link works. It works again until then, so a mail scanner opening it first does not use it up. */
export const LINK_MINUTES = 15;
export const MAX_TRIES = 5;
export const CODES_PER_EMAIL_PER_HOUR = 5;
export const CODES_PER_IP_PER_DAY = 20;
// Every email Campfile sends on request, all senders together.
export const EMAILS_PER_DAY = 1500;
/** The "Last updated" date of public/terms.html. Bump both together: the next sign-in of each workspace records acceptance of the new version (table terms_acceptances). */
export const TERMS_VERSION = '2026-10-23';
/** Shown next to every button that uses a sign-in code: using it accepts the terms (checkCode records that). Nothing where there are no terms (HAS_TERMS in src/hosted.ts). */
export const TERMS_NOTICE = HAS_TERMS ? '<p class="muted">By continuing you accept the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>' : '';
/** An email's last paragraph: doing `act` ("using this code", "opening it") accepts the terms. Nothing where there are none. */
export const termsLine = (appOrigin: string, act: string) => (HAS_TERMS ? `\n\nBy ${act} you accept the Campfile Terms (${appOrigin}/terms) and Privacy Policy (${appOrigin}/privacy).` : '');
// A login link's token is a signature, not a stored row: `0.<expires>.<mac>` under `link:<email>:<terms version>:<nonce>`, id 0 since a first login has no workspace yet.
// The nonce is also the cookie of the browser that asked (src/manage.ts): only there does the link log in without a confirm click.
const linkScope = (address: string, version: string, nonce: string) => `link:${address}:${version}:${nonce}`;
/** The browser login's link for this email and login attempt, valid LINK_MINUTES: it signs this email in on the app, then goes to `next`. */
export async function loginLink(env: Pick<AppEnv, 'APP_ORIGIN' | 'CONSENT_SECRET'>, address: string, next: string, nonce: string): Promise<string> {
  const t = await signedId(env.CONSENT_SECRET, linkScope(address, TERMS_VERSION, nonce), 0, Math.floor(Date.now() / 1000) + LINK_MINUTES * 60);
  return `${env.APP_ORIGIN}/signin/link?${new URLSearchParams({ email: address, v: TERMS_VERSION, n: nonce, t, next })}`;
}
/** True for an unexpired (at `at`; 0: ever signed), untouched login link's email, terms version, nonce and token. */
export const validLink = async (secret: string, address: string, version: string, nonce: string, token: string | undefined, at?: number) =>
  (await readSignedId(secret, linkScope(address, version, nonce), token, at)) !== undefined;

const WRONG_CODE = `That code is wrong or has expired. A code works for ${CODE_MINUTES} minutes and allows ${MAX_TRIES} tries. Ask for a new code and use the one in the newest email.`;

export const email = z
  .string('The email must be text.')
  .trim()
  .toLowerCase()
  .max(254, 'That email address is too long.')
  .pipe(z.email('That does not look like an email address. Check it and try again.'));
// The format is checked in checkCode, which knows whether this email may type a password instead (single-user mode).
const code = z.string('The code must be text.').max(200, 'That code is too long.');

export const signinInput = z.object({ email }, 'Send a JSON object with an "email" field.');
export const verifyInput = z.object({ email, code }, 'Send a JSON object with an "email" and a "code" field.');

type EmailEnv = Pick<
  ViewerEnv,
  | 'APP_ORIGIN' | 'SEND_EMAIL' | 'EMAIL_FROM' | 'OWNER_LOGIN'
>;
type CodeEnv = EmailEnv &
  Pick<
    AppEnv,
    | 'APP_ORIGIN'
  >;
type AdminEnv = EmailEnv & Pick<ViewerEnv, 'ADMIN_EMAIL'>;

/** Emails the admin after the response (docs/SPEC.md "Admin emails"). A failure is logged, never shown to the person who caused it. */
export function tellAdmin(env: AdminEnv, waitUntil: WaitUntil, subject: string, text: string): void {
  // shortcut: one email per sign-up, uncapped and outside EMAILS_PER_DAY; fine at beta volume, make it a daily digest if it gets noisy.
  waitUntil(sendEmail(env, env.ADMIN_EMAIL, subject, text).catch((error) => console.error('Could not email the admin', error)));
}

/** Where a sign-in happens, so the admin's email about a new workspace says which door it came through. */
export type Signup = { env: AdminEnv; waitUntil: WaitUntil; via: string };

/**
 * Emails a fresh 6-digit code, which replaces any earlier one. Says nothing about whether the email has a workspace yet: the first correct code creates it.
 * With `link` (the browser login, src/manage.ts loginLink), the email also has a link that logs in with one click.
 * `letIn` is an owner's Approve (src/access.ts): its own subject, which leaves the owner-chosen title out, and a first line saying who let them in.
 */
export async function sendCode(sql: Sql, env: CodeEnv, address: string, ip: string, link?: string, letIn?: { subject: string; intro: string }): Promise<void> {
  await checkSendLimits(sql, address, ip);
  let value = randomInt(1_000_000).toString().padStart(6, '0');
  await sql`
    insert into signin_codes (email, code_hash, expires_at, terms_version) values (${address}, ${await sha256Hex(value)}, now() + ${`${CODE_MINUTES} minutes`}::interval, ${TERMS_VERSION})
    on conflict (email) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, terms_version = excluded.terms_version`;
  await sendEmail(
    env,
    address,
    letIn?.subject ?? `${value} is your Campfile sign-in code`,
    `${letIn ? `${letIn.intro}\n\n` : ''}${
      link === undefined
        ? `Your Campfile sign-in code is ${value}

It works for ${CODE_MINUTES} minutes. Type it on the Campfile sign-in page, or give it to the AI you just asked to sign you in. Never give it to anyone else.`
        : `Log in to Campfile with this link:
${link}

Or type this code: ${value}

The link works for ${LINK_MINUTES} minutes, the code for ${CODE_MINUTES}. Never give them to anyone else.`
    }

If you did not ask to sign in, ignore this email.${termsLine(env.APP_ORIGIN, `using this ${link === undefined ? 'code' : 'link or code'}`)}`,
  );
}

/** The sender a limit counts: an IPv6 address by its /64, since one connection usually gets a whole /64; anything else as given (IPv4, `owner:<id>`). */
export function senderKey(ip: string): string {
  if (!ip.includes(':') || !/^[0-9a-f:]+$/i.test(ip)) return ip;
  const [head = '', tail] = ip.split('::');
  const left = head.split(':').filter(Boolean);
  const right = tail?.split(':').filter(Boolean) ?? [];
  const groups = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

/** Counts one email to `address` from `ip` against the send limits, or throws 429. Every email Campfile sends on someone's request counts: sign-in codes and approvals (src/access.ts). */
export async function checkSendLimits(sql: Sql, address: string, ip: string): Promise<void> {
  const sender = senderKey(ip);
  // One check per email at a time, so the per-email limit holds under parallel requests: it bounds guesses at a code (each send resets the tries).
  // shortcut: the per-IP and daily totals can still be passed by a burst to different emails; lock those too if that ever matters.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${address}))`;
    const [sent] = await tx<{ email: number; ip: number; total: number }[]>`
      select count(*) filter (where email = ${address} and sent_at > now() - interval '1 hour')::int as email,
             count(*) filter (where ip = ${sender})::int as ip,
             count(*)::int as total -- with the owners' request emails (src/access.ts askForAccess)
      from signin_sends where sent_at > now() - interval '1 day'`;
    if (sent.email >= CODES_PER_EMAIL_PER_HOUR) {
      throw new CampfileError(429, `${CODES_PER_EMAIL_PER_HOUR} codes were already sent to this email in the last hour. Use the newest one, or wait an hour.`);
    }
    if (sent.ip >= CODES_PER_IP_PER_DAY) throw new CampfileError(429, 'Too many codes were asked for from this network or workspace today. Try again tomorrow.');
    if (sent.total >= EMAILS_PER_DAY) throw new CampfileError(429, 'Campfile has sent all the emails it can today. Try again tomorrow.');

    await tx`insert into signin_sends (email, ip) values (${address}, ${sender})`;
  });
}

/** Daily cron (src/app.ts): deletes what the privacy policy says we don't keep. Expired sign-in codes, send records older than a day, reporters' IPs older than a day, flags of deleted pages once the day's limits no longer count them,
 * and past days' visit salts (docs/SPEC.md "Open counts"). */
export async function purgeExpired(sql: Sql): Promise<void> {
  await sql`delete from signin_codes where expires_at < now()`;
  await sql`delete from visit_salts where day < current_date`;
  await sql`delete from signin_sends where sent_at < now() - interval '1 day'`;
}

export async function sendEmail(env: EmailEnv, to: string, rawSubject: string, text: string): Promise<void> {
  const subject = rawSubject.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, ' '); // a page title in a subject can hold newlines, control characters and text-reversing marks
  if (env.SEND_EMAIL) return env.SEND_EMAIL(to, subject, text);
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.APP_ORIGIN)) throw new Error('Email delivery is not configured');
  console.log(`Local dev, no email transport. Email to ${to}: ${subject}\n\n${text}`);
}

/**
 * Uses up the email's code and signs the email in (signIn).
 * Each try counts before the code is compared, under the row lock, so parallel guesses still get MAX_TRIES in total.
 * Single-user mode (OWNER_LOGIN, self-hosted without SMTP): the owner's email may type its password, verbatim, instead of the logged code; the tries still count against that code.
 */
export async function checkCode(sql: Sql, address: string, typed: string, signup: Signup): Promise<number> {
  const owner = signup.env.OWNER_LOGIN;
  const password = owner?.email === address && (await sha256Hex(typed)) === (await sha256Hex(owner.password));
  // People paste "482 913" or "482913." too.
  const given = typed.replace(/[\s.]/g, '');
  if (owner?.email !== address && !/^\d{6}$/.test(given)) throw new CampfileError(400, 'The code is the 6 digits from the email.');
  const [live] = await sql<{ code_hash: string }[]>`
    update signin_codes set attempts = attempts + 1 where email = ${address} and expires_at > now() and attempts < ${MAX_TRIES} returning code_hash`;
  const hash = await sha256Hex(given);
  if (!live || (!password && live.code_hash !== hash)) throw new CampfileError(400, WRONG_CODE);
  // Only one request can use a code.
  const [used] = await sql<{ terms_version: string | null }[]>`delete from signin_codes where email = ${address} and (${password} or code_hash = ${hash}) returning terms_version`;
  if (!used) throw new CampfileError(400, WRONG_CODE);
  return signIn(sql, address, used.terms_version, signup);
}

/** The code screen's heading and first paragraph where the email types a password instead of a code: single-user mode's owner, or an app store reviewer on the hosted service. */
export function passwordIntro(env: ViewerEnv, address: string): string | undefined {
  return env.OWNER_LOGIN?.email === address ? '<h1>Type your password</h1>\n<p>This server is in single-user mode: type the <strong>OWNER_PASSWORD</strong> from its .env.</p>' : undefined;
}

/** The code box; a password box instead where passwordIntro says so (in single-user mode it takes the code from the log too). */
export function codeInput(env: ViewerEnv, address: string): string {
  return passwordIntro(env, address) !== undefined
    ? '<label for="code">Password</label>\n<input id="code" name="code" type="password" autocomplete="current-password" maxlength="200" required autofocus>'
    : '<label for="code">Code</label>\n<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>';
}

/** Without SMTP (self-hosted) the login sends no email: what its first screen says instead. */
export function noEmailNote(env: Pick<ViewerEnv, 'OWNER_LOGIN'>): string {
  return env.OWNER_LOGIN
    ? 'This server is in single-user mode, so next you type your password.'
    : 'This server has no email set up, so the next screen says where to find your 6&#8209;digit code.';
}

/** What /guide and the self-hosted home (src/home.ts) say the user signs in with, besides their email. */
export function signinWith(env: Pick<ViewerEnv, 'OWNER_LOGIN' | 'EMAIL_IN_LOG'>): string {
  return env.OWNER_LOGIN
    ? 'your password (<b>OWNER_PASSWORD</b> in the server’s .env)'
    : env.EMAIL_IN_LOG
    ? 'the 6&#8209;digit code in the server’s log (<b>docker compose logs campfile</b>)'
    : 'the 6&#8209;digit code Campfile emails you';
}

/**
 * The workspace (tester id) of an email that just proved it is theirs, by code or login link, created on the first sign-in.
 * Where there are terms (HAS_TERMS), records acceptance of the version the email named; a code sent before the terms existed names none.
 */
export async function signIn(sql: Sql, address: string, termsVersion: string | null, signup: Signup): Promise<number> {
  // xmax = 0 only on a row this statement inserted, not on one the conflict updated: true on the first sign-in only.
  const [tester] = await sql<{ id: number; disabled: boolean; created: boolean }[]>`
    insert into testers (name, email) values (${address}, ${address})
    on conflict (email) do update set email = excluded.email
    returning id, disabled_at is not null as disabled, xmax = 0 as created`;
  if (tester.disabled) throw new CampfileError(403, 'This account is disabled. Ask the Campfile admin about it.');
  if (HAS_TERMS && termsVersion) await sql`insert into terms_acceptances (tester, email, version) values (${tester.id}, ${address}, ${termsVersion}) on conflict do nothing`;
  if (tester.created) tellAdmin(signup.env, signup.waitUntil, `New sign-up: ${address}`, `${address} signed up on Campfile, through ${signup.via}.`);
  return tester.id;
}

/** CLI sign-in: a correct code gets a new key. Every sign-in adds a key, so other machines' keys keep working. */
export async function issueKey(sql: Sql, input: unknown, signup: Signup): Promise<{ email: string; key: string }> {
  const { email: address, code: given } = parse(verifyInput, input);
  const tester = await checkCode(sql, address, given, signup);
  const key = newKey();
  await sql`insert into credentials (tester, key_hash) values (${tester}, ${await sha256Hex(key)})`;
  return { email: address, key };
}
