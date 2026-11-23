import { expect, it, vi } from 'vitest';
import { MAX_READ_CHARS } from '../src/pages.ts';
import { addTester, callViewer, click, env, fileOf, files, json, mcp, served, sortSeed, sql, stored, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

/** tools/call through the connector; returns the JSON-RPC result. */
async function call(key: string, name: string, args: object) {
  const response = await mcp(key, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  expect(response.status).toBe(200);
  return (await json(response)).result;
}

it('lists pages and groups in each of the wall’s orders, with the number a count order sorted by', async () => {
  const key = await addTester('amy');
  const { a, b, c, d, e, g12, g2 } = await sortSeed(key);
  const list = async (tool: 'list_pages' | 'list_groups', args: object) => JSON.parse((await call(key, tool, args)).content[0].text)[tool === 'list_pages' ? 'pages' : 'groups'];
  const ids = (items: { id: string }[]) => items.map((item) => item.id);
  const expected = {
    changed: [[c, a, d, b, e], [g12, g2]],
    added: [[d, c, b, a, e], [g2, g12]],
    name: [[e, c, b, a, d], [g2, g12]], // "Apple", "Draft", "round 2", "round 12", "Zed"; "Group 2" before "Group 12"
    visitors: [[e, a, d, b, c], [g12, g2]],
    people: [[b, c, a, d, e], [g2, g12]],
  };
  for (const [sort, [pages, groups]] of Object.entries(expected)) {
    expect(ids(await list('list_pages', { sort })), sort).toEqual(pages);
    expect(ids(await list('list_groups', { sort })), sort).toEqual(groups);
  }
  expect(ids(await list('list_pages', {}))).toEqual(expected.changed[0]); // without sort: last updated first, as before
  expect(ids(await list('list_pages', { group: g2, sort: 'name' }))).toEqual([c, b]); // within the group asked for

  expect((await list('list_pages', { sort: 'visitors' })).map((page: { visitors_this_week: number }) => page.visitors_this_week)).toEqual([5, 3, 2, 1, 0]);
  expect((await list('list_groups', { sort: 'visitors' })).map((group: { visitors_this_week: number }) => group.visitors_this_week)).toEqual([3, 1]);
  expect((await list('list_pages', { sort: 'people' })).map((page: { people_let_in: number }) => page.people_let_in)).toEqual([2, 0, 0, 0, 0]);
  expect((await list('list_groups', { sort: 'people' })).map((group: { people_let_in: number }) => group.people_let_in)).toEqual([2, 0]);
  const created = new Map((await sql<{ id: string; created_at: Date }[]>`select id, created_at from page_groups union all select id, created_at from pages`).map((row) => [row.id, row.created_at.toISOString()]));
  for (const tool of ['list_pages', 'list_groups'] as const) {
    const added = await list(tool, { sort: 'added' });
    expect(added.map((item: { added_at: string }) => item.added_at), tool).toEqual(added.map((item: { id: string }) => created.get(item.id)));
  }
  expect((await list('list_pages', { sort: 'name' }))[0]).not.toHaveProperty('visitors_this_week');
  expect((await call(key, 'list_pages', { sort: 'size' })).isError).toBe(true);
});

it('works through the MCP tools: initialize, create a draft, the user publishes it on its page, view, list, update, delete', async () => {
  const key = await addTester('amy');

  const init = await mcp(key, initialize);
  expect(init.status).toBe(200);
  expect(init.headers.get('content-type')).toContain('application/json');
  expect((await json(init)).result.serverInfo.name).toBe('campfile');

  const tools = (await json(await mcp(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }))).result.tools;
  expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
    'clear_sharing', 'create_group', 'create_page', 'decide_person', 'delete_group', 'delete_page', 'edit_page', 'find_in_page', 'get_page', 'get_sharing', 'let_people_in', 'list_groups', 'list_pages', 'list_people', 'move_pages', 'publish_page', 'rename_group', 'unpublish_page', 'update_page', 'who_am_i',
  ]); // everything the owner can do on the page and the wall
  // Claude's and ChatGPT's directories reject a tool without a title and explicit hints; only the read and list tools may run without asking.
  for (const tool of tools) {
    expect(tool.title, tool.name).toBeTruthy();
    expect(Object.values(tool.annotations ?? {}).filter((hint) => typeof hint === 'boolean'), tool.name).toHaveLength(3);
  }
  expect(tools.filter((tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint).map((tool: { name: string }) => tool.name).sort()).toEqual(['find_in_page', 'get_page', 'get_sharing', 'list_groups', 'list_pages', 'list_people', 'who_am_i']);

  const created = await call(key, 'create_page', { title: 'Hi', html: '<h1>Hi</h1>' });
  expect(created.isError).toBeUndefined();
  const { id, url, published } = JSON.parse(created.content[0].text);
  expect(url).toBe(`https://view.test/${id}`);
  expect(published).toBe(false);
  expect((await callViewer(`/${id}/raw`)).status).toBe(404); // a draft is not public
  expect((await callViewer(`/${id}/preview.jpg`)).status).toBe(404); // and has no link preview
  expect(JSON.parse((await call(key, 'get_page', { id })).content[0].text)).toMatchObject({ id, published: false, html: '<h1>Hi</h1>' }); // the owner's AI reads its draft

  expect((await click('publish', id)).status).toBe(303); // the user's click on the preview page
  expect(await (await callViewer(`/${id}/raw`)).text()).toBe(served('<h1>Hi</h1>'));
  expect(stored('previews/')).toHaveLength(1); // publishing makes the link preview

  const listed = JSON.parse((await call(key, 'list_pages', {})).content[0].text);
  expect(listed.pages).toMatchObject([{ id, title: 'Hi', url, published: true }]);

  const updated = JSON.parse((await call(key, 'update_page', { id, html: '<h1>Bye</h1>' })).content[0].text);
  expect(updated).toEqual({ id, url, published: true });
  expect(await (await callViewer(`/${id}/raw`)).text()).toBe(served('<h1>Bye</h1>'));

  const file = await fileOf(id);
  const plan = await call(key, 'delete_page', { ids: [id] }); // no confirm: the plan comes back, nothing is deleted
  expect(plan.isError).toBeUndefined();
  expect(JSON.parse(plan.content[0].text)).toMatchObject({ pages: [{ id, title: 'Hi', published: true }], count: 1, published: 1 });
  expect(files.has(file)).toBe(true);
  const deleted = await call(key, 'delete_page', { ids: [id], confirm: 'delete' });
  expect(deleted.isError).toBeUndefined();
  expect(JSON.parse(deleted.content[0].text)).toEqual({ deleted: [{ id, title: 'Hi' }], count: 1 });
  expect(files.has(file)).toBe(false);
  expect(files.size).toBe(0); // the preview went with the page
  expect(await sql`select id from pages`).toHaveLength(0);
});

it('plans a delete first: without confirm nothing goes, a published page needs the typed word, then all go', async () => {
  const key = await addTester('amy');
  const { id: draft } = JSON.parse((await call(key, 'create_page', { title: 'Notes', html: '<p>notes</p>' })).content[0].text);
  const { id: live } = JSON.parse((await call(key, 'create_page', { title: 'Zoo guide', html: '<p>zoo</p>' })).content[0].text);
  await click('publish', live);
  const ids = [live, draft]; // neither the order made nor by title
  const pagesLeft = async () => (await sql`select id from pages`).length;

  const plan = await call(key, 'delete_page', { ids }); // the user only asked: the answer is what would go and the reply that confirms
  expect(plan.isError).toBeUndefined();
  const planned = JSON.parse(plan.content[0].text);
  expect(planned).toMatchObject({ count: 2, published: 1, needs: 'delete' });
  expect(planned.pages).toEqual([{ id: live, title: 'Zoo guide', published: true }, { id: draft, title: 'Notes', published: false }]); // the order asked
  expect(await pagesLeft()).toBe(2);

  const refused = await call(key, 'delete_page', { ids, confirm: 'yes' }); // "yes" is not the word for a published page
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain('Nothing was deleted. “Zoo guide” is published');
  expect(JSON.parse((await call(key, 'delete_page', { ids, confirm: '  ' })).content[0].text)).toHaveProperty('needs'); // a blank confirm is no confirm: the plan again
  expect(await pagesLeft()).toBe(2); // the draft stayed too

  const deleted = JSON.parse((await call(key, 'delete_page', { ids, confirm: 'Delete.' })).content[0].text);
  expect(deleted.count).toBe(2);
  expect(deleted.deleted.map((page: { title: string }) => page.title)).toEqual(['Zoo guide', 'Notes']); // the order asked
  expect(await pagesLeft()).toBe(0);
});

it('deletes drafts only on a plain yes: "no" or a hedged reply deletes nothing', async () => {
  const key = await addTester('amy');
  const { id } = JSON.parse((await call(key, 'create_page', { title: 'Notes', html: '<p>notes</p>' })).content[0].text);
  expect(JSON.parse((await call(key, 'delete_page', { ids: [id, 'zzzzzzzz'] })).content[0].text)).toMatchObject({ count: 1, published: 0, needs: 'yes', missing: ['zzzzzzzz'] }); // a gone page doesn't block the plan for the rest
  for (const confirm of ['no', "no, don't", 'yes, but not that one', 'yes 2', 'delete 2', 'ok?', 'yes？', 'yes﹖', 'yes ⸮', 'yes ❓', '¿sí', 'yes…', 'ok...', 'yes . . .', 'delete‥', 'yes⋯', 'yes。。。', 'yes..', 'yes 🤔', 'delete｡｡', 'yes⋮', 'yes···', 'yes・・・', 'delete,,,', 'yes、、', 'yes•••', 'yes⋅⋅⋅', 'yes⁝', 'yes⁞', 'yes᠁', 'yes，，', 'yes،،', 'delete･･･', 'yes､､､', 'yes∙∙∙', 'yes‧‧‧', 'yes।।।', 'yes۔۔۔', 'yes॥॥', 'yes၊၊', 'yes။။', 'yes։։', 'yes᠃᠃', 'yes።።', 'yes។។', 'yes⸱⸱', 'yes∶∶']) {
    const refused = await call(key, 'delete_page', { ids: [id], confirm });
    expect(refused.isError, confirm).toBe(true);
    expect(refused.content[0].text).toContain('Nothing was deleted');
  }
  expect((await sql`select id from pages`).length).toBe(1);
  expect(JSON.parse((await call(key, 'delete_page', { ids: [id], confirm: 'Yes. Delete them.' })).content[0].text).count).toBe(1);
  for (const confirm of ['Yes, of course.', "Yes, I'm sure.", 'Ja، bitte', 'Oui、bien sûr']) {
    const { id: next } = JSON.parse((await call(key, 'create_page', { title: 'More', html: '<p>more</p>' })).content[0].text);
    expect(JSON.parse((await call(key, 'delete_page', { ids: [next], confirm })).content[0].text).count, confirm).toBe(1);
  }
});

it('caps a delete at 1,000 pages, a repeated id counted once, in words the AI can act on', async () => {
  const key = await addTester('amy');
  const { id } = JSON.parse((await call(key, 'create_page', { title: 'Notes', html: '<p>notes</p>' })).content[0].text);
  expect(JSON.parse((await call(key, 'delete_page', { ids: Array(1001).fill(id) })).content[0].text)).toMatchObject({ count: 1, needs: 'yes' });
  const many = Array.from({ length: 1001 }, (_, n) => `z${n.toString().padStart(7, '0')}`);
  const refused = await call(key, 'delete_page', { ids: many });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toBe('Nothing was deleted: at most 1,000 pages at a time. Delete them in batches of up to 1,000, each confirmed on its own.');
});

it('never deletes a page that a publish in between made public: the delete waits for the publish and sees it', async () => {
  const key = await addTester('amy');
  const { id } = JSON.parse((await call(key, 'create_page', { title: 'Race', html: '<p>x</p>' })).content[0].text);
  let deleting: Promise<{ isError?: boolean; content: { text: string }[] }> | undefined;
  await sql.begin(async (tx) => {
    await tx`select id from pages where id = ${id} for update`; // a publish holding the row
    deleting = call(key, 'delete_page', { ids: [id], confirm: 'yes' }); // a "yes" for a draft
    // Until the delete waits on this row lock: without its own lock it would have read "draft" and be waiting only at its DELETE.
    // Asked on this transaction's connection (the test pool has two); a transaction keeps its first view of pg_stat_activity unless cleared.
    const waiting = async () => (await tx`select pg_stat_clear_snapshot()`, (await tx`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`).length > 0);
    for (const until = Date.now() + 10_000; !(await waiting()); ) {
      if (Date.now() > until) throw new Error('the delete never waited for the lock');
      await new Promise((done) => setTimeout(done, 25));
    }
    await tx`update pages set published_at = now() where id = ${id}`;
  });
  const refused = await deleting!;
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain('is published');
  expect((await sql`select id from pages where id = ${id}`).length).toBe(1);
}, 15_000); // a few slow queries while it polls for the lock: its own message, not vitest's 5 s timeout
it('keeps a get_page result within budget once quotes and newlines are escaped, with the warning before the html', async () => {
  const key = await addTester('amy');
  const html = '<p class="a">\n'.repeat(MAX_READ_CHARS / 10); // 140,000 characters, each line 4 longer as JSON
  const { id } = JSON.parse((await call(key, 'create_page', { title: 'Quotes', html })).content[0].text);
  const text: string = (await call(key, 'get_page', { id })).content[0].text;
  const read = JSON.parse(text);
  const jsonLength = (text: string) => JSON.stringify(text).length - 2;
  expect(html.startsWith(read.html)).toBe(true);
  expect(jsonLength(read.html)).toBeLessThanOrEqual(MAX_READ_CHARS);
  expect(jsonLength(html.slice(0, read.html.length + 1))).toBeGreaterThan(MAX_READ_CHARS); // the longest prefix that fits
  expect(read.truncated).toBe(true);
  expect(text.indexOf('"note"')).toBeLessThan(text.indexOf('"html"'));

  // A run of quotes after a short start: half of it still fits.
  await call(key, 'update_page', { id, html: `<p>${'"'.repeat(MAX_READ_CHARS)}</p>` });
  expect(JSON.parse((await call(key, 'get_page', { id })).content[0].text).html).toBe(`<p>${'"'.repeat(MAX_READ_CHARS / 2 - 2)}`);

  const fits = '"'.repeat(MAX_READ_CHARS / 2); // exactly MAX_READ_CHARS as JSON: whole, no warning
  await call(key, 'update_page', { id, html: fits });
  const whole = JSON.parse((await call(key, 'get_page', { id })).content[0].text);
  expect(whole.html).toBe(fits);
  expect(whole.truncated).toBeUndefined();
});

it('publishes, lets people in and unpublishes through tools, as the user asks', async () => {
  const key = await addTester('amy');
  const { id, url } = JSON.parse((await call(key, 'create_page', { title: 'Hi', html: '<h1>Hi</h1>' })).content[0].text);

  const published = JSON.parse((await call(key, 'publish_page', { id, access: 'approval', emails: 'ingrid@example.com' })).content[0].text);
  expect(published).toMatchObject({ id, url, published: true, access: 'approval', public_link_works: true });
  await call(key, 'let_people_in', { id, emails: 'omar@example.com' });
  await call(key, 'decide_person', { id, email: 'ingrid@example.com', decision: 'deny' });
  const { people } = JSON.parse((await call(key, 'list_people', { id })).content[0].text);
  expect(people.map((person: { email: string; status: string }) => `${person.email} ${person.status}`).sort()).toEqual(['ingrid@example.com denied', 'omar@example.com approved']);

  expect(JSON.parse((await call(key, 'unpublish_page', { id })).content[0].text)).toMatchObject({ published: false });
  expect((await callViewer(`/${id}/raw`)).status).toBe(404);
});

it('edits parts of a page in order, all or nothing, only for its owner', async () => {
  const amy = await addTester('amy');
  const bob = await addTester('bob');
  const { id } = JSON.parse((await call(amy, 'create_page', { title: 'Hi', html: '<p>one two</p><p>two</p>' })).content[0].text);
  await click('publish', id);
  const page = async () => (await callViewer(`/${id}/raw`)).text();

  const error = async (key: string, edits: object[]) => {
    const result = await call(key, 'edit_page', { id, edits });
    expect(result.isError).toBe(true);
    return result.content[0].text;
  };
  expect(await error(amy, [{ old: 'one', new: 'ONE' }, { old: 'three', new: '3' }])).toContain('Edit 2: its "old" text is not in the page');
  expect(await error(amy, [{ old: 'two', new: '2' }])).toContain('more than once');
  expect(await error(bob, [{ old: 'one', new: 'bob' }])).toContain('No page with that id');
  expect(await page()).toBe(served('<p>one two</p><p>two</p>')); // no failed call changed anything

  // The second edit sees the first: "ONE two" is only there after it.
  const edited = await call(amy, 'edit_page', { id, edits: [{ old: 'one', new: 'ONE' }, { old: 'ONE two', new: 'done' }], title: 'New' });
  expect(JSON.parse(edited.content[0].text)).toMatchObject({ id, published: true, replaced: [1, 1] });
  expect(await page()).toBe(served('<p>done</p><p>two</p>'));
  expect(JSON.parse((await call(amy, 'get_page', { id })).content[0].text)).toMatchObject({ title: 'New' });

  // "all" renames every place, and only then; the count saves reading the page back.
  await call(amy, 'update_page', { id, html: '<p>cat</p><p>cat cat</p><p>dog</p>' });
  const renamed = await call(amy, 'edit_page', { id, edits: [{ old: 'cat', new: 'cow', all: true }, { old: 'dog', new: 'pig', all: true }] });
  expect(JSON.parse(renamed.content[0].text).replaced).toEqual([3, 1]);
  expect(await page()).toBe(served('<p>cow</p><p>cow cow</p><p>pig</p>'));

  // A short "old" everywhere times a long "new" (10,000 × 100,000 characters, past the longest string JavaScript can build) is refused before it is built, and changes nothing.
  const many = 'a'.repeat(10_000);
  await call(amy, 'update_page', { id, html: many });
  expect(await error(amy, [{ old: 'a', new: 'b'.repeat(100_000), all: true }])).toContain('This page is too big');
  expect(await page()).toBe(served(many));

  // Overlaps count: in "aaa", "aa" is in two places, so one edit without "all" is refused.
  await call(amy, 'update_page', { id, html: '<p>aaa</p>' });
  expect(await error(amy, [{ old: 'aa', new: 'b' }])).toContain('more than once');
  expect(await page()).toBe(served('<p>aaa</p>'));
});

it('finds text in a page with its line and the exact text around it, past the get_page cut, only for its owner', async () => {
  const amy = await addTester('amy');
  const bob = await addTester('bob');
  const html = `<p>start</p>\n${'x'.repeat(MAX_READ_CHARS)}\n${'<b>hit</b>\n'.repeat(25)}`;
  const { id } = JSON.parse((await call(amy, 'create_page', { title: 'Long', html })).content[0].text);
  const find = async (key: string, text: string) => (await call(key, 'find_in_page', { id, text })).content[0].text;

  const found = JSON.parse(await find(amy, '<b>hit</b>'));
  expect(found.count).toBe(25);
  expect(found.matches).toHaveLength(20); // only the first 20 are shown
  expect(found.matches[0]).toEqual({ line: 3, snippet: `${'x'.repeat(79)}\n<b>hit</b>\n${'<b>hit</b>\n'.repeat(7)}<b` }); // 80 characters on either side
  expect(found.matches[19].line).toBe(22);
  expect(html).toContain(found.matches[0].snippet); // usable as an edit_page "old" as it is
  expect(JSON.parse(await find(amy, 'start')).matches).toEqual([{ line: 1, snippet: `<p>start</p>\n${'x'.repeat(75)}` }]);
  expect(JSON.parse(await find(amy, 'missing'))).toEqual({ count: 0, matches: [] });
  expect(await find(bob, 'start')).toContain('No page with that id');
});

it('hands service errors to the AI as tool errors it can relay', async () => {
  const amy = await addTester('amy');
  const bob = await addTester('bob');
  const { id } = JSON.parse((await call(amy, 'create_page', { title: 'Amy', html: '<p>amy</p>' })).content[0].text);
  await click('publish', id);

  const result = await call(bob, 'update_page', { id, html: '<p>bob</p>' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('No page with that id');
  expect(await (await callViewer(`/${id}/raw`)).text()).toBe(served('<p>amy</p>'));
});

it('groups pages through tools: create into a group, list by group, move, rename, and delete a group with its pages only on the typed word', async () => {
  const amy = await addTester('amy');
  const bob = await addTester('bob');
  const body = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);
  const group = body(await call(amy, 'create_group', { name: 'Review of the plan' }));
  expect(group).toMatchObject({ name: 'Review of the plan', pages: 0, published: 0 });

  const round1 = body(await call(amy, 'create_page', { title: 'Round 1', html: '<p>1</p>', group: group.id }));
  expect(round1.group).toEqual({ id: group.id, name: 'Review of the plan' });
  const round2 = body(await call(amy, 'create_page', { title: 'Round 2', html: '<p>2</p>', group: group.id }));
  const loose = body(await call(amy, 'create_page', { title: 'Loose', html: '<p>x</p>', group: null })); // null: no group, as move_pages says it
  expect(loose.group).toBeNull();
  expect((await call(amy, 'create_page', { title: 'Lost', html: '<p>x</p>', group: 'none' })).content[0].text).toContain('leave group out (not "none"). Nothing was created.');
  expect((await sql`select writes from testers where name = 'amy'`)[0].writes).toBe(3); // the refused one counted no write
  expect((await call(bob, 'create_page', { title: 'Bob', html: '<p>b</p>', group: group.id })).content[0].text).toContain('No group with that id'); // not bob's group
  await click('publish', round1.id);

  expect(body(await call(amy, 'list_groups', {})).groups).toMatchObject([{ id: group.id, pages: 2, published: 1 }]);
  expect(body(await call(amy, 'list_pages', { group: group.id })).pages.map((page: { title: string }) => page.title).sort()).toEqual(['Round 1', 'Round 2']);
  expect(body(await call(amy, 'list_pages', { group: 'none' })).pages).toMatchObject([{ id: loose.id, group: null }]);
  expect(body(await call(amy, 'list_pages', { group: null })).pages).toHaveLength(3);
  expect(body(await call(amy, 'get_page', { id: round2.id })).group).toEqual({ id: group.id, name: 'Review of the plan' });
  expect((await call(bob, 'list_pages', { group: group.id })).content[0].text).toContain('No group with that id');

  expect(body(await call(amy, 'move_pages', { ids: [loose.id], group: group.id }))).toMatchObject({ moved: [{ id: loose.id, title: 'Loose' }], group: { pages: 3 } });
  expect(body(await call(amy, 'move_pages', { ids: [loose.id], group: null }))).toEqual({ moved: [{ id: loose.id, title: 'Loose' }], group: null });
  expect((await call(amy, 'move_pages', { ids: [loose.id], group: 'none' })).content[0].text).toContain('send group as null (not "none"). Nothing was moved.');
  expect(body(await call(amy, 'rename_group', { id: group.id, name: 'Plan review' })).name).toBe('Plan review');
  expect((await call(bob, 'rename_group', { id: group.id, name: 'Mine' })).content[0].text).toContain('No group with that id');

  // With its pages: the plan first, deleting nothing; "yes" is not the word for a published page; the refused delete keeps the group too.
  expect((await call(amy, 'delete_group', { id: 'none', delete_pages: true })).content[0].text).toContain('No group with that id');
  for (const stray of [{ confirm: 'delete' }, { confirm: '' }, { confirm: '   ' }, { ids: [loose.id] }]) {
    expect((await call(amy, 'delete_group', { id: group.id, ...stray })).content[0].text, JSON.stringify(stray)).toContain('confirm and ids are only for delete_pages: true');
  }
  expect(await sql`select id from page_groups`).toHaveLength(1);
  const plan = body(await call(amy, 'delete_group', { id: group.id, delete_pages: true }));
  expect(plan).toMatchObject({ count: 2, published: 1, needs: 'delete', group: { id: group.id, name: 'Plan review' } });
  const ids = plan.pages.map((page: { id: string }) => page.id);
  const refused = await call(amy, 'delete_group', { id: group.id, delete_pages: true, confirm: 'yes', ids });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain('“Round 1” is published');
  expect((await call(amy, 'delete_group', { id: group.id, delete_pages: true, confirm: 'yes, but keep one', ids })).content[0].text).toContain('move those out with move_pages first');
  expect((await call(amy, 'delete_group', { id: group.id, delete_pages: true, confirm: 'delete' })).content[0].text).toContain('ids is needed with confirm');
  // A page moved in after the plan: the user was not asked about it, so nothing goes.
  await call(amy, 'move_pages', { ids: [loose.id], group: group.id });
  expect((await call(amy, 'delete_group', { id: group.id, delete_pages: true, confirm: 'delete', ids })).content[0].text).toContain("The group's pages changed since the plan, so nothing was deleted.");
  expect(await sql`select id from page_groups`).toHaveLength(1);
  expect(await sql`select id from pages`).toHaveLength(3);
  await call(amy, 'move_pages', { ids: [loose.id], group: null });

  const deleted = body(await call(amy, 'delete_group', { id: group.id, delete_pages: true, confirm: 'delete', ids }));
  expect(deleted).toMatchObject({ name: 'Plan review', kept: 0 });
  expect(deleted.deleted.map((page: { title: string }) => page.title).sort()).toEqual(['Round 1', 'Round 2']);
  expect(await sql`select title from pages`).toEqual([{ title: 'Loose' }]);
  expect(await sql`select id from page_groups`).toHaveLength(0);
});

it('deletes a group and keeps its pages, in no group, without asking for a word', async () => {
  const amy = await addTester('amy');
  const body = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);
  const { id: page } = body(await call(amy, 'create_page', { title: 'Proto', html: '<p>p</p>' }));
  await click('publish', page);
  const group = body(await call(amy, 'create_group', { name: 'Prototypes', page_ids: [page] }));
  expect(group.pages).toBe(1);
  expect(body(await call(amy, 'delete_group', { id: group.id }))).toEqual({ name: 'Prototypes', kept: 1, deleted: [] });
  expect(body(await call(amy, 'get_page', { id: page })).group).toBeNull();
  expect((await call(amy, 'delete_group', { id: group.id })).content[0].text).toContain('No group with that id');
});

it('does not show unexpected errors to the AI', async () => {
  const key = await addTester('amy');
  const brokenBucket = { ...env.PAGES, put: async () => Promise.reject(new Error('The bucket is down at 10.0.0.1')) };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const message = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_page', arguments: { title: 'x', html: '<p>x</p>' } } };
    const { result } = await json(await mcp(key, message, { ...env, PAGES: brokenBucket }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Something went wrong');
    expect(result.content[0].text).not.toContain('10.0.0.1');
  } finally {
    log.mockRestore();
  }
});
