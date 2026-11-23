import { z } from 'zod';
import type postgres from 'postgres';
import type { Sql, WaitUntil } from './db.ts';
import type { AppEnv, Bucket } from './env.ts';
import { addPeople, decide, parseEmails } from './access.ts';
import { newPageId, sha256Hex, signedId, VIEWER_LOGIN } from './keys.ts';
import { BrowserBusy, PREVIEW_WAIT_MS, takeScreenshot, within } from './preview.ts';
import { clearTree, shareTree, type Sharing, type ShareTree } from './sharing.ts';

export const MAX_HTML_BYTES = 5 * 1024 * 1024;
/** An unlimited workspace's cap per page (migrations/001_init.sql). Past MAX_BODY_BYTES such a page comes in by source_url, not inline. */
export const MAX_HTML_BYTES_UNLIMITED = 25 * 1024 * 1024;
/** How long a source_url download may take, headers and body together. */
const DOWNLOAD_MS = 30_000;
/** What source_url pages may hold in memory at once, in this process, from their download until they are written: a slow source keeps a download there for up to DOWNLOAD_MS, and no request body budget sees it (selfhost/http.ts). */
const DOWNLOADS_BUDGET = 64 * 2 ** 20;
let downloading = 0;
export const MAX_PAGES = 200;
/** All of a tester's pages together, drafts included. Link previews do not count. */
export const MAX_STORAGE_BYTES = 100 * 1024 * 1024;
/** New pages per tester per UTC day. Updates never count: the 200-page and 100 MB caps bound what an update can store. */
export const MAX_NEW_PAGES_PER_DAY = 50;
/** Cap on a whole request body. Generous: JSON escaping can make the HTML several times bigger. The exact limit is checked on the HTML itself. */
export const MAX_BODY_BYTES = 4 * MAX_HTML_BYTES;

type ErrorStatus = 400 | 401 | 403 | 404 | 413 | 429;

/** An error whose message is safe to show to the user, and is written for an AI to relay. */
export class CampfileError extends Error {
  status: ErrorStatus;
  constructor(status: ErrorStatus, message: string) {
    super(message);
    this.status = status;
  }
}

const tooBig = (limit: number) => `This page is too big. The limit is ${limit / 2 ** 20} MB of HTML. Make it smaller, for example by shrinking images, and try again.`;
export const TOO_BIG = tooBig(MAX_HTML_BYTES);
/** An unlimited workspace's request over MAX_BODY_BYTES: its page may be bigger than that, but not inline. */
export const REQUEST_TOO_BIG = `This request is too big: at most ${MAX_BODY_BYTES / 2 ** 20} MB. Send a page this big as "source_url", a link Campfile downloads it from, instead of "html".`;
/** `used` is everything else of the tester's, without the page being written. */
function checkStorage(tester: Tester, used: number, size: number) {
  if (used + size > MAX_STORAGE_BYTES && !tester.unlimited) {
    // Rounded up, so a page 1 byte over shows 100.1 MB, not a confusing 100.0.
    const total = (Math.ceil(((used + size) / 2 ** 20) * 10) / 10).toFixed(1);
    throw new CampfileError(
      403,
      `This would bring your pages to ${total} MB, drafts included, and the limit is ${MAX_STORAGE_BYTES / 2 ** 20} MB. Delete a page you no longer need, then try again.`,
    );
  }
}
/** Counts one new page for today, or refuses it. Counted before the write: one that then fails still counts. */
async function countNewPage(sql: Sql, tester: Tester) {
  const [{ writes }] = await sql<{ writes: number }[]>`
    with today as (select (now() at time zone 'utc')::date as day)
    update testers set writes = case when writes_day = today.day then writes + 1 else 1 end, writes_day = today.day from today where id = ${tester.id} returning writes`;
  if (writes > MAX_NEW_PAGES_PER_DAY && !tester.unlimited) {
    throw new CampfileError(
      429,
      `You have created ${MAX_NEW_PAGES_PER_DAY} new pages today, which is the daily limit. Updating your existing pages still works. Try again tomorrow: the count starts over at midnight UTC.`,
    );
  }
}
export const INTERNAL_ERROR = 'Something went wrong on our side. Please try again in a minute.';
export const NO_SUCH_PAGE = 'No page with that id was found among your pages. List your pages to see their ids.';
export const NO_SUCH_GROUP = 'No group with that id was found among your groups. List your groups to see their ids.';
export const MAX_DELETE = 1000;
// "A, B and C"; at most 10 named, so a refusal for hundreds of pages stays readable.
export const andList = (items: string[]) => {
  const shown = items.slice(0, 10);
  const rest = items.length > 10 ? `${items.length - 10} more` : shown.pop();
  return shown.length ? `${shown.join(', ')} and ${rest}` : rest!;
};

/** A delete that deleted nothing (docs/SPEC.md "Deleting pages"): the ids not found, or the published pages that need the word. The wall words its own message from them; the connector relays the message. */
export class DeleteRefused extends CampfileError {
  missing: string[];
  published: { id: string; title: string }[];
  constructor(missing: string[], published: { id: string; title: string }[]) {
    super(
      missing.length ? 404 : 400,
      missing.length
        ? `${missing.length === 1 ? `No page ${missing[0]} was` : `No pages ${andList(missing)} were`} found among your pages, so this call deleted nothing. ${missing.length === 1 ? 'It was' : 'They were'} deleted already (by an earlier call, or by the user in Campfile) or never one of your pages (a wrong id): list your pages to check, and tell the user which pages were not found, by title where you know it (they never see ids). If other pages in this call are still there, plan again with only those and ask the user again; if none are, there is nothing left to delete.`
        : `Nothing was deleted. ${andList(published.map((p) => `“${p.title}”`))} ${published.length === 1 ? 'is published: its link stops' : 'are published: their links stop'} working for everyone. To delete, the user must reply with the word delete on its own (“delete” or “Delete.”); a sentence with it, like “yes, delete”, does not count. Ask the user to type it; never send it for them.`,
    );
    this.missing = missing;
    this.published = published;
  }
}
/** A short reply as words: lowercase, any run of spaces and punctuation one space, none at the ends ("Yes, please!" is "yes please"). Digits are words ("delete 2" is not "delete"); a question or a reply that trails off is no reply ("ok?" and "yes…" are ""). */
// Question marks of every script: a Chinese or Japanese keyboard types ？, Arabic ؟. A reply that trails off ("yes…", "ok...") is a hedge, not a yes.
const ASKS = /[?\u00BF\u037E\u055E\u061F\u1367\u203D\u2047-\u2049\u2753\u2754\u2E2E\uFE16\uFE56\uFF1F\u2026\u2025\u22EF\uFE19\u22EE\u1801\u205D\u205E]|\uD83E\uDD14|[.,\u3002\uFF0E\uFF61\uFE52\u2024\u00B7\u30FB\uFF0C\u3001\u060C\u2022\uFF65\u2219\u2027\u22C5\uFF64\u06D4\u0964\u0965\u104A\u104B\u0589\u1803\u1362\u17D4\u2E31\u2236]\s*[.,\u3002\uFF0E\uFF61\uFE52\u2024\u00B7\u30FB\uFF0C\u3001\u060C\u2022\uFF65\u2219\u2027\u22C5\uFF64\u06D4\u0964\u0965\u104A\u104B\u0589\u1803\u1362\u17D4\u2E31\u2236]/;
export const wordsOf = (typed: string) => (ASKS.test(typed) ? '' : typed.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
/** The word a published page's delete needs, as people type it: any case, spaces and punctuation around it ("Delete.", “delete”), but not inside a sentence ("yes, delete") or spelled out ("d e l e t e"). */
export const saysDelete = (typed = '') => wordsOf(typed) === 'delete';

export interface Tester {
  id: number;
  name: string;
  /** No cap on pages, storage or daily writes, and MAX_HTML_BYTES_UNLIMITED per page (migrations/001_init.sql). */
  unlimited: boolean;
}

export async function authenticate(sql: Sql, key: string | undefined): Promise<Tester> {
  if (key) {
    const [tester] = await sql<Tester[]>`
      select t.id, t.name, t.unlimited from credentials c join testers t on t.id = c.tester where c.key_hash = ${await sha256Hex(key)} and t.disabled_at is null`;
    if (tester) return tester;
  }
  throw new CampfileError(401, "This key is missing, wrong or disabled. Sign in again with the user's email to get a new key, as the instructions at GET / describe.");
}

/** The tester a connector token was issued to, unless they have been disabled since. */
export async function activeTester(sql: Sql, id: number): Promise<Tester | undefined> {
  const [tester] = await sql<Tester[]>`select id, name, unlimited from testers where id = ${id} and disabled_at is null`;
  return tester;
}

export const title = z.string('The title must be text.').trim().min(1, 'The title must not be empty.').max(200, 'The title must be 200 characters or fewer.');
const html = z.string('The html must be text.').min(1, 'The html must not be empty.');
const sourceUrl = z
  .string('"source_url" must be text.')
  .refine((url) => URL.canParse(url) && new URL(url).protocol === 'https:', '"source_url" must be an https:// link to the HTML file.');
const createInput = z.object(
  { title, html: html.optional(), source_url: sourceUrl.optional(), group: z.string('"group" must be a group id, as list_groups shows it.').optional() },
  'Send a JSON object with a "title" and an "html" field.',
);
const updateInput = z.object({ title: title.optional(), html: html.optional(), source_url: sourceUrl.optional() }, 'Send a JSON object with an "html" field and, optionally, a "title".');
const editInput = z.object(
  {
    edits: z
      .array(
        z.object(
          {
            old: z.string('Each edit needs "old": the exact text to find.').min(1, 'An edit\'s "old" text must not be empty.'),
            new: z.string('Each edit needs "new": the text to put in its place.'),
            all: z.boolean('"all" must be true or false.').optional(),
          },
          'Each edit is a JSON object with "old" and "new", and optionally "all".',
        ),
        '"edits" must be a list of {"old", "new"} pairs.',
      )
      .min(1, 'Send at least one edit.'),
    title: title.optional(),
  },
  'Send a JSON object with "edits", a list of {"old", "new"} pairs, and, optionally, a "title".',
);
const findInput = z.object({ text: z.string('"text" must be text.').min(1, 'The text to find must not be empty.') }, 'Send a JSON object with "text", the exact text to find.');
const emails = z.string('"emails" must be text: email addresses separated by commas.');
const publishInput = z.object(
  {
    // Omitted: "link", unless "sharing" is given, which then keeps the page's access (publish below), so turning sharing on never makes an approval page public.
    access: z.enum(['link', 'approval'], '"access" must be "link" (anyone with the link) or "approval" (only people the user approves).').optional(),
    emails: emails.default(''),
    // Omitted: the page keeps what it has, so publishing again never turns it off unasked.
    sharing: z
      .enum(
        ['off', 'links', 'emails'],
        '"sharing" must be "off", "links" (readers who allow it get their own link, so the user sees how the page is shared) or "emails" (the same, and they type an email, shown as their name).',
      )
      .optional(),
  },
  'Send a JSON object, for example {"access": "link"}.',
);
const peopleInput = z.object({ emails }, 'Send a JSON object with "emails": email addresses separated by commas.');
const decisionInput = z.object(
  { email: z.string('"email" must be text.'), decision: z.enum(['approve', 'deny', 'remove'], '"decision" must be "approve", "deny" or "remove".') },
  'Send a JSON object with "email" and "decision".',
);

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new CampfileError(400, result.error.issues[0].message);
  return result.data;
}

function encode(text: string, limit: number): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > limit) throw new CampfileError(413, tooBig(limit));
  return bytes;
}

/** The file at source_url, refused once it passes `limit` bytes, without reading the rest. */
async function download(url: string, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const failed = (why: string) =>
    new CampfileError(400, `Could not download ${url}: ${why}. Nothing was saved. The link must open the HTML file itself for anyone, with no login (on GitHub: the file's Raw link).`);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw failed(`it answered ${response.status}`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      size += read.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new CampfileError(413, tooBig(limit));
      }
      chunks.push(read.value);
    }
    if (!size) throw failed('the file is empty');
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return bytes;
  } catch (error) {
    if (error instanceof CampfileError) throw error;
    throw failed(error instanceof Error && error.name === 'TimeoutError' ? `it took over ${DOWNLOAD_MS / 1000} seconds` : 'nothing answered at that address');
  }
}

/** Takes room for one source_url page in DOWNLOADS_BUDGET, held until the page is written or refused (pageService's content), or throws 429. */
function reserveDownload(limit: number): () => void {
  // The chunks and their joined copy: twice the file at most.
  const held = 2 * limit;
  if (downloading + held > DOWNLOADS_BUDGET) throw new CampfileError(429, 'Campfile is downloading other pages right now, so nothing was saved. Try again in a minute.');
  downloading += held;
  return () => {
    downloading -= held;
  };
}

export interface PageLink {
  id: string;
  /** The page's only link. A visitor sees it once it is published (an approval page: once approved); its owner, logged in with their email, sees it always, also as a draft. */
  url: string;
  published: boolean;
}

export interface PageSummary extends PageLink {
  title: string;
  /** Who can open it once published. A draft keeps the access it had, or "link". */
  access: Access;
  /** Whether readers get their own links (src/sharing.ts). Only means something with access "link"; "off" otherwise. */
  sharing: Sharing;
  updated_at: Date;
  /** The group it is in (src/groups.ts), or null. */
  group: { id: string; name: string } | null;
}

/** A published page with its access, and whether its public link opened for a visitor right after publishing. */
export interface Published extends PageLink {
  access: Access;
  sharing: Sharing;
  public_link_works: boolean;
  /** The status the public link answered with, when it was not 200. Missing if it did not answer at all. */
  public_link_status?: number;
}

/** Who can open an approval page: the people who asked (waiting), were let in (approved) or were told no (denied). */
export interface PagePeople {
  id: string;
  published: boolean;
  access: Access;
  people: { email: string; status: 'waiting' | 'approved' | 'denied' }[];
}

/** A page with its HTML source. A long source is cut so that, as JSON text, it stays within MAX_READ_CHARS, which an AI's tool result can hold; `truncated` and `note` then say so, before `html`. */
export interface PageSource extends PageSummary {
  truncated?: true;
  note?: string;
  html: string;
}

export const MAX_READ_CHARS = 100_000;
// Length as a JSON string, without its quotes: quotes, newlines and control characters grow when escaped.
const jsonLength = (text: string) => JSON.stringify(text).length - 2;
// find_in_page shows the first MAX_FINDS places, each with FIND_CONTEXT characters on either side.
const MAX_FINDS = 20;
const FIND_CONTEXT = 80;

/** Everything a tester can do with pages, the same as the owner page's buttons (src/manage.ts). `input` is untrusted: the service validates it. */
export interface PageService {
  create(input: unknown): Promise<PageLink & { group: PageSummary['group'] }>;
  update(id: string, input: unknown): Promise<PageLink>;
  edit(id: string, input: unknown): Promise<PageLink & { replaced: number[] }>;
  find(id: string, input: unknown): Promise<{ count: number; matches: { line: number; snippet: string }[] }>;
  /** The HTTP API's delete: one page, no word (docs/SPEC.md "Deleting pages"). The same as removeMany. */
  remove(id: string): Promise<{ id: string; deleted: true }>;
  /** The owner's and the connector's delete (docs/SPEC.md "Deleting pages"): all of `ids` or none, else DeleteRefused. A published page among them needs `confirm`, the word "delete" the user typed (saysDelete). */
  removeMany(ids: string[], confirm?: string): Promise<{ deleted: { id: string; title: string }[]; count: number }>;
  /** What removeMany(ids) would delete, deleting nothing: the connector shows it to the user first. `missing`: the ids not found among the tester's pages. */
  planDelete(ids: string[]): Promise<{ pages: { id: string; title: string; published: boolean }[]; count: number; published: number; missing: string[] }>;
  get(id: string): Promise<PageSource>;
  /** The tester's live pages, last updated first. `group`: only those in that group (404 if it is not the tester's), or "none" for those in no group. */
  list(group?: string): Promise<{ pages: PageSummary[] }>;
  publish(id: string, input: unknown): Promise<Published>;
  unpublish(id: string): Promise<PageLink>;
  people(id: string): Promise<PagePeople>;
  letIn(id: string, input: unknown): Promise<PagePeople>;
  decide(id: string, input: unknown): Promise<PagePeople>;
  /** Who opened the page through whose link: the tree under the author's link. Each entry has its label, AI name (`ai`), country and device. */
  sharing(id: string): Promise<ShareTree>;
  /** Deletes the page's whole tree; the page and its links keep working. */
  clearSharing(id: string): Promise<{ cleared: number }>;
}

export type PageEnv = Pick<
  AppEnv,
  | 'PAGES' | 'VIEWER_ORIGIN' | 'APP_ORIGIN' | 'SEND_EMAIL' | 'EMAIL_FROM' | 'ADMIN_EMAIL' | 'PREVIEW_SECRET' | 'CONSENT_SECRET' | 'BROWSER'
>;

// How long the viewer login an approval page's shot carries lasts: past the screenshot service's goto and action timeouts (src/preview.ts), with room for its queue.
const SHOT_LOGIN_SECONDS = 300;
/** What the owner's calls and the Publish and Unpublish buttons share: links, stored files and publishing. `waitUntil` keeps work running after the response. */
function pageTools(sql: Sql, env: PageEnv, waitUntil: WaitUntil) {
  const url = (id: string) => `${env.VIEWER_ORIGIN}/${id}`;
  const link = (id: string, published: boolean): PageLink => ({ id, url: url(id), published });
  // Every write goes to a fresh key and the row then switches to it, so a row never points at a half-written file or at another update's file.
  const freshFile = (id: string) => `pages/${id}/${crypto.randomUUID()}.html`;
  const freshPreview = (id: string) => `previews/${id}/${crypto.randomUUID()}.jpg`;
  // A failed delete only orphans a file nobody can reach. It is logged here; the daily sweepOrphans deletes it.
  const dropFile = async (file: string | null | undefined) => {
    if (file) await env.PAGES.delete(file).catch((error) => console.error(`Could not delete ${file}`, error));
  };

  // A page's screenshot, for the wall and, of a page anyone with the link opens, the link preview. It is the framed page as the viewer serves it, at a fresh key.
  // A draft opens for nobody else and an approval page shows strangers only its gate, so both are shot as their owner sees them, through a viewer login for them that lasts as long as a slow shot can; their image is never og:image (src/viewer.ts).
  // A link page is shot as a stranger sees it; the viewer never shows the screenshot browser the sharing banner.
  // It is attached only if the row still points at the file that was shot, the page is still the kind it was shot as (a draft, or published with that access), and has no screenshot yet,
  // so a slow shot of an old version, of a page published, unpublished or switched meanwhile, or a second shot of the same version never lands.
  // A try that fails is counted (shootDue's turns), except a refusal for being over the screenshot limit (BrowserBusy), which keeps the page's turn; a screenshot that lands resets the count.
  // Never throws: a page without a screenshot is still a page. The new screenshot's key if it is now the page's. No screenshot service (env.BROWSER): nothing is tried and nothing is counted.
  async function makePreview(id: string, file: string, kind: Shot, owner: number): Promise<string | undefined> {
    if (!env.BROWSER) return undefined;
    let preview: string | undefined;
    try {
      const login = kind === 'link' ? undefined : { name: VIEWER_LOGIN, value: await signedId(env.PREVIEW_SECRET, 'owner', owner, Math.floor(Date.now() / 1000) + SHOT_LOGIN_SECONDS) };
      // The framed page, as visitors see it: /raw serves only a frame's iframe; in the frame, sandbox (no top navigation) + the frame page's frame-src (its own /raw) keep it in place.
      const image = await takeScreenshot(env.BROWSER, url(id), login);
      preview = freshPreview(id);
      await env.PAGES.put(preview, image);
      const [attached] = await sql`
        update pages set preview_file = ${preview}, preview_tried_at = null, preview_tries = 0
        where id = ${id} and file = ${file} and ${kind === 'draft' ? sql`published_at is null` : sql`published_at is not null and access = ${kind}`} and preview_file is null returning id`;
      if (attached) return preview;
    } catch (error) {
      console.error(`Could not make a preview for ${id}: ${error}`); // the error's text in the line itself: the log keeps only an Error's stack, without its message
      if (!(error instanceof BrowserBusy))
        await sql`update pages set preview_tried_at = now(), preview_tries = preview_tries + 1 where id = ${id}`.catch((failed) => console.error(`Could not count a try for ${id}: ${failed}`));
    }
    await dropFile(preview); // not attached: the page changed, was unpublished or deleted meanwhile, or the update failed
    return undefined;
  }

  // Publish and update wait for the screenshot (`shot`, makePreview's work) at most PREVIEW_WAIT_MS, so a link shared at once has its image.
  // Either finishes after the response, kept alive by waitUntil.
  async function preview(shot: Promise<unknown>): Promise<void> {
    waitUntil(shot);
    await within(PREVIEW_WAIT_MS, shot);
  }

  // Publishes a draft, or switches a published page between the two kinds of access, or turns sharing on or off.
  // A draft going live or a switch of access takes a new screenshot, as that kind of page is shot (makePreview), and the old one goes; sharing does not change how the page looks.
  // Idempotent: publishing again the same way changes nothing. `sharing` undefined keeps the page's; access "approval" always stores "off".
  // Undefined if there is no live page with this id. The caller has already shown the right to publish it.
  async function publish(id: string, access: Access, sharing?: Sharing): Promise<(PageLink & { access: Access; sharing: Sharing }) | undefined> {
    const [page] = await sql<{ file: string; title: string; owner: number; sharing: Sharing; old_preview: string | null; changed: boolean; was_draft: boolean }[]>`
      with old as (select published_at, access, sharing, preview_file from pages where id = ${id} and status = 'live' for update),
      next as (select case when ${access} = 'approval' then 'off' else coalesce(${sharing ?? null}, old.sharing) end as sharing from old),
      kept as (select old.published_at is not null and old.access = ${access} as same from old)
      update pages p set published_at = coalesce(p.published_at, now()), access = ${access}, sharing = next.sharing,
        preview_file = case when kept.same then p.preview_file end
      from old, next, kept where p.id = ${id}
      returning p.file, p.title, p.owner, p.sharing, old.preview_file as old_preview, not kept.same as changed, old.published_at is null as was_draft`;
    if (!page) return undefined;
    if (page.changed) await dropFile(page.old_preview);
    const shot = page.changed ? makePreview(id, page.file, access, page.owner) : Promise.resolve(undefined);
    // The checks run once the screenshot is taken, so they can look at it too.
    if (page.changed) await preview(shot);
    return { ...link(id, true), access, sharing: page.sharing };
  }

  // Takes a published page back to a draft: its public link stops working at once.
  // Its screenshot goes, and a new one is taken as a draft is shot (makePreview), after the response; a draft keeps its own.
  // Idempotent. Undefined if there is no live page with this id. The caller has already shown the right to unpublish it.
  async function unpublish(id: string): Promise<PageLink | undefined> {
    const [page] = await sql<{ file: string; owner: number; old_preview: string | null; was_published: boolean }[]>`
      with old as (select published_at, preview_file from pages where id = ${id} and status = 'live' for update)
      update pages p set published_at = null, preview_file = case when old.published_at is null then p.preview_file end from old where p.id = ${id}
      returning p.file, p.owner, old.preview_file as old_preview, old.published_at is not null as was_published`;
    if (!page) return undefined;
    if (page.was_published) {
      await dropFile(page.old_preview);
      waitUntil(makePreview(id, page.file, 'draft', page.owner));
    }
    return link(id, false);
  }

  return {
    link, freshFile, dropFile, publish, unpublish,
    makePreview, preview,
  };
}

/** Who can open a published page: anyone with the link, or only the people the owner approves (src/access.ts). */
export type Access = 'link' | 'approval';
/** How a page is shot (makePreview): as a draft, or published with its access. */
type Shot = Access | 'draft';

/** For the owner page's Publish and Unpublish buttons (src/manage.ts), whose callers have checked the owner's browser session. Undefined if there is no live page with this id. */
export const publishPage = (sql: Sql, env: PageEnv, waitUntil: WaitUntil, id: string, access: Access, sharing?: Sharing) => pageTools(sql, env, waitUntil).publish(id, access, sharing);
export const unpublishPage = (sql: Sql, env: PageEnv, waitUntil: WaitUntil, id: string) => pageTools(sql, env, waitUntil).unpublish(id);

/**
 * A page that has no screenshot gets one: for the owner's page view (src/manage.ts), whose caller has checked the owner's session, and runs it after the response.
 * Pages whose shot failed, and those from before drafts and approval pages had screenshots, catch up this way. It settles when the shot is in or has failed. The new screenshot's key if it is now the page's.
 */
export async function shootIfMissing(sql: Sql, env: PageEnv, waitUntil: WaitUntil, id: string): Promise<string | undefined> {
  const [page] = await sql<{ file: string; kind: Shot; owner: number }[]>`
    select file, case when published_at is null then 'draft' else access end as kind, owner from pages where id = ${id} and status = 'live' and preview_file is null`;
  return page && pageTools(sql, env, waitUntil).makePreview(id, page.file, page.kind, page.owner);
}

/** Work after the response is cut off after 30 s: up to 2 rounds of 2 shots at once (SHOTS_AT_ONCE), the second only if the first took under WALL_ROUND_MS. */
export const WALL_SHOTS = 4;
/** A shot usually takes about 5 s; one that took longer means a slow page or a busy service, and a second round could be cut off. */
export const WALL_ROUND_MS = 8_000;
/** The 10-minute cron (src/app.ts) runs within its own call, not after a response: 10 a run catches up 100 missing shots in under 2 hours. */
export const CRON_SHOTS = 10;
/** Our screenshot service takes 2 at once (selfhost/screenshot/server.mjs MAX_SHOTS); a service that takes fewer refuses the other as busy, which is no failed try (the page keeps its turn). */
const SHOTS_AT_ONCE = 2;

/**
 * Pages with no screenshot get theirs, at most `limit`, SHOTS_AT_ONCE at a time: of one owner if given, else of everyone (the cron, src/app.ts).
 * Takes turns: only pages whose shot is due, never tried or longest-waiting first, published pages (whose link preview it is) before drafts. After each try that does not land the wait doubles (2 h, 4 h … 64 h),
 * so pages whose shot keeps failing go to the back and cannot hold every slot. A shot that lands resets it (makePreview). Without a screenshot service (env.BROWSER) it does nothing.
 * `roundMs`: a next round starts only within that long of the start (the wall, whose work is cut off).
 */
export async function shootDue(sql: Sql, env: PageEnv, waitUntil: WaitUntil, limit: number, owner?: number, roundMs = Infinity): Promise<void> {
  const start = Date.now();
  if (!env.BROWSER) return;
  // Claimed, so a cron run and a wall load at the same time never shoot one page twice. Released after, tried or not (a round cut short keeps its turn), or lapsed once a slow shot
  // would be over (a run cut off: the wall's work ends with its request). Not preview_tried_at, which a busy refusal must leave as it is.
  const due = await sql<{ id: string; file: string; kind: Shot; owner: number }[]>`
    with due as (
      select id from pages
      where status = 'live' and preview_file is null
        and (preview_claimed_at is null or preview_claimed_at < now() - interval '1 second' * ${SHOT_LOGIN_SECONDS})
        and (preview_tried_at is null or preview_tried_at < now() - interval '1 hour' * power(2, least(preview_tries, 6)))
        ${owner === undefined ? sql`` : sql`and owner = ${owner}`}
      order by preview_tried_at nulls first, published_at nulls last, created_at
      limit ${limit}
      for update skip locked),
    claimed as (
      update pages p set preview_claimed_at = now() from due where p.id = due.id
      returning p.id, p.file, case when p.published_at is null then 'draft' else p.access end as kind, p.owner, p.preview_tried_at, p.published_at, p.created_at)
    select id, file, kind, owner from claimed order by preview_tried_at nulls first, published_at nulls last, created_at`;
  if (!due.length) return;
  const { makePreview } = pageTools(sql, env, waitUntil);
  try {
    for (let i = 0; i < due.length && (!i || Date.now() - start < roundMs); i += SHOTS_AT_ONCE) {
      await Promise.all(due.slice(i, i + SHOTS_AT_ONCE).map((page) => makePreview(page.id, page.file, page.kind, page.owner)));
    }
  } finally {
    await sql`update pages set preview_claimed_at = null where id in ${sql(due.map((page) => page.id))}`;
  }
}

/** Daily cron (src/app.ts): deletes stored files no page row points at, which a failed dropFile left behind, and spread pictures of pages no longer public. Skips files under an hour old, whose upload may not have reached its row yet. */
export async function sweepOrphans(sql: Sql, bucket: Bucket): Promise<void> {
  const rows = await sql<{ file: string; preview_file: string | null; spread: string | null }[]>`
    select file, preview_file, case when spread_public and status = 'live' and published_at is not null and access = 'link' then id end as spread from pages`;
  const known = new Set(rows.flatMap((row) => [row.file, row.preview_file]));
  const spread = new Set(rows.map((row) => row.spread));
  const cutoff = Date.now() - 60 * 60 * 1000;
  const kept = (key: string) => (key.startsWith('spread/') ? spread.has(key.split('/')[1]) : known.has(key)); // spread/<id>/<design>.jpg (src/spread-view.ts spreadFile)
  for (const prefix of ['pages/', 'previews/', 'spread/']) {
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix, cursor });
      for (const object of listed.objects) {
        if (!kept(object.key) && object.uploaded.getTime() < cutoff) await bucket.delete(object.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
}

/** Deletes stored files whose rows are gone. The bucket deletes up to 1,000 keys per call; a failure is logged, and the daily sweepOrphans deletes what is left. */
export async function dropFiles(bucket: Bucket, files: (string | null)[]): Promise<void> {
  const keys = files.filter((file): file is string => !!file);
  for (let at = 0; at < keys.length; at += 1000) {
    const batch = keys.slice(at, at + 1000);
    await bucket.delete(batch).catch((error) => console.error(`Could not delete ${batch.length} files from ${batch[0]}`, error));
  }
}

// The pages of `unique` that are the tester's, and the ids that are not; `lock` holds the pages until the transaction ends.
async function toDelete(q: postgres.TransactionSql, tester: number, unique: string[], lock: boolean) {
  // One lock order for every delete (id), so two deletes can't lock each other's pages crosswise.
  const rows = await q<{ id: string; title: string; published: boolean }[]>`
    select id, title, published_at is not null as published from pages where id in ${q(unique)} and owner = ${tester} and status = 'live'
    order by id ${lock ? q`for update` : q``}`;
  const found = new Set(rows.map((row) => row.id));
  const order = new Map(unique.map((id, at) => [id, at]));
  // In the order asked, so "the first" is the user's first.
  return { pages: rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!), missing: unique.filter((id) => !found.has(id)) };
}

/**
 * The delete (docs/SPEC.md "Deleting pages") inside the caller's transaction, so a caller's own change commits with it (src/groups.ts deleteGroup): all of `unique`, the tester's live pages, or none, else DeleteRefused.
 * A published one needs `confirm`, the word "delete" (saysDelete). Answers the pages deleted, in the order asked, and their stored files: drop them (dropFiles) once the transaction has committed.
 */
export async function deletePages(tx: postgres.TransactionSql, tester: number, unique: string[], confirm: string) {
  // Locked, a page can't be published between the check and the delete.
  const { pages, missing } = await toDelete(tx, tester, unique, true);
  if (missing.length) throw new DeleteRefused(missing, []);
  const published = pages.filter((page) => page.published);
  if (published.length && !saysDelete(confirm)) throw new DeleteRefused([], published);
  const gone = await tx<{ file: string; preview_file: string | null }[]>`
    delete from pages where id in ${tx(pages.map((page) => page.id))} returning file, preview_file`;
  return { deleted: pages.map(({ id, title }) => ({ id, title })), files: gone.flatMap((page) => [page.file, page.preview_file]) };
}

/** The HTTP API and the MCP tools both call this and nothing else. `input` is untrusted: the service validates it. */
export function pageService(sql: Sql, env: PageEnv, tester: Tester, waitUntil: WaitUntil): PageService {
  const tools = pageTools(sql, env, waitUntil);
  const { link, freshFile, dropFile, preview, makePreview } = tools;
  const maxHtml = tester.unlimited ? MAX_HTML_BYTES_UNLIMITED : MAX_HTML_BYTES;
  /** A create's or update's page: sent inline as `html`, or downloaded from `source_url`. Before anything is counted or written. Call `release` once done with `bytes`, whatever happened: it gives back a download's room in DOWNLOADS_BUDGET. */
  async function content(html: string | undefined, sourceUrl: string | undefined): Promise<{ bytes: Uint8Array<ArrayBuffer>; release: () => void }> {
    if ((html === undefined) === (sourceUrl === undefined)) throw new CampfileError(400, 'Send "html", the page itself, or "source_url", an https link to its file: one of the two.');
    if (html !== undefined) return { bytes: encode(html, maxHtml), release: () => {} };
    const release = reserveDownload(maxHtml);
    try {
      return { bytes: await download(sourceUrl!, maxHtml), release };
    } catch (error) {
      release();
      throw error;
    }
  }
  // `ids` without repeats, refused before any transaction opens when there are none or too many.
  const chosen = (ids: string[]) => {
    const unique = [...new Set(ids)];
    if (!unique.length) throw new CampfileError(400, 'Choose the pages to delete first.');
    if (unique.length > MAX_DELETE) throw new CampfileError(400, `Nothing was deleted: at most ${MAX_DELETE.toLocaleString('en')} pages at a time. Delete them in batches of up to ${MAX_DELETE.toLocaleString('en')}, each confirmed on its own.`);
    return unique;
  };

  /** The tester's live pages that `where` picks, last updated first, as list and get show them, with each one's stored file. */
  async function summaries(where: postgres.PendingQuery<postgres.Row[]>): Promise<(PageSummary & { file: string })[]> {
    const rows = await sql<{ id: string; title: string; published: boolean; access: Access; sharing: Sharing; updated_at: Date; file: string; group_id: string | null; group_name: string }[]>`
      select p.id, p.title, p.published_at is not null as published, p.access, p.sharing, p.updated_at, p.file, g.id as group_id, g.name as group_name
      from pages p left join page_groups g on g.id = p.group_id and g.owner = p.owner
      where p.owner = ${tester.id} and p.status = 'live' ${where} order by p.updated_at desc`;
    return rows.map((row) => ({
      ...link(row.id, row.published),
      title: row.title,
      access: row.access,
      sharing: row.sharing,
      updated_at: row.updated_at,
      group: row.group_id ? { id: row.group_id, name: row.group_name } : null,
      file: row.file,
    }));
  }

  /** The tester's live page, or 404: someone else's page looks the same as no page. */
  async function owned(id: string) {
    const [page] = await sql<{ id: string; title: string; published: boolean; access: Access }[]>`
      select id, title, published_at is not null as published, access from pages where id = ${id} and owner = ${tester.id} and status = 'live'`;
    if (!page) throw new CampfileError(404, NO_SUCH_PAGE);
    return page;
  }

  /** The HTML of the tester's live page, or 404. */
  async function source(id: string) {
    const [page] = await sql<{ file: string }[]>`select file from pages where id = ${id} and owner = ${tester.id} and status = 'live'`;
    const object = page && (await env.PAGES.get(page.file));
    if (!object) throw new CampfileError(404, NO_SUCH_PAGE);
    return new Response(object.body).text();
  }

  async function peopleOf(page: { id: string; published: boolean; access: Access }): Promise<PagePeople> {
    const people = await sql<PagePeople['people']>`
      select email, status from page_people where page = ${page.id}
      order by case status when 'waiting' then 0 when 'approved' then 1 else 2 end, created_at desc`;
    return { id: page.id, published: page.published, access: page.access, people: [...people] };
  }

  /** Letting people in only means something on a published approval page, as on the owner page. */
  function needsApproval(page: { published: boolean; access: Access }) {
    if (!page.published || page.access !== 'approval') {
      throw new CampfileError(400, 'Only a page published with access "approval" has people to let in. Publish it with {"access": "approval"} first.');
    }
  }

  /** Opens the public link the way a visitor does, so the AI can tell the user when it does not work. Never throws. */
  async function opens(url: string, headers?: Record<string, string>): Promise<Pick<Published, 'public_link_works' | 'public_link_status'>> {
    try {
      const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      return response.status === 200 ? { public_link_works: true } : { public_link_works: false, public_link_status: response.status };
    } catch (error) {
      console.error(`Could not open ${url}`, error);
      return { public_link_works: false };
    }
  }

  return {
    // A new page is a draft: only its owner, logged in with their email, can open it.
    // It has no link preview until it is published.
    async create(input: unknown) {
      const { title, html, source_url, group } = parse(createInput, input);
      const { bytes, release } = await content(html, source_url);
      try {
        // shortcut: count, then insert. Two simultaneous publishes at 199 pages or near 100 MB can both pass. The caps are fair use, not security; lock the tester row if that ever matters.
        // Taken-down pages count as pages but not as storage: their owner cannot delete them to make room.
        const [{ n, used }] = await sql<{ n: number; used: number }[]>`
          select count(*)::int as n, coalesce(sum(size) filter (where status = 'live'), 0)::int as used from pages where owner = ${tester.id}`;
        if (n >= MAX_PAGES && !tester.unlimited) {
          throw new CampfileError(403, `You already have ${MAX_PAGES} pages, which is the limit. Delete one before creating another.`);
        }
        if (group !== undefined && !(await sql`select 1 from page_groups where id = ${group} and owner = ${tester.id}`).length) throw new CampfileError(404, NO_SUCH_GROUP);
        checkStorage(tester, used, bytes.length);
        await countNewPage(sql, tester);
        // page_ids keeps every id ever issued, so an id is never reused, even after its page is deleted.
        let id = newPageId();
        while (!(await sql`insert into page_ids (id) values (${id}) on conflict do nothing returning id`).length) id = newPageId();
        const file = freshFile(id);
        await env.PAGES.put(file, bytes);
        const insert = (into: string | null) => sql<{ group_id: string | null; group_name: string | null }[]>`
          with g as (select id, name from page_groups where id = ${into} and owner = ${tester.id})
          insert into pages (id, owner, title, size, file, group_id
          ) values (${id}, ${tester.id}, ${title}, ${bytes.length}, ${file}, (select id from g)
          )
          returning group_id, (select name from g) as group_name`;
        let row;
        try {
          // A group deleted since the check, even one whose delete commits during this insert (the foreign key then refuses it), leaves the page in no group, and the reply says so.
          [row] = await insert(group ?? null).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23503') return insert(null);
            throw error;
          });
        } catch (error) {
          await dropFile(file);
          throw error;
        }
        waitUntil(makePreview(id, file, 'draft', tester.id)); // for the wall; nobody shares a draft's link, so the reply does not wait for it
        return { ...link(id, false), group: row.group_id ? { id: row.group_id, name: row.group_name! } : null };
      } finally {
        release();
      }
    },

    // A draft stays a draft. A published page changes for everyone at once.
    // Both get a new screenshot: the published page before the reply (preview), the draft after it.
    async update(id: string, input: unknown) {
      const { title, html, source_url } = parse(updateInput, input);
      const { bytes, release } = await content(html, source_url);
      try {
        // Not yours, or taken down (kept as it was for the admin): 404 before anything is written.
        const [mine] = await sql<{ size: number; used: number; title: string }[]>`
          select size, title, (select coalesce(sum(size), 0)::int from pages where owner = ${tester.id} and status = 'live') as used
          from pages where id = ${id} and owner = ${tester.id} and status = 'live'`;
        if (!mine) throw new CampfileError(404, NO_SUCH_PAGE);
        // Shrinking a page is always allowed, even over the limit.
        if (bytes.length > mine.size) checkStorage(tester, mine.used - mine.size, bytes.length);
        const file = freshFile(id);
        await env.PAGES.put(file, bytes);
        // One statement points the row at the new file with its title and size, and clears the preview (it shows the old content). The row lock makes overlapping updates take turns, and each deletes what it replaced.
        let old: { file: string; preview_file: string | null; published: boolean; access: Access } | undefined;
        try {
          [old] = await sql<{ file: string; preview_file: string | null; published: boolean; access: Access }[]>`
            with old as (select file, preview_file from pages where id = ${id} and owner = ${tester.id} and status = 'live' for update)
            update pages p set file = ${file}, preview_file = null, title = coalesce(${title ?? null}, p.title), size = ${bytes.length}, updated_at = now()
            from old where p.id = ${id} returning old.file, old.preview_file, p.published_at is not null as published, p.access`;
        } finally {
          if (!old) await dropFile(file); // the switch failed, or the page was deleted while we uploaded
        }
        if (!old) throw new CampfileError(404, NO_SUCH_PAGE);
        await Promise.all([dropFile(old.file), dropFile(old.preview_file)]);
        const shot = makePreview(id, file, old.published ? old.access : 'draft', tester.id);
        if (old.published) await preview(shot);
        else waitUntil(shot);
        return link(id, old.published);
      } finally {
        release();
      }
    },

    // A small change without sending the page again. Each "old" must be in the page exactly once (every place, with "all"), as the edits before it left it; one failing edit applies none.
    async edit(id: string, input: unknown) {
      const { edits, title } = parse(editInput, input);
      let html = await source(id);
      const replaced: number[] = [];
      for (const [i, edit] of edits.entries()) {
        const first = html.indexOf(edit.old);
        if (first < 0) throw new CampfileError(400, `Edit ${i + 1}: its "old" text is not in the page, so nothing was changed. Copy it exactly from the page, spaces and HTML tags included.`);
        // Searched from first + 1, not past the match: in "aaa", "aa" is in two places.
        if (!edit.all && html.indexOf(edit.old, first + 1) >= 0) throw new CampfileError(400, `Edit ${i + 1}: its "old" text is in the page more than once, so nothing was changed. Add some of the text around it, so it matches only one place, or set "all": true to replace every one.`);
        const parts = html.split(edit.old);
        const count = parts.length - 1;
        // Before building it: a short "old" found everywhere times a long "new" could make a string far past the limit. A character is at least one byte.
        if (html.length + count * (edit.new.length - edit.old.length) > maxHtml) throw new CampfileError(413, tooBig(maxHtml));
        html = parts.join(edit.new);
        replaced.push(count);
      }
      // shortcut: read, then write. An update landing in between is overwritten, as with two overlapping update_page calls; hand update the file read here if one page is ever edited from two places at once.
      return { ...(await this.update(id, { title, html })), replaced };
    },

    // Where some text is in a page, so an AI can write an edit_page "old" without reading the whole page, past get_page's cut too.
    async find(id: string, input: unknown) {
      const { text } = parse(findInput, input);
      const html = await source(id);
      const matches: { line: number; snippet: string }[] = [];
      let [count, line, counted] = [0, 1, 0];
      for (let at = html.indexOf(text); at >= 0; at = html.indexOf(text, at + text.length)) {
        count++;
        if (matches.length === MAX_FINDS) continue;
        for (; counted < at; counted++) if (html.charCodeAt(counted) === 10) line++;
        matches.push({ line, snippet: html.slice(Math.max(0, at - FIND_CONTEXT), at + text.length + FIND_CONTEXT) });
      }
      return { count, matches };
    },

    async remove(id: string) {
      // The API has no plan to go back to: a missing page is its plain 404, not the connector's next steps.
      await this.removeMany([id], 'delete').catch((error) => {
        throw error instanceof DeleteRefused ? new CampfileError(404, NO_SUCH_PAGE) : error;
      });
      return { id, deleted: true as const };
    },

    async removeMany(ids: string[], confirm = '') {
      const unique = chosen(ids);
      const { deleted, files } = await sql.begin((tx) => deletePages(tx, tester.id, unique, confirm));
      await dropFiles(env.PAGES, files); // the rows are gone, so the pages are already unviewable
      return { deleted, count: deleted.length };
    },

    async planDelete(ids: string[]) {
      const unique = chosen(ids);
      const { pages, missing } = await sql.begin((tx) => toDelete(tx, tester.id, unique, false));
      return { pages, count: pages.length, published: pages.filter((page) => page.published).length, missing };
    },

    async list(group?: string) {
      if (group !== undefined && group !== 'none' && !(await sql`select 1 from page_groups where id = ${group} and owner = ${tester.id}`).length) throw new CampfileError(404, NO_SUCH_GROUP);
      const rows = await summaries(group === undefined ? sql`` : group === 'none' ? sql`and p.group_id is null` : sql`and p.group_id = ${group}`);
      return { pages: rows.map(({ file: _, ...row }) => row) };
    },

    async get(id: string) {
      const [page] = await summaries(sql`and p.id = ${id}`);
      const object = page && (await env.PAGES.get(page.file));
      if (!object) throw new CampfileError(404, NO_SUCH_PAGE);
      const html = await new Response(object.body).text();
      const { file: _, ...summary } = page;
      // Length first: escaping a 25 MB page of control characters would build a ~150 MB string, past the app's 128 MB.
      if (html.length <= MAX_READ_CHARS && jsonLength(html) <= MAX_READ_CHARS) return { ...summary, html };
      // The longest prefix that fits as JSON; it is at most MAX_READ_CHARS long, since every character is at least one in JSON.
      let [fits, tooLong] = [0, MAX_READ_CHARS + 1];
      while (tooLong - fits > 1) {
        const mid = Math.floor((fits + tooLong) / 2);
        if (jsonLength(html.slice(0, mid)) <= MAX_READ_CHARS) fits = mid;
        else tooLong = mid;
      }
      // Not half an emoji: a lone high surrogate at the end is dropped.
      const cut = html.slice(0, /[\ud800-\udbff]/.test(html[fits - 1] ?? '') ? fits - 1 : fits);
      // Never silent, and ahead of html so a client that cuts the result still keeps it: sending a cut source back with update_page would lose the rest of the page.
      const note = `html is cut at ${cut.length.toLocaleString('en')} of ${html.length.toLocaleString('en')} characters. It is not the whole page, so it cannot be sent back with update_page; edit_page can still change parts of it.`;
      return { ...summary, truncated: true as const, note, html: cut };
    },

    // The owner page's Publish, including switching between the two kinds of access and turning sharing on or off. Only on the user's explicit request (src/instructions.ts).
    async publish(id: string, input: unknown) {
      const { access: asked, emails, sharing } = parse(publishInput, input);
      const page = await owned(id);
      const access = asked ?? (sharing ? page.access : 'link');
      const list = parseEmails(emails);
      if (list.length && access !== 'approval') throw new CampfileError(400, '"emails" only work with access "approval": with "link", anyone who has the link can open the page.');
      const published = await tools.publish(id, access, sharing);
      if (!published) throw new CampfileError(404, NO_SUCH_PAGE); // deleted meanwhile
      await addPeople(sql, env, env.VIEWER_ORIGIN, page, list);
      // The frame page never reads the stored file; /raw does, so a link page must open there too, asked the way the frame's iframe asks (/raw serves nothing else).
      // An approval page's /raw needs a pass: its frame page (the ask form) is what a visitor sees.
      const check = await opens(published.url);
      const result = { ...published, ...(check.public_link_works && access === 'link' ? await opens(`${published.url}/raw`, { 'Sec-Fetch-Dest': 'iframe' }) : check) };
      return result;
    },

    async unpublish(id: string) {
      await owned(id);
      const page = await tools.unpublish(id);
      if (!page) throw new CampfileError(404, NO_SUCH_PAGE);
      return page;
    },

    async people(id: string) {
      return peopleOf(await owned(id));
    },

    // The owner page's "Let them in": these emails may open the page; anyone who was waiting or told no is emailed now.
    async letIn(id: string, input: unknown) {
      const list = parseEmails(parse(peopleInput, input).emails);
      if (!list.length) throw new CampfileError(400, 'Give at least one email address.');
      const page = await owned(id);
      needsApproval(page);
      await addPeople(sql, env, env.VIEWER_ORIGIN, page, list);
      return peopleOf(page);
    },

    // The owner page's Approve, Say no and Remove, for one person by email.
    async decide(id: string, input: unknown) {
      const { email, decision } = parse(decisionInput, input);
      const [address] = parseEmails(email);
      if (!address) throw new CampfileError(400, 'Give the email address of the person.');
      const page = await owned(id);
      needsApproval(page);
      const [person] = await sql<{ id: number }[]>`select id from page_people where page = ${id} and email = ${address}`;
      if (!person) throw new CampfileError(404, `${address} has not asked for this page and was not let in. List the people to see who has.`);
      await decide(sql, env, env.VIEWER_ORIGIN, page, person.id, decision);
      return peopleOf(page);
    },

    // Read-only; the tree stays when sharing is turned off, so it is shown whatever the page's sharing is now.
    async sharing(id: string) {
      await owned(id);
      return shareTree(sql, id);
    },

    // Deletes every entry; the page and every link keep working (an old code then opens as the author's link).
    async clearSharing(id: string) {
      await owned(id);
      return { cleared: await clearTree(sql, id) };
    },
  };
}
