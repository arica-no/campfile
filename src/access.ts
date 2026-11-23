// Publish with approval (docs/SPEC.md "Publish with approval"): who asked for an approval page and who may open it.
// The viewer calls visitorStatus, askForAccess and askWithEmail; the app's owner pages (src/manage.ts) call the rest.
import type { Sql } from './db.ts';
import type { AppEnv, ViewerEnv } from './env.ts';
import { newState, readSignedId, signedId } from './keys.ts';
import { CampfileError } from './pages.ts';
import { checkSendLimits, email, EMAILS_PER_DAY, loginLink, sendCode, sendEmail, termsLine } from './signin.ts';

const MAX_EMAILS_AT_ONCE = 100;
// An approval page's open requests, so strangers cannot flood its owner: at most this many wait at once, and only this many a day email the owner. The rest still show on the owner page.
const MAX_WAITING = 100;
export const OWNER_EMAILS_PER_DAY = 10;
// An invite opens its page when opened, for INVITE_CLICK_DAYS and at most INVITE_OPENS times (page_people.invite_until, invite_opens): enough for a mail scanner's opens and the person's; until INVITE_DAYS it then only offers to email that address a fresh invite.
// Each send's link opens only while invite_until is still the one it set, and every send sets a later one (a second on, at least), so a renewed invite ends every older link instead of bringing it back, even within the same second. Say no and Remove end it at once.
const INVITE_CLICK_DAYS = 7;
const INVITE_OPENS = 5;
export const INVITE_DAYS = 30;
// invite_until = the link's own expiry minus this: one value both carry, so useInvite can tell an older send's link.
const UNTIL_BEFORE_EXPIRY = (INVITE_DAYS - INVITE_CLICK_DAYS) * 24 * 60 * 60;
const inviteUntil = (sql: Sql, expires: number) => sql`to_timestamp(${expires - UNTIL_BEFORE_EXPIRY}::bigint)`;

type MailEnv = Pick<ViewerEnv, 'APP_ORIGIN' | 'SEND_EMAIL' | 'EMAIL_FROM' | 'PREVIEW_SECRET'>;
// Only the app signs login links: CONSENT_SECRET is not on the viewer.
type LinkEnv = MailEnv &
  Pick<
    AppEnv,
    | 'CONSENT_SECRET'
  >;

/** A published approval page, as the people around it see it. */
export interface GatedPage {
  id: string;
  title: string;
  owner_name: string;
  owner_email: string;
}

export interface Person {
  id: number;
  email: string;
}

export type Status = 'approved' | 'waiting' | 'denied';

/** A logged-in person (a workspace id) as an approval page sees them: their email, and their request's status if they have one. Undefined for a disabled workspace. */
export async function visitorStatus(sql: Sql, page: string, person: number): Promise<{ email: string; status: Status | null } | undefined> {
  const [row] = await sql<{ email: string; status: Status | null }[]>`
    select coalesce(t.email, t.name) as email, pp.status from testers t left join page_people pp on pp.page = ${page} and pp.email = t.email
    where t.id = ${person} and t.disabled_at is null`;
  return row;
}

/**
 * Tells a person they were let in. Someone who asked gets the browser login email (src/signin.ts sendCode): a link and a 6-digit code, with a first line saying who let them in. Either one opens the page.
 * Someone the owner typed in, or anyone renewing an expired link (renewInvite), gets an invite instead: a link to the page's Log in that names them and gives the browser that opens it a pass to this page (src/manage.ts).
 * It counts against the send limits as `sender`: the owner's Approve as `owner:<workspace>`, so approving cannot email strangers without limit; a renewal as the clicker's IP. Over a limit it throws, and the person stays let in.
 */
async function tellApproved(sql: Sql, env: LinkEnv, viewerOrigin: string, page: { id: string; title: string }, person: Person, asked: boolean, sender?: string): Promise<boolean> {
  const [row] = await sql<{ owner: number; owner_name: string }[]>`
    select p.owner, t.name as owner_name
    from pages p join testers t on t.id = p.owner where p.id = ${page.id}`;
  const { owner, owner_name } = row;
  // The subjects leave out the owner-chosen title.
  if (asked) {
    // The link goes to the page with no login state: the viewer's own Log in makes one in whichever browser opens it, and comes straight back signed in (src/manage.ts /viewer-login).
    const link = await loginLink(env, person.email, `/viewer-login?page=${page.id}`, newState());
    await sendCode(sql, env, person.email, `owner:${owner}`, link, {
      subject: `${owner_name} let you in on Campfile`,
      intro: `${owner_name} let you in to “${page.title}” on Campfile.`,
    });
    return true;
  }
  await checkSendLimits(sql, person.email, sender ?? `owner:${owner}`);
  // The expiry is in whole seconds and signed alone, so a send in the same second as the last one moves on a second: else both would sign the same link.
  const [{ until }] = await sql<{ until: string }[]>`
    update page_people set invite_until = greatest(${inviteUntil(sql, Math.floor(Date.now() / 1000) + INVITE_DAYS * 24 * 60 * 60)}, date_trunc('second', invite_until) + interval '1 second'), invite_opens = 0
    where id = ${person.id} returning extract(epoch from invite_until)::bigint as until`;
  const invite = await signedId(env.PREVIEW_SECRET, `invite:${page.id}`, person.id, Number(until) + UNTIL_BEFORE_EXPIRY);
  await sendEmail(
    env,
    person.email,
    `${owner_name} shared a page with you on Campfile`,
    `${owner_name} shared “${page.title}” with you on Campfile.

Open it here:
${viewerOrigin}/${page.id}/login?invite=${encodeURIComponent(invite)}

Opening the link opens the page, so please don't forward this email. It works for ${INVITE_CLICK_DAYS} days, up to ${INVITE_OPENS} times; after that, it offers to email you a new one.${termsLine(env.APP_ORIGIN, 'opening it')}`,
  );
  return true;
}

/** An approved person on a published approval page whose owner is active: who may get a renewed invite to it. */
export async function approvedOn(sql: Sql, page: string, address: string): Promise<(Person & { title: string }) | undefined> {
  const [row] = await sql<(Person & { title: string })[]>`
    select pp.id, pp.email, p.title from page_people pp join pages p on p.id = pp.page join testers t on t.id = p.owner
    where pp.page = ${page} and pp.email = ${address} and pp.status = 'approved'
      and p.status = 'live' and p.published_at is not null and p.access = 'approval' and t.disabled_at is null`;
  return row;
}

/**
 * An expired link to a page someone was let in to (src/manage.ts /signin/renew): a fresh invite, as the owner's Let them in sends, to their own address.
 * It opens that one page and logs nobody in to an account, so a stranger's link sent to someone else gains the stranger nothing. Counts against the clicker's send limits.
 */
export const renewInvite = (sql: Sql, env: LinkEnv, viewerOrigin: string, page: string, person: Person & { title: string }, ip: string) =>
  tellApproved(sql, env, viewerOrigin, { id: page, title: person.title }, person, false, ip);

/** Who an invite link names, while they are still let in to that page: their email and the page owner's name. */
export async function invited(sql: Sql, secret: string, page: string, invite: string | undefined): Promise<{ email: string; owner_name: string } | undefined> {
  const person = await readSignedId(secret, `invite:${page}`, invite);
  if (person === undefined) return undefined;
  const [row] = await sql<{ email: string; owner_name: string }[]>`
    select pp.email, t.name as owner_name from page_people pp join pages p on p.id = pp.page join testers t on t.id = p.owner
    where pp.id = ${person} and pp.page = ${page} and pp.status = 'approved'`;
  return row;
}

/**
 * Uses one of an invite's opens: the invited person (a page_people id), email and approval `version` (decided_at in microseconds, which the pass carries: src/viewer.ts hasPass),
 * or undefined when the invite is not valid, is ended, is past its days or has no opens left.
 * One statement, so two opens at once cannot both take the last one, and the version is the one this open was let through under.
 */
export async function useInvite(sql: Sql, secret: string, page: string, invite: string | undefined): Promise<{ id: number; email: string; version: string } | undefined> {
  const person = await readSignedId(secret, `invite:${page}`, invite);
  if (person === undefined) return undefined;
  const [row] = await sql<{ id: number; email: string; version: string }[]>`
    update page_people set invite_opens = invite_opens + 1
    where id = ${person} and page = ${page} and status = 'approved' and invite_until > now() and invite_opens < ${INVITE_OPENS}
      and invite_until = ${inviteUntil(sql, Number(invite!.split('.')[1]))}
      and exists (select 1 from pages p join testers t on t.id = p.owner
                  where p.id = page_people.page and p.status = 'live' and p.published_at is not null and p.access = 'approval' and t.disabled_at is null)
    returning id, email, (extract(epoch from decided_at) * 1000000)::bigint::text as version`;
  return row;
}

/** Over a send limit, people are let in all the same: say who got no email. */
function letInAnyway(limit: string, emails: string[]): CampfileError {
  return new CampfileError(429, `${limit} Let in anyway, without an email: ${emails.join(', ')}. They open the page at its link by logging in with that email.`);
}

/**
 * A visitor without a request asks to open an approval page: a waiting request, and one email to the owner about it.
 * A logged-in visitor's email is proven by the login. A `typed` one is not (the visitor typed it at the gate), and the owner's email says so.
 */
export async function askForAccess(sql: Sql, env: MailEnv, page: GatedPage, address: string, typed = false): Promise<void> {
  const [{ waiting }] = await sql<{ waiting: number }[]>`select count(*)::int as waiting from page_people where page = ${page.id} and status = 'waiting'`;
  if (waiting >= MAX_WAITING) throw new CampfileError(429, 'This page has too many requests waiting for its owner. Try again later.');
  const [asked] = await sql`insert into page_people (page, email, status) values (${page.id}, ${address}, 'waiting') on conflict (page, email) do nothing returning id`;
  if (!asked) return; // the same email asked at the same moment
  // Owner emails are logged in signin_sends as `page:<id>`, apart from page_people, so deciding or removing requests does not refill the day's budget.
  // shortcut: two asks at the same moment can both pass, as in checkSendLimits.
  const notifier = `page:${page.id}`;
  const [{ notified, total }] = await sql<{ notified: number; total: number }[]>`
    select count(*) filter (where ip = ${notifier})::int as notified, count(*)::int as total from signin_sends where sent_at > now() - interval '1 day'`;
  // Past the day's emails in all, the request is filed and the owner sees it on the page's manage screen, unemailed.
  if (notified >= OWNER_EMAILS_PER_DAY || total >= EMAILS_PER_DAY) return;
  await sql`insert into signin_sends (email, ip) values (${notifier}, ${notifier})`;
  await sendEmail(
    env,
    page.owner_email,
    `${address} wants to see ${page.title}`,
    `${address} is asking to open your Campfile page “${page.title}”.

${typed ? `The visitor typed this email, and Campfile hasn't checked that it belongs to them: it only opens the page for whoever can read that inbox.\n\n` : ''}Approve or say no: ${env.APP_ORIGIN}/p/${page.id}/manage

Only approve people you know. You sign in with this email address to decide.`,
  );
}

/**
 * Someone not logged in types their email at the gate to ask. Already let in: they get a sign-in code now, for the code box that follows. Otherwise a waiting request, once (asking again, or after a no, files nothing).
 * The typed email is unchecked, so every ask counts against the send limits like a sign-in code does: per email, per IP and in total (src/signin.ts checkSendLimits).
 * The viewer cannot sign a login link (see LinkEnv), so unlike the owner's Approve email, this one has a code only.
 */
export async function askWithEmail(sql: Sql, env: MailEnv, page: GatedPage, address: string, ip: string): Promise<void> {
  const [person] = await sql<{ status: Status }[]>`select status from page_people where page = ${page.id} and email = ${address}`;
  if (person?.status === 'approved') return sendCode(sql, env, address, ip);
  await checkSendLimits(sql, address, ip);
  if (!person) await askForAccess(sql, env, page, address, true);
}

/** Emails typed by the owner: separated by commas, semicolons, spaces or new lines. Throws 400 naming the first one that is not an email. */
export function parseEmails(text: string): string[] {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (parts.length > MAX_EMAILS_AT_ONCE) throw new CampfileError(400, `Add at most ${MAX_EMAILS_AT_ONCE} emails at a time.`);
  return [
    ...new Set(
      parts.map((part) => {
        const parsed = email.safeParse(part);
        if (!parsed.success) throw new CampfileError(400, `“${part}” is not an email address. Fix it and try again.`);
        return parsed.data;
      }),
    ),
  ];
}

/** The owner lets these emails in: someone who asked gets the login email, anyone else not let in before an invite. Every one is also saved in the owner's remembered emails (docs/SPEC.md "Publish with approval"), in the same statement. */
export async function addPeople(sql: Sql, env: LinkEnv, viewerOrigin: string, page: { id: string; title: string }, emails: string[]): Promise<void> {
  if (!emails.length) return;
  // As JSON text: with fetch_types off (src/db.ts) postgres.js sends a JS array as one plain string, and a jsonb parameter would be encoded again.
  const list = JSON.stringify(emails);
  const added = await sql<(Person & { was: string | null })[]>`
    with wanted as (select value as email from jsonb_array_elements_text(${list}::text::jsonb)),
    old as (select email, status from page_people where page = ${page.id} and email in (select email from wanted)),
    remembered as (
      insert into remembered_emails (owner, email) select p.owner, w.email from pages p, wanted w where p.id = ${page.id}
      on conflict (owner, email) do update set used_at = now())
    insert into page_people (page, email, status, decided_at) select ${page.id}, email, 'approved', now() from wanted
    on conflict (page, email) do update set status = 'approved', decided_at = case when page_people.status = 'approved' then page_people.decided_at else now() end
    returning id, email, (select status from old where old.email = page_people.email) as was`;
  // A per-email limit stops one invite, the owner's daily one the rest: try each, then name everyone who got none.
  const unsent: string[] = [];
  let limit = '';
  for (const person of added) {
    if (person.was === 'approved') continue;
    try {
      const sent = await tellApproved(sql, env, viewerOrigin, page, person, person.was !== null);
    } catch (error) {
      if (!(error instanceof CampfileError && error.status === 429)) throw error;
      unsent.push(person.email);
      limit = error.message;
    }
  }
  if (unsent.length) throw letInAnyway(limit, unsent);
}

export type Decision = 'approve' | 'deny' | 'remove';

/** The owner's Approve, Say no and Remove buttons. Approving someone who asked sends them the login email and saves the email in the owner's remembered emails. Remove deletes the row, so that email can ask again, and ends any invite. Say no ends an invite for good, so approving again later does not bring it back. */
export async function decide(sql: Sql, env: LinkEnv, viewerOrigin: string, page: { id: string; title: string }, person: number, decision: Decision): Promise<void> {
  if (decision === 'remove') {
    await sql`delete from page_people where id = ${person} and page = ${page.id}`;
  } else if (decision === 'deny') {
    // Uses up its opens rather than clearing invite_until, which a later invite must still pass by a second at least (tellApproved).
    await sql`update page_people set status = 'denied', decided_at = now(), invite_opens = ${INVITE_OPENS} where id = ${person} and page = ${page.id}`;
  } else {
    const [approved] = await sql<Person[]>`
      with approved as (
        update page_people set status = 'approved', decided_at = now() where id = ${person} and page = ${page.id} and status <> 'approved' returning id, email),
      remembered as (
        insert into remembered_emails (owner, email) select p.owner, a.email from approved a, pages p where p.id = ${page.id}
        on conflict (owner, email) do update set used_at = now())
      select id, email from approved`;
    if (!approved) return;
    try {
      const sent = await tellApproved(sql, env, viewerOrigin, page, approved, true);
    } catch (error) {
      if (error instanceof CampfileError && error.status === 429) throw letInAnyway(error.message, [approved.email]);
      throw error;
    }
  }
}
