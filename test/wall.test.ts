import postgres from 'postgres';
import { afterAll, expect, it } from 'vitest';
import { signIn } from '../src/signin.ts';
import { forgetEmail, pagePeople, rememberedEmails, renamePage, wallPages } from '../src/wall.ts';
import { addTester, adminEmails, api, callViewer, click, createPage, env, fileOf, getViewer, previewOf, publishedPage, signup, sql, stored, useCleanDatabase, viewerLogin } from './helpers.ts';

useCleanDatabase();

// The owner wall runs on the app's kind of connection (src/db.ts), so its queries are tried on one.
const app = postgres(process.env.DATABASE_URL!, { max: 1, fetch_types: false });
afterAll(() => app.end());

/** A workspace: its API key and its id. */
async function who(name: string) {
  const key = await addTester(name);
  const [{ id }] = await sql<{ id: number }[]>`select id from testers where name = ${name}`;
  return { key, id };
}

/** `count` visitors of the page on the day `ago` days before today. */
const visits = (page: string, ago: number, count: number) => sql`
  insert into page_visits (page, day, visitor)
  select ${page}::text, current_date - ${ago}::int, sha256(convert_to(${`${page} ${ago} `} || n::text, 'UTF8')) from generate_series(1, ${count}::int) n`;

/** A page published with approval; the emails in `letIn` are let in at once. Returns its id. */
async function approvalPage(key: string, title: string, letIn = ''): Promise<string> {
  const page = await createPage(key, title);
  expect((await click('publish', page.id, env, { access: 'approval', emails: letIn })).status).toBe(303);
  return page.id;
}

/** Whether a browser with this cookie gets the page in its frame at the public link, not the gate. */
const opens = async (id: string, cookie: string) => (await (await getViewer(`/${id}`, cookie)).text()).includes('<iframe');

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

it("counts each page's visitors per day, over the last 7 days and since it was published, for its owner's pages only", async () => {
  const amy = await who('amy');
  const bob = await who('bob');
  const mine = await publishedPage(amy.key, 'Mine');
  const old = await publishedPage(amy.key, 'Old');
  const draft = await createPage(amy.key, 'Draft');
  const gone = await publishedPage(amy.key, 'Gone');
  const theirs = await publishedPage(bob.key, 'Theirs');
  await sql`update pages set published_at = current_date - 3, updated_at = now() - interval '1 hour' where id = ${mine.id}`;
  await sql`update pages set published_at = current_date - 40, updated_at = now() - interval '2 hours' where id = ${old.id}`;
  for (const [page, ago, count] of [
    [mine.id, 0, 2],
    [mine.id, 1, 1],
    [mine.id, 2, 3],
    [mine.id, 3, 1],
    [mine.id, 4, 5],
    [mine.id, 8, 7],
    [old.id, 20, 2],
    [draft.id, 1, 2],
    [gone.id, 0, 4],
    [theirs.id, 0, 4],
  ] as const) {
    await visits(page, ago, count);
  }
  expect((await api(amy.key, 'DELETE', `/api/pages/${gone.id}`)).status).toBe(200);

  const pages = await wallPages(app, amy.id);
  expect(pages.map((page) => page.title)).toEqual(['Draft', 'Mine', 'Old']); // last changed first; neither the deleted page nor bob's is there
  expect(pages[0]).toMatchObject({ id: draft.id, published: false, total: 0 });
  expect(pages[0].thumb).toMatch(/^previews\//); // a draft has its screenshot too
  // Public since 3 days ago: the 4 days ago visits are in the bars but not in the total; the 8 days ago visits are in neither the bars nor the week.
  expect(pages[1]).toMatchObject({ id: mine.id, published: true, access: 'link', days: [0, 0, 5, 1, 3, 1, 2], week: 12, total: 7 });
  expect(pages[1].thumb).toMatch(/^previews\//);
  expect(pages[2]).toMatchObject({ id: old.id, days: [0, 0, 0, 0, 0, 0, 0], week: 0, total: 2 });
  expect(await wallPages(app, bob.id)).toMatchObject([{ id: theirs.id, days: [0, 0, 0, 0, 0, 0, 4], week: 4, total: 4 }]);
});

it("shows what the viewer counts: a visitor's open today, once per visitor, and never the owner's own", async () => {
  const amy = await who('amy');
  const page = await publishedPage(amy.key, 'Live');
  const frame = { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'same-origin', 'Campfile-Client-IP': '203.0.113.7', 'User-Agent': CHROME };
  await callViewer(`/${page.id}/raw`, undefined, { headers: frame });
  await callViewer(`/${page.id}/raw`, undefined, { headers: frame }); // a reload: the same visitor
  await callViewer(`/${page.id}/raw`, undefined, { headers: { ...frame, Cookie: await viewerLogin(amy.id) } }); // the owner
  expect(await wallPages(app, amy.id)).toMatchObject([{ id: page.id, days: [0, 0, 0, 0, 0, 0, 1], week: 1, total: 1 }]);
});

it("lists a page's people with waiting first, then approved, then told no, the latest change first in each group", async () => {
  const amy = await who('amy');
  const id = await approvalPage(amy.key, 'Plan');
  await sql`insert into page_people (page, email, status, created_at, decided_at) values
    (${id}, 'asked-early@example.com', 'waiting', now() - interval '3 days', null),
    (${id}, 'asked-late@example.com', 'waiting', now() - interval '1 hour', null),
    (${id}, 'approved-today@example.com', 'approved', now() - interval '5 days', now() - interval '2 hours'),
    (${id}, 'typed-yesterday@example.com', 'approved', now() - interval '1 day', null),
    (${id}, 'told-no@example.com', 'denied', now() - interval '1 day', now() - interval '1 day')`;
  expect((await pagePeople(app, id)).map((person) => `${person.status}: ${person.email.split('@')[0]}`)).toEqual([
    'waiting: asked-late',
    'waiting: asked-early',
    'approved: approved-today',
    'approved: typed-yesterday',
    'denied: told-no',
  ]);
  expect(await wallPages(app, amy.id)).toMatchObject([{ id, access: 'approval', published: true, waiting: 2, approved: 2 }]);
});

it('remembers every email the owner lets in, last let in first, and keeps it after Remove, Say no and deleting the page', async () => {
  const amy = await who('amy');
  const bob = await who('bob');
  const id = await approvalPage(amy.key, 'Plan', 'ann@example.com'); // let in as the page is published
  const letIn = (list: string) => api(amy.key, 'POST', `/api/pages/${id}/people`, { emails: list });
  const decide = (email: string, decision: string) => api(amy.key, 'POST', `/api/pages/${id}/people/decide`, { email, decision });
  const list = async () => (await rememberedEmails(app, amy.id)).map((remembered) => `${remembered.email.split('@')[0]}:${remembered.pages}`);

  expect((await letIn('bob@example.com')).status).toBe(200);
  expect((await letIn('cy@example.com')).status).toBe(200);
  await sql`insert into page_people (page, email, status) values (${id}, 'dee@example.com', 'waiting'), (${id}, 'eve@example.com', 'waiting')`;
  expect((await decide('eve@example.com', 'deny')).status).toBe(200);
  expect(await list()).toEqual(['cy:1', 'bob:1', 'ann:1']); // told no is not let in

  expect((await decide('dee@example.com', 'approve')).status).toBe(200);
  expect((await decide('eve@example.com', 'approve')).status).toBe(200); // the owner changes their mind
  expect(await list()).toEqual(['eve:1', 'dee:1', 'cy:1', 'bob:1', 'ann:1']);

  expect((await letIn('ann@example.com')).status).toBe(200); // let in again: back to the top
  expect(await list()).toEqual(['ann:1', 'eve:1', 'dee:1', 'cy:1', 'bob:1']);

  expect((await decide('bob@example.com', 'remove')).status).toBe(200);
  expect(await list()).toEqual(['ann:1', 'eve:1', 'dee:1', 'cy:1', 'bob:0']);

  expect((await api(amy.key, 'DELETE', `/api/pages/${id}`)).status).toBe(200);
  expect(await list()).toEqual(['ann:0', 'eve:0', 'dee:0', 'cy:0', 'bob:0']);
  expect(await rememberedEmails(app, bob.id)).toEqual([]); // each workspace has its own list
});

it('forgets an email without taking its access away, and says 0 pages lost it', async () => {
  const amy = await who('amy');
  const id = await approvalPage(amy.key, 'Plan', 'ann@example.com');
  const ann = await viewerLogin(await signIn(sql, 'ann@example.com', null, signup));
  expect(await opens(id, ann)).toBe(true);

  expect(await forgetEmail(app, amy.id, 'ann@example.com', false)).toBe(0);
  expect(await rememberedEmails(app, amy.id)).toEqual([]);
  expect(await opens(id, ann)).toBe(true);
  expect(await forgetEmail(app, amy.id, 'nobody@example.com', true)).toBe(0); // not on the list: nothing happens
});

it("forgets an email and takes its access from all the owner's pages, and nobody else's", async () => {
  const amy = await who('amy');
  const bob = await who('bob');
  const a = await approvalPage(amy.key, 'A', 'ann@example.com, cy@example.com');
  const b = await approvalPage(amy.key, 'B', 'ann@example.com');
  const c = await approvalPage(amy.key, 'C');
  const e = await approvalPage(amy.key, 'E');
  const d = await approvalPage(bob.key, 'D', 'ann@example.com');
  await sql`insert into page_people (page, email, status) values (${c}, 'ann@example.com', 'waiting'), (${e}, 'ann@example.com', 'denied')`;
  const ann = await viewerLogin(await signIn(sql, 'ann@example.com', null, signup));
  expect(await opens(a, ann)).toBe(true);

  expect(await forgetEmail(app, amy.id, 'ann@example.com', true)).toBe(2);
  const left = await sql<{ page: string; status: string }[]>`select page, status from page_people where email = 'ann@example.com'`;
  // Waiting and told no are not access: they stay, so a no still stops her asking again.
  expect(Object.fromEntries(left.map((row) => [row.page, row.status]))).toEqual({ [c]: 'waiting', [d]: 'approved', [e]: 'denied' });
  expect(await opens(a, ann)).toBe(false);
  expect(await opens(b, ann)).toBe(false);
  expect(await opens(d, ann)).toBe(true);
  expect((await rememberedEmails(app, amy.id)).map((remembered) => remembered.email)).toEqual(['cy@example.com']);
  expect((await rememberedEmails(app, bob.id)).map((remembered) => remembered.email)).toEqual(['ann@example.com']);
});

it('renames a page by its title only: its file, link preview and stored files stay, and only its owner can', async () => {
  const amy = await who('amy');
  const bob = await who('bob');
  const page = await publishedPage(amy.key, 'Old name', '<p>hello</p>');
  const hidden = await createPage(amy.key, 'Hidden');
  await sql`update pages set status = 'hidden' where id = ${hidden.id}`;
  const before = { file: await fileOf(page.id), preview: await previewOf(page.id), stored: stored('') };
  const work: Promise<unknown>[] = [];
  const rename = (tester: number, id: string, title: unknown) => renamePage(app, env, (promise) => work.push(promise), tester, id, title);
  const refused = (promise: Promise<unknown>) => promise.then(() => 'renamed', (error: Error & { status: number }) => `${error.status} ${error.message}`);
  const titleOf = async () => (await sql<{ title: string }[]>`select title from pages where id = ${page.id}`)[0].title;

  expect(await rename(amy.id, page.id, '  New name  ')).toBe('New name');
  expect(await titleOf()).toBe('New name');
  expect(await (await callViewer(`/${page.id}`)).text()).toContain('<title>New name</title>');
  expect({ file: await fileOf(page.id), preview: await previewOf(page.id), stored: stored('') }).toEqual(before);

  const noPage = /^404 No page with that id was found among your pages/;
  expect(await refused(rename(bob.id, page.id, 'Mine now'))).toMatch(noPage);
  expect(await refused(rename(amy.id, 'ZZZZZZZZ', 'Nothing'))).toMatch(noPage);
  expect(await refused(rename(amy.id, hidden.id, 'Back'))).toMatch(noPage);
  expect(await refused(rename(amy.id, page.id, ''))).toBe('400 The title must not be empty.');
  expect(await refused(rename(amy.id, page.id, '   '))).toBe('400 The title must not be empty.');
  expect(await refused(rename(amy.id, page.id, 'x'.repeat(201)))).toBe('400 The title must be 200 characters or fewer.');
  expect(await refused(rename(amy.id, page.id, 42))).toBe('400 The title must be text.');
  expect(await titleOf()).toBe('New name');
  expect(await rename(amy.id, page.id, 'x'.repeat(200))).toHaveLength(200);
  await Promise.all(work);
});

it('lets the app role read and write the remembered emails', async () => {
  const [{ ok }] = await sql<{ ok: boolean }[]>`
    select bool_and(has_table_privilege('campfile_app', 'remembered_emails', privilege)) as ok from unnest(array['select', 'insert', 'update', 'delete']) as privilege`;
  expect(ok).toBe(true);
});
