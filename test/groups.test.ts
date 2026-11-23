import { expect, it } from 'vitest';
import type postgres from 'postgres';
import { createGroup, deleteGroup, GROUP_CHANGED, listGroups, MAX_GROUPS, movePages, planDeleteGroup, renameGroup } from '../src/groups.ts';
import { authenticate, pageService } from '../src/pages.ts';
import { addTester, api, createPage, env, json, publishedPage, sql, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

const waitUntil = () => {};
/** A tester with a key, and their id. */
async function tester(name: string) {
  const key = await addTester(name);
  return { key, id: (await authenticate(sql, key)).id };
}
const refusal = (work: Promise<unknown>) => work.then(() => 'no error', (error: Error & { status?: number }) => `${error.status} ${error.message}`);
const groupOf = async (id: string) => (await sql<{ group_id: string | null }[]>`select group_id from pages where id = ${id}`)[0].group_id;
/** Until another connection waits on a lock; asked on `tx`'s connection, its snapshot cleared each time (test/mcp.test.ts does the same). */
async function untilWaiting(tx: postgres.TransactionSql) {
  const waiting = async () => (await tx`select pg_stat_clear_snapshot()`, (await tx`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`).length > 0);
  for (const until = Date.now() + 10_000; !(await waiting()); ) {
    if (Date.now() > until) throw new Error('the delete never waited for the lock');
    await new Promise((done) => setTimeout(done, 25));
  }
}

it('keeps names to one trimmed line of 1 to 80 characters, unique per tester whatever the case', async () => {
  const amy = await tester('amy');
  const bob = await tester('bob');
  const plan = await createGroup(sql, amy.id, '  Plan review  ');
  expect(plan).toMatchObject({ name: 'Plan review', pages: 0, live: 0 });

  expect(await refusal(createGroup(sql, amy.id, '   '))).toBe('400 The group name must not be empty.');
  expect(await refusal(createGroup(sql, amy.id, 'x'.repeat(81)))).toBe('400 The group name must be 80 characters or fewer.');
  expect(await refusal(createGroup(sql, amy.id, 'one\ntwo'))).toBe('400 The group name must be one line, without tabs or line breaks.');
  expect(await refusal(createGroup(sql, amy.id, 42))).toBe('400 The group name must be text.');
  expect(await refusal(createGroup(sql, amy.id, 'PLAN REVIEW'))).toBe('400 You already have a group called “Plan review”. Choose another name, or use that group.'); // the group's own name, not the typed one
  expect((await createGroup(sql, bob.id, 'Plan review')).name).toBe('Plan review'); // another tester's names don't count

  const other = await createGroup(sql, amy.id, 'x'.repeat(80));
  expect(await refusal(renameGroup(sql, amy.id, other.id, 'plan review'))).toContain('400 You already have a group called “Plan review”');
  expect((await renameGroup(sql, amy.id, plan.id, 'PLAN review')).name).toBe('PLAN review'); // its own name in another case
  expect(await refusal(renameGroup(sql, bob.id, plan.id, 'Taken'))).toBe('404 No group with that id was found among your groups. List your groups to see their ids.');
  expect((await listGroups(sql, amy.id)).map((group) => group.name).sort()).toEqual(['PLAN review', 'x'.repeat(80)]);
});

it('caps a tester at 200 groups, unless their workspace is unlimited', async () => {
  const amy = await tester('amy');
  await sql`insert into page_groups (id, owner, name) select 'g' || n, ${amy.id}, 'Group ' || n from generate_series(1, ${MAX_GROUPS}) n`;
  expect(await refusal(createGroup(sql, amy.id, 'One more'))).toBe('403 You already have 200 groups, which is the limit. Delete one you no longer need, or use one you have.');
  await sql`update testers set unlimited = true where id = ${amy.id}`; // like the other per-tester limits
  expect((await createGroup(sql, amy.id, 'One more')).name).toBe('One more');
});

it('moves pages in and out, all or none, only the tester’s own live pages into the tester’s own groups', async () => {
  const amy = await tester('amy');
  const bob = await tester('bob');
  const [a, b] = [await createPage(amy.key, 'A'), await publishedPage(amy.key, 'B')];
  const bobs = await createPage(bob.key, 'Bob’s');
  const group = await createGroup(sql, amy.id, 'Round');
  const bobGroup = await createGroup(sql, bob.id, 'Bob’s group');

  expect(await refusal(movePages(sql, amy.id, [a.id, bobs.id], group.id))).toBe(`404 No page ${bobs.id} was found among your pages, so nothing was moved. List your pages to check their ids, then move again with only the ones that are there.`);
  expect(await refusal(movePages(sql, amy.id, [a.id], bobGroup.id))).toContain('404 No group with that id');
  expect(await refusal(movePages(sql, amy.id, [], group.id))).toBe('400 Choose the pages to move first.');
  expect(await groupOf(a.id)).toBeNull(); // nothing moved

  const moved = await movePages(sql, amy.id, [b.id, a.id, b.id], group.id);
  expect(moved.moved).toEqual([{ id: b.id, title: 'B' }, { id: a.id, title: 'A' }]); // the order asked, once each
  expect(moved.group).toMatchObject({ id: group.id, pages: 2, live: 1 });

  // A page taken down is no longer one of the tester's pages, and no longer counts.
  await sql`update pages set status = 'hidden' where id = ${b.id}`;
  expect((await listGroups(sql, amy.id))[0]).toMatchObject({ pages: 1, live: 0 });
  expect(await refusal(movePages(sql, amy.id, [b.id], null))).toContain(`404 No page ${b.id} was found`);

  expect(await movePages(sql, amy.id, [a.id], null)).toEqual({ moved: [{ id: a.id, title: 'A' }], group: null });
  expect(await groupOf(a.id)).toBeNull();
});

it('creates a group with pages in it, or with an id not the tester’s, no group at all', async () => {
  const amy = await tester('amy');
  const bob = await tester('bob');
  const a = await createPage(amy.key, 'A');
  const bobs = await createPage(bob.key, 'Bob’s');
  expect(await refusal(createGroup(sql, amy.id, 'Mixed', [a.id, bobs.id]))).toContain(`404 No page ${bobs.id} was found`);
  expect(await listGroups(sql, amy.id)).toEqual([]);
  expect(await groupOf(a.id)).toBeNull();

  const group = await createGroup(sql, amy.id, 'Mine', [a.id]);
  expect(group.pages).toBe(1);
  expect(await groupOf(a.id)).toBe(group.id);
});

it('lists the last changed group first: a rename, a move in or out, or an updated page in it counts', async () => {
  const amy = await tester('amy');
  const [a, b] = [await createPage(amy.key, 'A'), await createPage(amy.key, 'B')];
  const first = await createGroup(sql, amy.id, 'First', [a.id]);
  const second = await createGroup(sql, amy.id, 'Second');
  const order = async () => (await listGroups(sql, amy.id)).map((group) => group.name);
  const age = async () => {
    await sql`update page_groups set updated_at = now() - interval '1 day'`;
    await sql`update pages set updated_at = now() - interval '1 day'`;
  };

  await age();
  await sql`update pages set updated_at = now() where id = ${a.id}`; // its page changed
  expect(await order()).toEqual(['First', 'Second']);
  await age();
  await movePages(sql, amy.id, [b.id], second.id);
  expect(await order()).toEqual(['Second', 'First']);
  await age();
  await movePages(sql, amy.id, [a.id], null); // the group it left changed too
  expect(await order()).toEqual(['First', 'Second']);
  await age();
  await renameGroup(sql, amy.id, second.id, 'Renamed');
  expect(await order()).toEqual(['Renamed', 'First']);
  expect((await listGroups(sql, amy.id))[1].changed_at.getTime()).toBe((await sql`select updated_at from page_groups where id = ${first.id}`)[0].updated_at.getTime());
});

it('deletes a group keeping its pages, or with them only on the typed word when one is published; refused, the group stays', async () => {
  const amy = await tester('amy');
  const bob = await tester('bob');
  const [draft, live] = [await createPage(amy.key, 'Draft'), await publishedPage(amy.key, 'Live')];
  const group = await createGroup(sql, amy.id, 'Both', [draft.id, live.id]);
  const ids = [draft.id, live.id];
  const left = async () => (await sql<{ title: string }[]>`select title from pages order by title`).map((row) => row.title);

  expect(await refusal(deleteGroup(sql, env, waitUntil, bob.id, group.id, { pages: 'keep' }))).toContain('404 No group with that id');
  expect(await refusal(deleteGroup(sql, env, waitUntil, bob.id, group.id, { pages: 'delete', ids, confirm: 'delete' }))).toContain('404 No group with that id');
  expect(await refusal(planDeleteGroup(sql, bob.id, group.id))).toContain('404 No group with that id');
  expect(await refusal(deleteGroup(sql, env, waitUntil, amy.id, group.id, { pages: 'delete', ids }))).toContain('400 Nothing was deleted. “Live” is published');
  expect(await refusal(deleteGroup(sql, env, waitUntil, amy.id, group.id, { pages: 'delete', ids, confirm: 'yes, delete' }))).toContain('400 Nothing was deleted.');
  expect(await refusal(deleteGroup(sql, env, waitUntil, amy.id, group.id, { pages: 'delete', ids: [draft.id], confirm: 'delete' }))).toBe(`400 ${GROUP_CHANGED}`);
  expect(await left()).toEqual(['Draft', 'Live']);
  expect(await listGroups(sql, amy.id)).toHaveLength(1);

  const deleted = await deleteGroup(sql, env, waitUntil, amy.id, group.id, { pages: 'delete', ids, confirm: 'Delete.' });
  expect(deleted.name).toBe('Both');
  expect(deleted.deleted.map((page) => page.title).sort()).toEqual(['Draft', 'Live']);
  expect(await left()).toEqual([]);
  expect(await listGroups(sql, amy.id)).toEqual([]);

  const kept = await publishedPage(amy.key, 'Kept');
  const keepGroup = await createGroup(sql, amy.id, 'Keep', [kept.id]);
  expect(await deleteGroup(sql, env, waitUntil, amy.id, keepGroup.id, { pages: 'keep' })).toEqual({ name: 'Keep', kept: 1, deleted: [] });
  expect(await groupOf(kept.id)).toBeNull();
  // An empty group needs no word, with its pages or without.
  const empty = await createGroup(sql, amy.id, 'Empty');
  expect(await deleteGroup(sql, env, waitUntil, amy.id, empty.id, { pages: 'delete', ids: [] })).toEqual({ name: 'Empty', kept: 0, deleted: [] });
});

it('deletes nothing when a page moved out of the group while the group was being deleted with its pages', async () => {
  const amy = await tester('amy');
  const [stays, leaves] = [await createPage(amy.key, 'Stays'), await createPage(amy.key, 'Leaves')];
  const group = await createGroup(sql, amy.id, 'Round', [stays.id, leaves.id]);
  let deleting: Promise<unknown> | undefined;
  await sql.begin(async (tx) => {
    await tx`select id from pages where id = ${leaves.id} for update`; // a move out holding the row
    deleting = deleteGroup(sql, env, waitUntil, amy.id, group.id, { pages: 'delete', ids: [stays.id, leaves.id] }).catch((error: Error) => error.message);
    await untilWaiting(tx);
    await tx`update pages set group_id = null where id = ${leaves.id}`;
  });
  expect(await deleting).toBe(GROUP_CHANGED); // the user was asked about both, so neither goes
  expect(await sql`select title, group_id from pages order by title`).toEqual([{ title: 'Leaves', group_id: null }, { title: 'Stays', group_id: group.id }]);
}, 15_000); // a few slow queries while it polls for the lock

it('deletes nothing when a page moved into the group while the group was being deleted with its pages', async () => {
  const amy = await tester('amy');
  const [planned, arrives] = [await createPage(amy.key, 'Planned'), await createPage(amy.key, 'Arrives')];
  const group = await createGroup(sql, amy.id, 'Round', [planned.id]);
  let deleting: Promise<unknown> | undefined;
  await sql.begin(async (tx) => {
    await tx`select id from pages where id in ${sql([planned.id, arrives.id])} for update`; // a move of both into the group, holding them
    deleting = deleteGroup(sql, env, waitUntil, amy.id, group.id, { pages: 'delete', ids: [planned.id], confirm: 'yes' }).catch((error: Error) => error.message);
    await untilWaiting(tx);
    await tx`update pages set group_id = ${group.id} where id in ${sql([planned.id, arrives.id])}`;
  });
  expect(await deleting).toBe(GROUP_CHANGED); // the user was not asked about the one that arrived
  expect(await sql`select title, group_id from pages order by title`).toEqual([{ title: 'Arrives', group_id: group.id }, { title: 'Planned', group_id: group.id }]);
}, 15_000);

it('counts a page moved in while the group was being deleted, keeping its pages, as kept', async () => {
  const amy = await tester('amy');
  const arrives = await createPage(amy.key, 'Arrives');
  const group = await createGroup(sql, amy.id, 'Round');
  let deleting: Promise<unknown> | undefined;
  await sql.begin(async (tx) => {
    await tx`update pages set group_id = ${group.id} where id = ${arrives.id}`; // its foreign key check holds the group row
    deleting = deleteGroup(sql, env, waitUntil, amy.id, group.id, { pages: 'keep' });
    await untilWaiting(tx);
  });
  expect(await deleting).toEqual({ name: 'Round', kept: 1, deleted: [] });
  expect(await groupOf(arrives.id)).toBeNull();
}, 15_000);

it('creates the page in no group when the group’s delete commits while the page is being inserted', async () => {
  const amy = await tester('amy');
  const group = await createGroup(sql, amy.id, 'Going');
  const pages = pageService(sql, env, await authenticate(sql, amy.key), waitUntil);
  let creating: Promise<{ id: string; group: unknown }> | undefined;
  await sql.begin(async (tx) => {
    await tx`delete from page_groups where id = ${group.id}`; // a delete holding the group row
    creating = pages.create({ title: 'Late', html: '<p>late</p>', group: group.id });
    await untilWaiting(tx); // the insert's foreign key check waits on the deleted row
  });
  const page = await creating!;
  expect(page.group).toBeNull();
  expect(await sql`select title, group_id from pages where id = ${page.id}`).toEqual([{ title: 'Late', group_id: null }]);
  expect((await sql`select writes from testers where id = ${amy.id}`)[0].writes).toBe(1);
}, 15_000);

it('creates a page straight into one of the tester’s groups, and lists and reads each page with its group', async () => {
  const amy = await tester('amy');
  const bob = await tester('bob');
  const group = await createGroup(sql, amy.id, 'Prototypes');
  const pages = pageService(sql, env, await authenticate(sql, amy.key), waitUntil);
  const bobPages = pageService(sql, env, await authenticate(sql, bob.key), waitUntil);

  const page = await pages.create({ title: 'Proto 1', html: '<p>1</p>', group: group.id });
  expect(await refusal(bobPages.create({ title: 'Bob', html: '<p>b</p>', group: group.id }))).toContain('404 No group with that id');
  expect(await sql`select title from pages where owner = ${bob.id}`).toEqual([]); // and counted no write
  expect((await sql`select writes from testers where id = ${bob.id}`)[0].writes).toBe(0);

  const loose = await pages.create({ title: 'Loose', html: '<p>x</p>' });
  expect((await pages.get(page.id)).group).toEqual({ id: group.id, name: 'Prototypes' });
  expect((await pages.list()).pages.map((listed) => [listed.title, listed.group?.name ?? null])).toEqual([['Loose', null], ['Proto 1', 'Prototypes']]);
  expect((await pages.list(group.id)).pages.map((listed) => listed.id)).toEqual([page.id]);
  expect((await pages.list('none')).pages.map((listed) => listed.id)).toEqual([loose.id]);
  expect(await refusal(bobPages.list(group.id))).toContain('404 No group with that id');
});

it('serves groups over the HTTP API to the key’s own workspace only, as the connector does', async () => {
  const amy = await tester('amy');
  const bob = await tester('bob');
  const [a, b] = [await createPage(amy.key, 'Round 12'), await createPage(amy.key, 'Round 2')];

  expect((await api('nope', 'GET', '/api/groups')).status).toBe(401);
  const made = await api(amy.key, 'POST', '/api/groups', { name: 'Review', page_ids: [a.id] });
  expect(made.status).toBe(201);
  const group = await json(made);
  expect(group).toMatchObject({ name: 'Review', pages: 1, published: 0 });

  expect(await json(await api(amy.key, 'POST', '/api/pages/move', { ids: [b.id], group: group.id }))).toMatchObject({ moved: [{ id: b.id }], group: { id: group.id, pages: 2 } });
  expect((await api(amy.key, 'POST', '/api/pages/move', { ids: [b.id], group: 'none' })).status).toBe(400);
  expect((await api(bob.key, 'POST', '/api/pages/move', { ids: [b.id], group: null })).status).toBe(404);
  expect((await json(await api(amy.key, 'GET', `/api/pages?group=${group.id}&sort=name`))).pages.map((p: { title: string }) => p.title)).toEqual(['Round 2', 'Round 12']);
  expect((await api(amy.key, 'GET', '/api/pages?sort=newest')).status).toBe(400);

  expect((await api(bob.key, 'PUT', `/api/groups/${group.id}`, { name: 'Mine' })).status).toBe(404);
  expect(await json(await api(amy.key, 'PUT', `/api/groups/${group.id}`, { name: 'Review 2' }))).toMatchObject({ id: group.id, name: 'Review 2' });
  expect((await json(await api(bob.key, 'GET', '/api/groups'))).groups).toEqual([]);

  expect((await api(bob.key, 'DELETE', `/api/groups/${group.id}`)).status).toBe(404);
  expect((await api(amy.key, 'DELETE', `/api/groups/${group.id}`)).status).toBe(200);
  expect((await json(await api(amy.key, 'GET', '/api/groups'))).groups).toEqual([]);
  expect([await groupOf(a.id), await groupOf(b.id)]).toEqual([null, null]); // kept, in no group
});
