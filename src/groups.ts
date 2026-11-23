// Page groups (docs/SPEC.md "Page groups"): one level, a page in at most one group, a group belongs to one tester. The wall (src/manage.ts) and the MCP tools (src/mcp.ts) both call these.
import { z } from 'zod';
import type postgres from 'postgres';
import type { Sql, WaitUntil } from './db.ts';
import { newPageId } from './keys.ts';
import { andList, CampfileError, deletePages, dropFiles, MAX_DELETE, NO_SUCH_GROUP, parse, type PageEnv, type Tester } from './pages.ts';
import { PAGE_KEY, SHELF_KEY, sortPages, sortShelves, wallPages, type Sort } from './wall.ts';

export { NO_SUCH_GROUP };
export const MAX_GROUPS = 200;

export interface Group {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  /** The latest of the group's own updated_at (made, renamed, a page moved in or out) and its live pages' updated_at. */
  changed_at: Date;
  /** Live pages in it. */
  pages: number;
  /** Of those, the published ones. */
  live: number;
}

export const groupName: z.ZodType<string> = z
  .string('The group name must be text.')
  .trim()
  .min(1, 'The group name must not be empty.')
  .max(80, 'The group name must be 80 characters or fewer.')
  .refine((name) => !/[\p{Cc}\u2028\u2029]/u.test(name), 'The group name must be one line, without tabs or line breaks.');

// The unique index on (owner, lower(name)). The refusal quotes the group that has the name, as it is written, not as it was typed.
const isTaken = (error: unknown) => error instanceof Error && 'code' in error && error.code === '23505';
async function taken(sql: Sql, tester: number, name: string) {
  const [had] = await sql<{ name: string }[]>`select name from page_groups where owner = ${tester} and lower(name) = lower(${name})`;
  return new CampfileError(400, `You already have a group called “${had?.name ?? name}”. Choose another name, or use that group.`);
}

/** The tester's groups (one, with `id`), last changed first. Only live pages count. */
async function groups(sql: Sql | postgres.TransactionSql, tester: number, id?: string): Promise<Group[]> {
  return sql<Group[]>`
    select g.id, g.name, g.created_at, g.updated_at, greatest(g.updated_at, max(p.updated_at)) as changed_at,
      count(p.id)::int as pages, count(p.id) filter (where p.published_at is not null)::int as live
    from page_groups g left join pages p on p.group_id = g.id and p.owner = g.owner and p.status = 'live'
    where g.owner = ${tester} ${id === undefined ? sql`` : sql`and g.id = ${id}`}
    group by g.id order by changed_at desc, g.id`;
}

async function oneGroup(sql: Sql | postgres.TransactionSql, tester: number, id: string): Promise<Group> {
  const [group] = await groups(sql, tester, id);
  if (!group) throw new CampfileError(404, NO_SUCH_GROUP);
  return group;
}

export const listGroups = (sql: Sql, tester: number): Promise<Group[]> => groups(sql, tester);

// `ids` without repeats, refused when there are none or too many.
function chosen(ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new CampfileError(400, 'Choose the pages to move first.');
  if (unique.length > MAX_DELETE) throw new CampfileError(400, `Nothing was moved: at most ${MAX_DELETE.toLocaleString('en')} pages at a time. Move them in batches of up to ${MAX_DELETE.toLocaleString('en')}.`);
  return unique;
}

/** Moves the tester's live pages `unique` into `group` (null: out of any group), all or none, and bumps every group they left or joined. `making`: the group is new, so a refusal says it was not made either. */
async function moveIn(q: postgres.TransactionSql, tester: number, unique: string[], group: string | null, making = false) {
  // Pages first, in id order, then groups: the order every move and delete takes its locks in, so none waits on another crosswise.
  const rows = await q<{ id: string; title: string; group_id: string | null }[]>`
    select id, title, group_id from pages where id in ${q(unique)} and owner = ${tester} and status = 'live' order by id for update`;
  const found = new Map(rows.map((row) => [row.id, row]));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    const named = missing.length === 1 ? `No page ${missing[0]} was` : `No pages ${andList(missing)} were`;
    throw new CampfileError(
      404,
      making
        ? `${named} found among your pages, so the group was not made and nothing was moved. List your pages to check their ids, then create the group again with only the ones that are there.`
        : `${named} found among your pages, so nothing was moved. List your pages to check their ids, then move again with only the ones that are there.`,
    );
  }
  // Held until the moves are in, so the group can't be deleted under them.
  if (group !== null && !(await q`select 1 from page_groups where id = ${group} and owner = ${tester} for key share`).length) throw new CampfileError(404, NO_SUCH_GROUP);
  await q`update pages set group_id = ${group} where id in ${q(unique)}`;
  const touched = [...new Set([group, ...rows.map((row) => row.group_id)].filter((id): id is string => !!id))];
  if (touched.length) await q`update page_groups set updated_at = now() where id in ${q(touched)}`;
  return unique.map((id) => ({ id, title: found.get(id)!.title })); // in the order asked
}

/** A new group, with `pageIds` moved into it if given: all of it, or nothing (no group either). */
export async function createGroup(sql: Sql, tester: number, name: unknown, pageIds?: string[]): Promise<Group> {
  const clean = parse(groupName, name);
  const unique = pageIds?.length ? chosen(pageIds) : [];
  try {
    return await sql.begin(async (tx) => {
      // The tester's row held until this commits, so two creates at 199 groups take turns and the second sees the first.
      const [{ unlimited }] = await tx<{ unlimited: boolean }[]>`select unlimited from testers where id = ${tester} for update`;
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from page_groups where owner = ${tester}`;
      if (n >= MAX_GROUPS && !unlimited) throw new CampfileError(403, `You already have ${MAX_GROUPS} groups, which is the limit. Delete one you no longer need, or use one you have.`);
      const id = newPageId();
      await tx`insert into page_groups (id, owner, name) values (${id}, ${tester}, ${clean})`;
      if (unique.length) await moveIn(tx, tester, unique, id, true);
      return oneGroup(tx, tester, id);
    });
  } catch (error) {
    throw isTaken(error) ? await taken(sql, tester, clean) : error;
  }
}

export async function renameGroup(sql: Sql, tester: number, id: string, name: unknown): Promise<Group> {
  const clean = parse(groupName, name);
  let renamed;
  try {
    [renamed] = await sql`update page_groups set name = ${clean}, updated_at = now() where id = ${id} and owner = ${tester} returning id`;
  } catch (error) {
    throw isTaken(error) ? await taken(sql, tester, clean) : error;
  }
  if (!renamed) throw new CampfileError(404, NO_SUCH_GROUP);
  return oneGroup(sql, tester, id);
}

export interface Moved {
  /** In the order asked. */
  moved: { id: string; title: string }[];
  group: Group | null;
}

/** Moves the tester's live pages `ids` into `group`, or out of any group with null: all of them, or none. */
export async function movePages(sql: Sql, tester: number, ids: string[], group: string | null): Promise<Moved> {
  const unique = chosen(ids);
  const moved = await sql.begin((tx) => moveIn(tx, tester, unique, group));
  return { moved, group: group === null ? null : await oneGroup(sql, tester, group) };
}

export interface GroupDeleted {
  name: string;
  /** Its pages left in no group. */
  kept: number;
  deleted: { id: string; title: string }[];
}

/** What deleting a group with its pages would delete, deleting nothing: the connector shows it to the user, who confirms these pages (deleteGroup's `ids`). */
export interface GroupPlan {
  group: { id: string; name: string };
  pages: { id: string; title: string; published: boolean }[];
  count: number;
  published: number;
}

// One rule for the plan and the delete: a group past the per-delete cap is emptied with delete_page first.
function checkCap(count: number) {
  if (count > MAX_DELETE) {
    throw new CampfileError(
      400,
      `This group has ${count.toLocaleString('en')} pages, so nothing was deleted: at most ${MAX_DELETE.toLocaleString('en')} go at a time. Delete them with delete_page in batches of up to ${MAX_DELETE.toLocaleString('en')} (list_pages with this group lists them), then delete_group.`,
    );
  }
}

export async function planDeleteGroup(sql: Sql, tester: number, id: string): Promise<GroupPlan> {
  const [group] = await sql<{ id: string; name: string }[]>`select id, name from page_groups where id = ${id} and owner = ${tester}`;
  if (!group) throw new CampfileError(404, NO_SUCH_GROUP);
  const pages = await sql<GroupPlan['pages']>`
    select id, title, published_at is not null as published from pages where group_id = ${id} and owner = ${tester} and status = 'live' order by updated_at desc, id`;
  checkCap(pages.length);
  return { group, pages: [...pages], count: pages.length, published: pages.filter((page) => page.published).length };
}

export const GROUP_CHANGED = "The group's pages changed since the plan, so nothing was deleted. Plan again and ask the user about the new list.";

/** What happens to a deleted group's pages: kept in no group, or deleted when they are exactly `ids`, the ones the user was shown. */
export type DeleteChoice = { pages: 'keep' } | { pages: 'delete'; ids: string[]; confirm?: string };

/**
 * Deletes one of the tester's groups. `pages: 'keep'` leaves its pages in no group. `pages: 'delete'` deletes them too, in the same transaction, through the pages' own delete (docs/SPEC.md "Deleting pages"):
 * only if the group's live pages are exactly `ids`, the ones the user was shown (else GROUP_CHANGED), and a published one among them needs `confirm`, the typed word "delete".
 * Refused, nothing is deleted and the group stays. Their stored files go after the commit, kept alive by `waitUntil`.
 */
export async function deleteGroup(
  sql: Sql,
  env: PageEnv,
  waitUntil: WaitUntil,
  tester: number,
  id: string,
  opts: DeleteChoice,
): Promise<GroupDeleted> {
  const { result, files } = await sql.begin(async (tx) => {
    // Its pages first, in id order, then the group: moveIn's lock order. Held, the group row makes a move in or a create_page into it wait until this commits.
    await tx`select 1 from pages where group_id = ${id} and owner = ${tester} order by id for update`;
    const [group] = await tx<{ name: string }[]>`select name from page_groups where id = ${id} and owner = ${tester} for update`;
    if (!group) throw new CampfileError(404, NO_SUCH_GROUP);
    // A new statement sees what committed while the locks above waited: a page moved in or out meanwhile.
    const live = (await tx<{ id: string }[]>`select id from pages where group_id = ${id} and status = 'live'`).map((page) => page.id);
    let removed: Awaited<ReturnType<typeof deletePages>> = { deleted: [], files: [] };
    if (opts.pages === 'delete') {
      checkCap(live.length);
      const asked = new Set(opts.ids);
      if (live.length !== asked.size || live.some((page) => !asked.has(page))) throw new CampfileError(400, GROUP_CHANGED);
      if (asked.size) removed = await deletePages(tx, tester, [...asked], opts.confirm ?? ''); // in the order shown
    }
    await tx`delete from page_groups where id = ${id}`; // its pages left, kept, are in no group
    return { result: { name: group.name, kept: opts.pages === 'keep' ? live.length : 0, deleted: removed.deleted }, files: removed.files };
  });
  waitUntil(dropFiles(env.PAGES, files)); // the rows are gone, so the pages are already unviewable
  return result;
}

/** One page or group in the wall's order: when it was added, and the number it was sorted by when that is visitors or people. */
export interface Ranked {
  id: string;
  added: Date;
  count?: number;
}

const counted = (sort: Sort) => (sort === 'visitors' || sort === 'people' ? sort : undefined);

/** The wall's order (src/wall.ts) of all the tester's live pages. */
export async function pagesInOrder(sql: Sql, tester: number, sort: Sort): Promise<Ranked[]> {
  const by = counted(sort);
  return sortPages(await wallPages(sql, tester, undefined, false), sort).map((p) => ({ id: p.id, added: p.created_at, count: by && PAGE_KEY[by](p) }));
}

/** The wall's order of the tester's groups, each sorted with its live pages as the wall shelves them; their pages are read only when a count orders them. */
export async function groupsInOrder(sql: Sql, tester: number, sort: Sort): Promise<(Ranked & { group: Group })[]> {
  const by = counted(sort);
  const [groups, pages] = await Promise.all([listGroups(sql, tester), by ? wallPages(sql, tester, undefined, false) : []]);
  const shelves = groups.map((g) => ({ g, pages: pages.filter((p) => p.group_id === g.id) }));
  return sortShelves(shelves, sort).map((s) => ({ id: s.g.id, added: s.g.created_at, count: by && SHELF_KEY[by](s), group: s.g }));
}

/** The group calls for one tester, as the MCP tools use them. */
export interface GroupService {
  list(): Promise<Group[]>;
  create(name: unknown, pageIds?: string[]): Promise<Group>;
  rename(id: string, name: unknown): Promise<Group>;
  move(ids: string[], group: string | null): Promise<Moved>;
  plan(id: string): Promise<GroupPlan>;
  remove(id: string, opts: DeleteChoice): Promise<GroupDeleted>;
  pagesInOrder(sort: Sort): Promise<Ranked[]>;
  groupsInOrder(sort: Sort): Promise<(Ranked & { group: Group })[]>;
}
export const groupService = (sql: Sql, env: PageEnv, tester: Tester, waitUntil: WaitUntil): GroupService => ({
  list: () => listGroups(sql, tester.id),
  create: (name, pageIds) => createGroup(sql, tester.id, name, pageIds),
  rename: (id, name) => renameGroup(sql, tester.id, id, name),
  move: (ids, group) => movePages(sql, tester.id, ids, group),
  plan: (id) => planDeleteGroup(sql, tester.id, id),
  remove: (id, opts) => deleteGroup(sql, env, waitUntil, tester.id, id, opts),
  pagesInOrder: (sort) => pagesInOrder(sql, tester.id, sort),
  groupsInOrder: (sort) => groupsInOrder(sql, tester.id, sort),
});
