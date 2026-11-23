// What the owner wall (src/manage.ts, `/my`) shows and changes beyond the page service: counts, people, remembered emails, rename and the author's name.
// docs/SPEC.md "Open counts" and "Publish with approval". The callers (src/manage.ts) have checked the browser session, and that a page id is the tester's.
import type { Status } from './access.ts';
import type { Sql, WaitUntil } from './db.ts';
import type { Group } from './groups.ts';
import { type Access, CampfileError, NO_SUCH_PAGE, type PageEnv, parse, title as titleInput } from './pages.ts';
import { authorName, type Sharing } from './sharing.ts';

export interface WallPage {
  id: string;
  title: string;
  published: boolean;
  access: Access;
  sharing: Sharing;
  /** How it spread is open to anyone with the link (src/viewer.ts /:id/spread); counts only while the page is a published link page. */
  spread_public: boolean;
  /** The page's group (src/groups.ts), or null when it is in none. */
  group_id: string | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  /** The screenshot's storage key (src/pages.ts makePreview), or null without one. The wall uses its random part as the image's version. */
  thumb: string | null;
  /** `page_people` counts, whatever the page's access: leftovers stay when it switches to a link page or is unpublished, so show them for a published approval page only. */
  waiting: number;
  approved: number;
  /** Visitors on each of the last 7 UTC days, oldest first, today last. */
  days: number[];
  /** Visitors in those 7 days. */
  week: number;
  /** Visitors since the page was published: 0 for a draft, and a page published again counts from that day on. */
  total: number;
}

/** The tester's live pages, last changed first; or only page `id` of them, for that page's own screen. Two queries for all pages, none per page. Without `withTotal` (an order needs no total), `total` is 0. */
export async function wallPages(sql: Sql, tester: number, id?: string, withTotal = true): Promise<WallPage[]> {
  const only = id === undefined ? sql`` : sql`and p.id = ${id}`;
  // `day` is the database's date, as the viewer writes it (src/viewer.ts): UTC on the database server. A draft has no published_at, so nothing matches and its total is 0.
  const [pages, visits] = await Promise.all([
    sql<Omit<WallPage, 'days' | 'week'>[]>`
      select p.id, p.title, p.published_at is not null as published, p.access, p.sharing, p.spread_public, p.group_id, p.created_at, p.updated_at, p.published_at, p.preview_file as thumb,
        count(pp.id) filter (where pp.status = 'waiting')::int as waiting,
        count(pp.id) filter (where pp.status = 'approved')::int as approved,
        ${withTotal ? sql`(select count(*)::int from page_visits v where v.page = p.id and v.day >= p.published_at::date)` : sql`0`} as total
      from pages p left join page_people pp on pp.page = p.id
      where p.owner = ${tester} and p.status = 'live' ${only}
      group by p.id
      order by p.updated_at desc, p.id`,
    // One page_visits row is one visitor on one day.
    sql<{ page: string; ago: number; visitors: number }[]>`
      select v.page, current_date - v.day as ago, count(*)::int as visitors
      from page_visits v join pages p on p.id = v.page
      where p.owner = ${tester} and p.status = 'live' ${only} and v.day between current_date - 6 and current_date
      group by v.page, v.day`,
  ]);
  const days = new Map<string, number[]>(pages.map((page) => [page.id, new Array<number>(7).fill(0)]));
  for (const { page, ago, visitors } of visits) {
    const week = days.get(page); // a page deleted between the two queries has no entry
    if (week) week[6 - ago] = visitors;
  }
  return pages.map((page) => {
    const week = days.get(page.id)!;
    return { ...page, days: week, week: week.reduce((sum, day) => sum + day, 0) };
  });
}

/** The wall's orders (`?sort=`, src/wall-view.ts SORTS names them), the same for list_pages and list_groups over MCP: groups first, then pages; ties fall back to the last change. */
export const SORT_ORDERS = ['changed', 'added', 'name', 'visitors', 'people'] as const;
export type Sort = (typeof SORT_ORDERS)[number];

/** A group and its live pages, last changed first (as wallPages lists them). */
export interface Shelf {
  g: Group;
  pages: WallPage[];
}

// Each order runs its natural way (A to Z, newest, most). A draft has no visitors or people let in, and only an approval page lets people in.
export const sum = (ps: WallPage[], count: (p: WallPage) => number) => ps.reduce((n, p) => n + count(p), 0);
const visitors = (p: WallPage) => (p.published ? p.week : 0);
const letIn = (p: WallPage) => (p.published && p.access === 'approval' ? p.approved : 0);
const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare; // "round 2" before "round 12"
/** The number a page or a group is sorted by: also shown with it for visitors and people. */
export const PAGE_KEY: Record<Exclude<Sort, 'name'>, (p: WallPage) => number> = { changed: (p) => +p.updated_at, added: (p) => +p.created_at, visitors, people: letIn };
export const SHELF_KEY: Record<Exclude<Sort, 'name'>, (s: Shelf) => number> = { changed: (s) => +s.g.changed_at, added: (s) => +s.g.created_at, visitors: (s) => sum(s.pages, visitors), people: (s) => sum(s.pages, letIn) };
export const sortPages = (ps: WallPage[], sort: Sort) => [...ps].sort((a, b) => (sort === 'name' ? byName(a.title, b.title) : PAGE_KEY[sort](b) - PAGE_KEY[sort](a)) || +b.updated_at - +a.updated_at);
export const sortShelves = (ss: Shelf[], sort: Sort) => [...ss].sort((a, b) => (sort === 'name' ? byName(a.g.name, b.g.name) : SHELF_KEY[sort](b) - SHELF_KEY[sort](a)) || +b.g.changed_at - +a.g.changed_at);

export interface Person {
  id: number;
  email: string;
  status: Status;
  created_at: Date;
  decided_at: Date | null;
}

/** One page's people: waiting first, then approved, then told no; in each group the latest change first (the day they asked, or the owner decided). */
export async function pagePeople(sql: Sql, page: string): Promise<Person[]> {
  return sql<Person[]>`
    select id, email, status, created_at, decided_at from page_people where page = ${page}
    order by case status when 'waiting' then 0 when 'approved' then 1 else 2 end, coalesce(decided_at, created_at) desc, id desc`;
}

export interface Remembered {
  email: string;
  used_at: Date;
  /** How many of the owner's live pages this email is approved on now. */
  pages: number;
}

/** The emails the owner has let in, last let in first (src/access.ts keeps the list). */
export async function rememberedEmails(sql: Sql, tester: number): Promise<Remembered[]> {
  return sql<Remembered[]>`
    select r.email, r.used_at, coalesce(open_on.pages, 0)::int as pages
    from remembered_emails r
    left join (
      select pp.email, count(*) as pages from page_people pp join pages p on p.id = pp.page
      where p.owner = ${tester} and p.status = 'live' and pp.status = 'approved' group by pp.email
    ) open_on on open_on.email = r.email
    where r.owner = ${tester}
    order by r.used_at desc, r.email`;
}

/**
 * The owner's Forget: the email leaves the list. With `revoke` it also loses access, meaning its approved rows on all the owner's pages go (waiting and told-no rows stay: neither is access, and deleting a no would let it ask again).
 * One statement, so the email is never forgotten while its access stays unseen. Returns how many pages lost access.
 */
export async function forgetEmail(sql: Sql, tester: number, email: string, revoke: boolean): Promise<number> {
  const [{ lost }] = await sql<{ lost: number }[]>`
    with forgotten as (delete from remembered_emails where owner = ${tester} and email = ${email}),
    revoked as (
      delete from page_people pp using pages p
      where ${revoke} and pp.page = p.id and p.owner = ${tester} and pp.email = ${email} and pp.status = 'approved'
      returning pp.id)
    select count(*)::int as lost from revoked`;
  return lost;
}

/**
 * The owner's Rename: the title only, so no new file. `title` is untrusted and checked like the API's. Returns the new title.
 */
export async function renamePage(sql: Sql, env: PageEnv, waitUntil: WaitUntil, tester: number, id: string, title: unknown): Promise<string> {
  const name = parse(titleInput, title);
  const [page] = await sql<{ file: string; published: boolean }[]>`
    update pages set title = ${name} where id = ${id} and owner = ${tester} and status = 'live' returning file, published_at is not null as published`;
  if (!page) throw new CampfileError(404, NO_SUCH_PAGE);
  return name;
}

/** The name the publish form asks for, prefilled with the one made from the owner's email; undefined once they were asked (a name saved, or '' for declined). */
export async function nameToAsk(sql: Sql, tester: number): Promise<string | undefined> {
  const [t] = await sql<{ display_name: string | null; email: string | null; name: string }[]>`select display_name, email, name from testers where id = ${tester}`;
  return t && t.display_name === null ? (authorName(t) ?? '') : undefined;
}

/** The publish form's "Your name, shown to readers": saved once, so a later form never overwrites it. Blank saves '' (declined: readers see the name made from the email). Untrusted. */
export async function saveAuthorName(sql: Sql, tester: number, typed: string): Promise<void> {
  const name = typed.trim();
  if ([...name].length > 80) throw new CampfileError(400, 'Your name can be at most 80 characters.');
  if (/\p{Cc}/u.test(name)) throw new CampfileError(400, 'Your name must be on one line, without control characters.');
  if (name.includes('@')) throw new CampfileError(400, 'Use your name, not an email address.');
  await sql`update testers set display_name = ${name} where id = ${tester} and display_name is null`;
}
