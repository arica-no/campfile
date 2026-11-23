import { expect, it } from 'vitest';
import { readSignedId, signedId } from '../src/keys.ts';
import { addTester, callApp, click, createPage, env, fakeBrowser, form, json, mcp, publishedPage, sessionCookie, SHOT, sortSeed, sql, stored, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

// docs/SPEC.md "Managing a page": the owner wall at /my (with the remembered emails' sheet at /my/emails), and a page's own view at /p/:id, with its panel at /p/:id/manage. Everything is a plain form, so a form post is what the browser sends.

/** A workspace with an email, and the Cookie header of a browser signed in to it. */
async function owner(name: string) {
  const key = await addTester(name);
  const [{ id }] = await sql<{ id: number }[]>`update testers set email = ${`${name}@example.com`} where name = ${name} returning id`;
  return { key, id, cookie: await sessionCookie(id) };
}

const get = (path: string, cookie = '') => callApp(path, { headers: { Cookie: cookie } });
const CROSS_SITE = { ...form, Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site' };
/** A form post; a field given a list is posted once per value, as ticked boxes are. */
const post = (path: string, cookie: string, fields: Record<string, string | string[]> = {}, headers: Record<string, string> = form) =>
  callApp(path, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: new URLSearchParams(Object.entries(fields).flatMap(([name, value]) => [value].flat().map((one): [string, string] => [name, one]))) });
const htmlOf = async (path: string, cookie: string) => (await get(path, cookie)).text();

const titleOf = async (id: string) => (await sql<{ title: string }[]>`select title from pages where id = ${id}`)[0]?.title;
const people = async (id: string) => sql<{ email: string; status: string }[]>`select email, status from page_people where page = ${id} order by email`;
const remembered = async (tester: number) => (await sql<{ email: string }[]>`select email from remembered_emails where owner = ${tester} order by email`).map((row) => row.email);
const snapshot = async () => JSON.stringify([await sql`select * from pages order by id`, await sql`select * from page_people order by id`, await sql`select * from remembered_emails order by owner, email`]);

it('sends a browser that is not signed in to the login, and back to where it was going', async () => {
  const amy = await owner('amy');
  const page = await createPage(amy.key);
  for (const path of ['/my', '/my/emails', `/p/${page.id}`, `/p/${page.id}/manage`]) {
    const response = await get(path);
    expect(response.status, path).toBe(303);
    expect(response.headers.get('location'), path).toBe(`/signin?next=${path}`);
  }
  expect((await get(`/p/${page.id}/thumb.jpg`)).status).toBe(404);
});

it("lists the signed-in owner's pages and nobody else's, each with its state; with none it shows how to make the first", async () => {
  const amy = await owner('amy');
  const bob = await owner('bob');
  expect(await htmlOf('/my', amy.cookie)).toContain('<section class="first">'); // no pages yet: the first-run steps

  const live = await publishedPage(amy.key, 'Amy live');
  const draft = await createPage(amy.key, 'Amy draft');
  await createPage(bob.key, 'Bob secret');
  const response = await get('/my', amy.cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(response.headers.get('cache-control')).toBe('no-store');
  const html = await response.text();
  expect(html).toContain('<script src="/manage.js" defer></script>');
  expect(html).toContain('2 pages · 1 published');
  expect(html).toContain(`href="/p/${live.id}"`); // a tile opens the page itself
  expect(html).toContain('<span class="lamp live">Published</span>');
  expect(html).toContain('<span class="lamp draft">Draft</span>');
  expect(html).toContain(`<img src="/p/${live.id}/thumb.jpg?v=`); // a live page and a draft each have a screenshot
  expect(html).toContain(`<img src="/p/${draft.id}/thumb.jpg?v=`);
  expect(html).toContain('Signed in as amy@example.com');
  expect(html).not.toContain('Bob secret');
});

it('shows the pages that are live, unpublished or asking, and the ones whose title has the word searched for', async () => {
  const amy = await owner('amy');
  const garden = await publishedPage(amy.key, 'Garden plan');
  const kitchen = await createPage(amy.key, 'Kitchen draft');
  const secret = await createPage(amy.key, 'Secret approval');
  await click('publish', secret.id, env, { access: 'approval' });
  await sql`insert into page_people (page, email, status) values (${secret.id}, 'ingrid@example.com', 'waiting')`;
  const shown = async (query: string) => {
    const html = await htmlOf(`/my${query}`, amy.cookie);
    return [garden, kitchen, secret].filter((page) => html.includes(`id="tile-${page.id}"`)).map((page) => page.id).sort();
  };

  expect(await shown('')).toEqual([garden.id, kitchen.id, secret.id].sort());
  expect(await shown('?show=live')).toEqual([garden.id, secret.id].sort());
  expect(await shown('?show=drafts')).toEqual([kitchen.id]);
  expect(await shown('?show=asking')).toEqual([secret.id]);
  expect(await shown('?q=GARDEN')).toEqual([garden.id]);
  expect(await shown('?show=live&q=kitchen')).toEqual([]);
  expect(await shown('?show=nonsense')).toHaveLength(3);

  const html = await htmlOf('/my?show=drafts', amy.cookie);
  expect(html).toContain('aria-current="true">Draft</a>');
  expect(html).toContain('1 of 3 pages shown');
  expect(await htmlOf('/my?q=zzz', amy.cookie)).toContain('No pages match.');
  expect(await htmlOf('/my', amy.cookie)).toContain('1 person asking');
});

it('shows one draft as the whole screen with Publish on it, and its picture and Open preview open the page, Details its panel, Delete its confirm dialog', async () => {
  const amy = await owner('amy');
  const draft = await createPage(amy.key, 'Only draft');
  const wall = await htmlOf('/my', amy.cookie);
  expect(wall).toContain(`<form class="pub" method="post" action="/p/${draft.id}/publish">`);
  expect(wall).toContain(`<a class="hero-pv" id="tile-${draft.id}" href="/p/${draft.id}"`);
  expect(wall).toContain(`<a class="btn ghost" href="/p/${draft.id}">Open preview</a>`);
  expect(wall).toContain(`<a class="btn quiet" href="/p/${draft.id}/manage">Details`); // Details is the panel
  expect(wall).toContain('<button class="btn quiet link-danger" type="button" commandfor="delete" command="show-modal">'); // a quiet Delete, as in the panel
  expect(wall).toContain(`<form method="post" action="/p/${draft.id}/delete" data-plain>`);
  expect(wall).toContain('Are you sure? Its <span class="nw">how-it-spread</span> tree and people list go too. This can’t be undone.'); // the phrase never breaks at its hyphens
  expect(wall).not.toContain('name="confirm"'); // a draft needs no word
});

it("shows a page as the owner's page view: the bar, the page in a frame with the owner's ticket, and the panel closed until Manage opens it", async () => {
  const amy = await owner('amy');
  const live = await publishedPage(amy.key, 'Amy live');
  const draft = await createPage(amy.key, 'Amy draft');

  const response = await get(`/p/${live.id}`, amy.cookie);
  expect(response.status).toBe(200);
  const csp = response.headers.get('content-security-policy')!;
  expect(csp).toContain(`frame-src ${env.VIEWER_ORIGIN}`);
  expect(csp).toContain("frame-ancestors 'none'");
  const html = await response.text();
  expect(html).toContain('<title>Amy live · Campfile</title>');
  expect(html).toContain('<body class="pv-screen">'); // no slide: nothing was opened from here
  expect(html).toContain('<div id="page">');
  expect(html).toContain('<div id="panel" hidden>');
  expect(html).toContain(`href="/my#tile-${live.id}" aria-label="Back to your pages"`);
  expect(html).toContain('<span class="state live"');
  expect(html).toContain('<span class="acc">Anyone with the link</span>'); // who can open it, beside the lamp
  expect(html).toContain(`data-copy="${env.VIEWER_ORIGIN}/${live.id}"`); // the public link
  expect(html).toContain(`<a class="primary manage" href="/p/${live.id}/manage" aria-label="Manage: who can open it, unpublish, delete"`); // Delete is in the panel, so the button says so
  const frame = new RegExp(`<iframe class="page" [^>]*sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="${env.VIEWER_ORIGIN}/${live.id}/raw\\?t=([^"]+)"`).exec(html);
  expect(await readSignedId(env.PREVIEW_SECRET, `view:${live.id}`, frame?.[1])).toBe(amy.id);
  expect(await readSignedId(env.PREVIEW_SECRET, `view:${draft.id}`, frame?.[1])).toBeUndefined(); // good for this page only

  const open = await htmlOf(`/p/${live.id}/manage`, amy.cookie);
  expect(open).toContain('<body class="pv-screen enter">'); // the panel slides in
  expect(open).toContain('<div id="page" inert>');
  expect(open).toContain('<div id="panel">');
  expect(open).toContain('role="dialog" aria-modal="true"');
  expect(open).toContain(`href="/p/${live.id}" aria-label="Close"`);
  expect(open).not.toContain('Open page');
  expect(await htmlOf(`/p/${live.id}/manage?done=renamed`, amy.cookie)).toContain('<body class="pv-screen">'); // after an action it only shows

  const draftHtml = await htmlOf(`/p/${draft.id}`, amy.cookie);
  expect(draftHtml).toContain('<span class="state draft"');
  expect(draftHtml).toContain('<span class="acc">Only you can open it</span>');
  expect(draftHtml).toContain(`<a class="primary publish" href="/p/${draft.id}/manage" aria-label="Publish or delete"`);
  expect(draftHtml).not.toContain('data-copy="https'); // no public link before it is published
  expect(draftHtml).toContain('Visits start when you publish it.');
});

it('keeps the filter and search through a page view: its links, its close, and the redirect after an action', async () => {
  const amy = await owner('amy');
  const plan = await publishedPage(amy.key, 'Seed plan');
  await createPage(amy.key, 'Other');
  const where = '?show=live&q=seed';
  expect(await htmlOf(`/my${where}`, amy.cookie)).toContain(`href="/p/${plan.id}${where}"`);

  const view = await htmlOf(`/p/${plan.id}${where}`, amy.cookie);
  expect(view).toContain(`href="/my${where}#tile-${plan.id}" aria-label="Back to your pages"`);
  expect(view).toContain(`<a class="primary manage" href="/p/${plan.id}/manage${where}"`);
  expect(view).toContain(`href="/p/${plan.id}${where}" aria-label="Close"`);
  expect(view).toContain(`action="/p/${plan.id}/rename${where}"`);
  expect(view).toContain(`href="/p/${plan.id}/manage${where}&done=cancel"`);
  const renamed = await post(`/p/${plan.id}/rename${where}`, amy.cookie, { title: 'Seed plan 2' });
  expect(renamed.headers.get('location')).toBe(`/p/${plan.id}/manage?done=renamed&show=live&q=seed`);
});

it("answers another owner's page, and a page that is not there, with the 404 that offers the way back and another email, and shows nothing of it", async () => {
  const amy = await owner('amy');
  const bob = await owner('bob');
  const theirs = await createPage(bob.key, 'Bob secret title');
  for (const path of [`/p/${theirs.id}`, `/p/${theirs.id}/manage`, '/p/AAAAAAAA', '/p/AAAAAAAA/manage']) {
    const response = await get(path, amy.cookie);
    expect(response.status, path).toBe(404);
    const html = await response.text();
    expect(html).toContain('This page is gone, or it isn’t yours');
    expect(html).toContain('Use another email');
    expect(html).toContain('<a href="/my">Back to your pages</a>');
    expect(html).not.toContain('Bob secret title');
  }
  // manage.js's Back check: the same answer, cacheable enough that Chrome keeps the page in its back/forward memory. Another owner's page is the same 404; no login is the redirect to the sign-in, which the script must not follow (it would end on a 200).
  const mine = await createPage(amy.key, 'Amy page');
  for (const [path, cookie, status] of [[`/p/${mine.id}`, amy.cookie, 200], [`/p/${mine.id}/manage`, amy.cookie, 200], ['/p/AAAAAAAA', amy.cookie, 404], [`/p/${theirs.id}`, amy.cookie, 404], [`/p/${mine.id}/manage`, '', 303]] as const) {
    const head = await callApp(path, { method: 'HEAD', headers: { Cookie: cookie } });
    expect(head.status, path).toBe(status);
    expect(head.headers.get('cache-control'), path).toBe('private, no-cache');
  }
  expect((await get(`/p/${mine.id}`, amy.cookie)).headers.get('cache-control')).toBe('no-store');
});

it("refuses every change that comes from another site or is aimed at another owner's page, and changes nothing", async () => {
  const amy = await owner('amy');
  const bob = await owner('bob');
  const page = await createPage(amy.key, 'Amy page');
  await click('publish', page.id, env, { access: 'approval', emails: 'ingrid@example.com' });
  const [{ id: person }] = await sql<{ id: number }[]>`select id from page_people where page = ${page.id}`;
  const changes: [string, Record<string, string>][] = [
    [`/p/${page.id}/publish`, { access: 'link' }],
    [`/p/${page.id}/unpublish`, {}],
    [`/p/${page.id}/rename`, { title: 'Renamed' }],
    [`/p/${page.id}/people`, { emails: 'omar@example.com' }],
    [`/p/${page.id}/people/${person}`, { decision: 'remove' }],
    [`/p/${page.id}/delete`, { confirm: 'delete' }],
    ['/my/delete', { id: page.id, confirm: 'delete' }],
    ['/my/emails/forget', { email: 'ingrid@example.com', revoke: '1' }],
  ];
  const before = await snapshot();
  for (const [path, fields] of changes) {
    expect((await post(path, amy.cookie, fields, CROSS_SITE)).status, `${path} from another site`).toBe(403);
    if (path !== '/my/emails/forget') expect((await post(path, bob.cookie, fields)).status, `${path} by another owner`).toBe(404);
    const signedOut = await post(path, '', fields);
    expect(signedOut.status, `${path} signed out`).toBe(303);
    expect(signedOut.headers.get('location')).toMatch(/^\/signin\?next=\/(p\/|my(\/emails)?$)/);
  }
  expect((await post('/my/emails/forget', bob.cookie, { email: 'ingrid@example.com', revoke: '1' })).status).toBe(303); // Bob forgets only his own
  expect(await snapshot()).toEqual(before);
});

it('renames a page; a bad title shows the message with what was typed and changes nothing', async () => {
  const amy = await owner('amy');
  const page = await createPage(amy.key, 'Old name');
  const renamed = await post(`/p/${page.id}/rename`, amy.cookie, { title: '  New name  ' });
  expect(renamed.status).toBe(303);
  expect(renamed.headers.get('location')).toBe(`/p/${page.id}/manage?done=renamed`);
  expect(await titleOf(page.id)).toBe('New name');
  expect(await htmlOf(renamed.headers.get('location')!, amy.cookie)).toContain('Renamed to “New name”.');

  for (const [title, message] of [['   ', 'The title must not be empty.'], ['x'.repeat(201), 'The title must be 200 characters or fewer.']]) {
    const refused = await post(`/p/${page.id}/rename`, amy.cookie, { title });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain(`role="alert" id="err">${message}</p>`);
    expect(html).toContain(`name="title" value="${title}"`);
    expect(html).toContain('<div id="panel">'); // the panel stays open over the page, with the message
    expect(html).toContain('<body class="pv-screen">'); // and does not slide in again
  }
  expect(await titleOf(page.id)).toBe('New name');
});

it('deletes a page and its files, and lands on the wall with a line saying so; a published one only once "delete" is typed', async () => {
  const amy = await owner('amy');
  const doomed = await publishedPage(amy.key, 'Doomed');
  await createPage(amy.key, 'Keeper');
  const panel = await htmlOf(`/p/${doomed.id}`, amy.cookie);
  expect(panel).toContain(`<form method="post" action="/p/${doomed.id}/delete" data-plain>`); // the one form that always navigates
  expect(panel).toContain('Type <b>delete</b> to confirm');
  expect(panel).toContain('It is published: its link stops working for everyone. Its <span class="nw">how-it-spread</span> tree and people list go too. This can’t be undone.');
  expect(panel).toContain('command="close" autofocus>Cancel</button>'); // the dialog opens on the safe button, not the word box

  for (const confirm of ['', 'yes', 'deleted']) {
    const refused = await post(`/p/${doomed.id}/delete`, amy.cookie, { confirm });
    expect(refused.status, confirm).toBe(400);
    expect(await refused.text()).toContain('Nothing was deleted. “Doomed” is published');
    expect(await titleOf(doomed.id)).toBe('Doomed');
  }
  const deleted = await post(`/p/${doomed.id}/delete`, amy.cookie, { confirm: ' Delete ' });
  expect(deleted.status).toBe(303);
  expect(deleted.headers.get('location')).toBe('/my?done=deleted');
  expect(await titleOf(doomed.id)).toBeUndefined();
  expect(stored('pages/')).toHaveLength(1); // the keeper's
  expect(stored(`previews/${doomed.id}/`)).toEqual([]);
  const html = await htmlOf('/my?done=deleted', amy.cookie);
  expect(html).toContain('Page deleted.');
  expect(html).toContain('Keeper');
  expect(html).not.toContain('Doomed');
  expect((await get(`/p/${doomed.id}`, amy.cookie)).status).toBe(404);
  expect((await get(`/p/${doomed.id}/manage`, amy.cookie)).status).toBe(404);
});

it('deletes a draft from its panel with a plain Yes, even one that was published before', async () => {
  const amy = await owner('amy');
  const draft = await publishedPage(amy.key, 'Was live');
  await post(`/p/${draft.id}/unpublish`, amy.cookie);
  const panel = await htmlOf(`/p/${draft.id}`, amy.cookie);
  expect(panel).not.toContain('name="confirm"');
  expect(panel).toContain('Are you sure? Its <span class="nw">how-it-spread</span> tree and people list go too. This can’t be undone.');
  expect((await post(`/p/${draft.id}/delete`, amy.cookie)).headers.get('location')).toBe('/my?done=deleted');
  expect(await titleOf(draft.id)).toBeUndefined();
});

/** The pass a Delete form carries (src/wall-view.ts deleteDialog): the frame's ticket, for one page and workspace. */
const passIn = (html: string) => /<form method="post" action="\/p\/[^"]+\/delete[^"]*" data-plain><input type="hidden" name="ticket" value="([^"]+)">/.exec(html)?.[1] ?? '';
/** A 404 card, whichever page it was asked for. */
const cardOf = async (response: Response, id: string) => (await response.text()).replaceAll(id, 'ID');

it("ends a delete of a page that is gone already as a delete does, from its owner's own panel; for anyone else it is the 404 of a page that is not theirs", async () => {
  const amy = await owner('amy');
  const bob = await owner('bob');
  const [one, two] = [await createPage(amy.key, 'One'), await createPage(amy.key, 'Two')];
  const theirs = await publishedPage(bob.key, 'Bob live');
  const panel = await htmlOf(`/p/${one.id}/manage?show=drafts`, amy.cookie);
  const first = passIn(panel);
  const second = passIn(await htmlOf(`/p/${two.id}/manage`, amy.cookie));
  const bobs = passIn(await htmlOf(`/p/${theirs.id}/manage`, bob.cookie));
  expect(await readSignedId(env.PREVIEW_SECRET, `view:${one.id}`, first)).toBe(amy.id); // this page, this workspace
  expect(first).toBe(/\/raw\?t=([^"]+)"/.exec(panel)?.[1]); // the frame's own ticket

  await post(`/p/${one.id}/delete`, amy.cookie); // in another tab
  expect(await titleOf(one.id)).toBeUndefined();
  const stale = await post(`/p/${one.id}/delete?show=drafts`, amy.cookie, { ticket: first }); // the panel left open in the first tab
  expect(stale.status).toBe(303);
  expect(stale.headers.get('location')).toBe('/my?done=deleted&show=drafts'); // the wall it came from, with the line a delete leaves
  expect(await htmlOf('/my?done=deleted&show=drafts', amy.cookie)).toContain('Page deleted.');
  expect((await post(`/p/${one.id}/delete`, amy.cookie, { ticket: first })).headers.get('location')).toBe('/my?done=deleted'); // and again, the same

  // Anything but the owner's own pass for that page is the 404 of a page that is not theirs: the same card as for a page that never was.
  const never = await cardOf(await post('/p/AAAAAAAA/delete', amy.cookie, { ticket: first }), 'AAAAAAAA');
  expect(never).toContain('This page is gone, or it isn’t yours');
  const old = await signedId(env.PREVIEW_SECRET, `view:${one.id}`, amy.id, Math.floor(Date.now() / 1000) - 1);
  const [whose, expires, mac] = first.split('.');
  const forged = `${whose}.${Number(expires) + 1}.${mac}`; // later than it was signed for
  for (const [name, fields] of [['no pass', {}], ['an empty pass', { ticket: '' }], ['another page’s pass', { ticket: second }], ['another workspace’s pass', { ticket: bobs }], ['a pass that is not signed', { ticket: forged }], ['a pass past its 12 hours', { ticket: old }]] as const) {
    const refused = await post(`/p/${one.id}/delete`, amy.cookie, fields);
    expect(refused.status, name).toBe(404);
    expect(await cardOf(refused, one.id), name).toBe(never);
  }
  const taken = await post(`/p/${one.id}/delete`, bob.cookie, { ticket: first }); // her pass is hers: another workspace gets the 404
  expect(taken.status).toBe(404);
  expect(await cardOf(taken, one.id)).toBe(await cardOf(await post('/p/AAAAAAAA/delete', bob.cookie), 'AAAAAAAA'));

  // A page that is there and belongs to another owner: her pass for her own page deletes nothing of theirs, and says nothing about it.
  const others = await post(`/p/${theirs.id}/delete`, amy.cookie, { ticket: first, confirm: 'delete' });
  expect(others.status).toBe(404);
  expect(await cardOf(others, theirs.id)).toBe(never);
  expect(await titleOf(theirs.id)).toBe('Bob live');

  // A page taken down (hidden), not deleted: its row is kept, so "Page deleted." would be untrue.
  const hidden = await createPage(amy.key, 'Taken down');
  const hiddenPass = passIn(await htmlOf(`/p/${hidden.id}/manage`, amy.cookie));
  await sql`update pages set status = 'hidden' where id = ${hidden.id}`;
  expect((await post(`/p/${hidden.id}/delete`, amy.cookie, { ticket: hiddenPass })).status).toBe(404);
  expect(await titleOf(two.id)).toBe('Two');
});

it("gives a lone draft's Delete the owner's pass too, so deleting it where it is gone already ends on the wall as a delete does", async () => {
  const amy = await owner('amy');
  const draft = await createPage(amy.key, 'Only draft');
  const pass = passIn(await htmlOf('/my', amy.cookie));
  expect(await readSignedId(env.PREVIEW_SECRET, `view:${draft.id}`, pass)).toBe(amy.id);
  await post(`/p/${draft.id}/delete`, amy.cookie); // in another tab
  const again = await post(`/p/${draft.id}/delete`, amy.cookie, { ticket: pass });
  expect(again.status).toBe(303);
  expect(again.headers.get('location')).toBe('/my?done=deleted');
  expect(await htmlOf('/my?done=deleted', amy.cookie)).toContain('Page deleted.');

  await createPage(amy.key, 'First');
  await createPage(amy.key, 'Second');
  expect(await htmlOf('/my', amy.cookie)).not.toContain('name="ticket"'); // two pages: tick boxes, no Delete of one page to carry it
});

it('deletes the ticked pages from the wall, all or none: drafts with a plain Yes, a published one among them only once "delete" is typed', async () => {
  const amy = await owner('amy');
  const bob = await owner('bob');
  const [one, two, live, keeper] = [await createPage(amy.key, 'One'), await createPage(amy.key, 'Two'), await publishedPage(amy.key, 'Live'), await createPage(amy.key, 'Keeper')];
  const bobs = await createPage(bob.key, 'Bob page');
  const wall = await htmlOf('/my?show=drafts', amy.cookie);
  expect(wall).toContain('<form id="pick" method="post" action="/my/delete?show=drafts" autocomplete="off">'); // no browser restore of ticks by position
  expect(wall).toContain(`<input type="checkbox" name="id" value="${one.id}">`);
  expect(wall).toContain('<p class="dm-drafts" id="dm-drafts">Are you sure? Their <span class="nw">how-it-spread</span> trees and people lists go too. This can’t be undone.</p>'); // the dialog before the script words it
  expect(wall).toContain('<p id="dm-live">Some of them are published: their links stop working for everyone. Their <span class="nw">how-it-spread</span> trees and people lists go too. This can’t be undone.</p>');
  expect(wall).not.toContain(`value="${live.id}"`); // only the pages shown can be ticked
  expect(wall).toContain('<input type="checkbox" id="all"><span>Select all shown</span></label>');
  expect(wall.indexOf('<div class="selbar">')).toBeLessThan(wall.indexOf('<ul class="grid">')); // the keyboard meets the bar first; the style draws it below
  expect(wall).toContain('id="picked" aria-live="polite"');
  expect(wall).toContain('<button class="btn quiet link-danger small" type="button" commandfor="delete-many" command="show-modal">'); // the bar's Delete is danger text; the fill is only for "Yes, delete"
  const everything = await htmlOf('/my', amy.cookie);
  expect(everything).toContain(`<input type="checkbox" name="id" value="${live.id}" data-live>`);
  expect(everything).toContain('<input type="checkbox" id="all"><span>Select all</span></label>');

  // Another owner's page among them (to this owner it is gone), or nothing ticked: nothing goes, and the wall says why.
  for (const [fields, status] of [[{ id: [one.id, bobs.id] }, 404], [{}, 400]] as [Record<string, string[]>, number][]) {
    const refused = await post('/my/delete', amy.cookie, fields);
    expect(refused.status).toBe(status);
    expect(await refused.text()).toContain('<p class="status bad" role="alert"');
  }
  const refused = await post('/my/delete', amy.cookie, { id: [one.id, live.id], confirm: 'yes' });
  expect(refused.status).toBe(400);
  const unconfirmed = await refused.text();
  expect(unconfirmed).toContain('Nothing was deleted. “Live” is published, so deleting it needs the word delete. Press Delete again and type it.');
  expect(unconfirmed).toContain(`<input type="checkbox" name="id" value="${live.id}" data-live checked>`); // both stay ticked, for the word to be typed
  expect(unconfirmed).toContain(`<input type="checkbox" name="id" value="${one.id}" checked>`);
  expect(await titleOf(one.id)).toBe('One');
  expect(await titleOf(live.id)).toBe('Live');
  expect(await titleOf(bobs.id)).toBe('Bob page');

  const drafts = await post('/my/delete?show=drafts', amy.cookie, { id: [one.id, two.id] });
  expect(drafts.status).toBe(303);
  expect(drafts.headers.get('location')).toBe('/my?done=deleted-many&n=2&show=drafts');
  expect(await htmlOf(drafts.headers.get('location')!, amy.cookie)).toContain('2 pages deleted.');
  expect([await titleOf(one.id), await titleOf(two.id)]).toEqual([undefined, undefined]);

  const typed = await post('/my/delete', amy.cookie, { id: live.id, confirm: 'DELETE' });
  expect(typed.headers.get('location')).toBe('/my?done=deleted');
  expect(await titleOf(live.id)).toBeUndefined();
  expect(await titleOf(keeper.id)).toBe('Keeper');
  for (const page of [one, two, live]) expect(stored(`previews/${page.id}/`)).toEqual([]);
});

it('says what is left, once, and not that a search failed, when a delete leaves the filter empty', async () => {
  const amy = await owner('amy');
  await publishedPage(amy.key, 'Live one');
  await publishedPage(amy.key, 'Live two');
  const left = await htmlOf('/my?show=drafts&done=deleted-many&n=2', amy.cookie);
  expect(left).toContain('<b>No draft pages left.</b>');
  expect(left).toContain('2 pages deleted.');
  // A filter with nothing in it says so in its chip's word (Asking is about people); "Try another word" is for a word that was typed.
  const empty = await htmlOf('/my?show=drafts', amy.cookie);
  expect(empty).toContain('<b>No draft pages.</b>'); // empty before any delete
  expect(empty).not.toContain('Try another word');
  expect(await htmlOf('/my?show=asking', amy.cookie)).toContain('<b>Nobody is asking to open a page right now.</b>');
  expect(await htmlOf('/my?show=asking&done=deleted', amy.cookie)).toContain('<b>Nobody is asking to open a page right now.</b>');
  expect(await htmlOf('/my?show=drafts&q=zzz', amy.cookie)).toContain('<b>No draft pages matching “zzz”.</b> Try another word, or look at everything.'); // under a chip the chip's sentence: the chip may hide a match
  // After a delete, a search that now finds nothing says what is left, with the word typed, and is not the same as a search that failed: the strip above it says what was deleted (once, in the singular or the plural). Under a chip the sentence is the chip's, since the chip hides matches too; on All it says only that nothing else matches.
  const one = await htmlOf('/my?show=drafts&q=zzz&done=deleted', amy.cookie);
  expect(one).toContain('<b>No draft pages left matching “zzz”.</b>');
  expect(one).toContain('Page deleted.');
  expect(one).not.toMatch(/(That page is|Those pages are) gone/);
  expect(one).not.toContain('No pages match.');
  expect(one).not.toContain('Nothing else matches');
  const many = await htmlOf('/my?q=a%3Cb&done=deleted-many&n=3', amy.cookie);
  expect(many).toContain('<b>Nothing else matches “a&#60;b”.</b>'); // the search is escaped
  expect(many).toContain('3 pages deleted.');
  expect(many).not.toMatch(/(That page is|Those pages are) gone/);
  expect(await htmlOf('/my?show=live&q=a%3Cb&done=deleted-many&n=3', amy.cookie)).toContain('<b>No published pages left matching “a&#60;b”.</b>'); // escaped under a chip too
  expect(await htmlOf('/my?show=asking&q=zzz&done=deleted', amy.cookie)).toContain('<b>Nobody is asking to open a page matching “zzz” right now.</b>');
});

it('answers a GET at the address the delete posts to with the wall it came from, not a 404', async () => {
  const amy = await owner('amy');
  expect((await get('/my/delete')).headers.get('location')).toBe('/my'); // the wall asks for the sign-in
  for (const [path, to] of [['/my/delete', '/my'], ['/my/delete?show=drafts&q=x', '/my?show=drafts&q=x'], ['/my/delete?show=nonsense&q=x', '/my?q=x']]) {
    const response = await get(path, amy.cookie);
    expect(response.status, path).toBe(303);
    expect(response.headers.get('location'), path).toBe(to);
  }
});

it('puts the wall back with the other pages still ticked when a ticked one was deleted meanwhile, and deletes nothing', async () => {
  const amy = await owner('amy');
  const [one, two, gone] = [await createPage(amy.key, 'One'), await createPage(amy.key, 'Two'), await createPage(amy.key, 'Gone')];
  await post(`/p/${gone.id}/delete`, amy.cookie); // in another tab

  const refused = await post('/my/delete', amy.cookie, { id: [one.id, two.id, gone.id] });
  expect(refused.status).toBe(404);
  const html = await refused.text();
  expect(html).toContain('<p class="status bad" role="alert"');
  expect(html).toContain('1 of the pages you ticked was already deleted, so nothing was deleted. The others are still ticked.');
  for (const page of [one, two]) expect(html).toContain(`<input type="checkbox" name="id" value="${page.id}" checked>`);
  expect(html).not.toContain(gone.id);
  expect([await titleOf(one.id), await titleOf(two.id)]).toEqual(['One', 'Two']);

  const alone = await post('/my/delete', amy.cookie, { id: gone.id });
  expect(alone.status).toBe(404);
  expect(await alone.text()).toContain('The page you ticked was already deleted, so nothing was deleted.');
});

it("serves a page's screenshot, a draft's too, to its owner only", async () => {
  const amy = await owner('amy');
  const bob = await owner('bob');
  const shot = await publishedPage(amy.key, 'Shot');
  const draft = await createPage(amy.key, 'Draft');
  expect((await get(`/p/${draft.id}/thumb.jpg`, amy.cookie)).status).toBe(200);
  const image = await get(`/p/${shot.id}/thumb.jpg`, amy.cookie);
  expect(image.status).toBe(200);
  expect(image.headers.get('content-type')).toBe('image/jpeg');
  expect(image.headers.get('cache-control')).toBe('private, max-age=300');
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(SHOT);
  for (const [name, path, cookie] of [
    ['signed out', `/p/${shot.id}/thumb.jpg`, ''],
    ['another owner', `/p/${shot.id}/thumb.jpg`, bob.cookie],
    ['another owner, a draft', `/p/${draft.id}/thumb.jpg`, bob.cookie],
    ['no such page', '/p/AAAAAAAA/thumb.jpg', amy.cookie],
  ]) {
    expect((await get(path, cookie)).status, name).toBe(404);
  }
  const src = async () => (await htmlOf('/my', amy.cookie)).match(new RegExp(`src="(/p/${shot.id}/thumb\\.jpg\\?v=[^"]+)"`))![1];
  const linkSrc = await src();
  expect((await get(linkSrc, amy.cookie)).headers.get('cache-control')).toBe('private, max-age=31536000, immutable'); // the wall's address names this screenshot
  await click('publish', shot.id, env, { access: 'approval' });
  expect((await get(`/p/${shot.id}/thumb.jpg`, amy.cookie)).status).toBe(200); // an approval page's screenshot, taken as amy
  expect((await get(`/p/${shot.id}/thumb.jpg`, bob.cookie)).status).toBe(404);
  expect(await src()).not.toBe(linkSrc); // a new screenshot has a new address, so the browser's cached old one is not shown
  expect((await get(linkSrc, amy.cookie)).headers.get('cache-control')).toBe('private, max-age=300'); // the old address now serves the new screenshot: not kept
  await sql`update testers set disabled_at = now() where id = (select owner from pages where id = ${shot.id})`;
  expect((await get(linkSrc, amy.cookie)).status).toBe(404); // a disabled workspace's session gets nothing
});

it('draws every page its title card, a draft too, the title escaped and sized by its length; a screenshot goes over it', async () => {
  const amy = await owner('amy');
  const shot = await publishedPage(amy.key, 'Shot');
  await createPage(amy.key, 'Plans & <more>');
  await createPage(amy.key, 'A very long title that keeps going well past the eighty characters the big sizes allow');
  const html = await htmlOf('/my', amy.cookie);
  expect(html).toContain('<span class="dc-i c0"><span class="dc-t"><span>Plans &#38; &#60;more&#62;</span>');
  expect(html).toContain('<span class="dc-i c3"><span class="dc-t"><span>A very long title');
  expect(html).toMatch(new RegExp(`<span class="dc-i c0"><span class="dc-t"><span>Shot</span>.*?</span></span></span><img src="/p/${shot.id}/thumb\\.jpg`));
});

it("takes a missing screenshot after the owner's page view loads, so the wall shows it next; never just after a click, whose own screenshot may still be on its way", async () => {
  const amy = await owner('amy');
  const page = await publishedPage(amy.key, 'Approval');
  await click('publish', page.id, env, { access: 'approval' });
  await sql`update pages set preview_file = null where id = ${page.id}`;
  const { browser, requests } = fakeBrowser();
  const bindings = { ...env, BROWSER: browser };
  const open = async (path: string) => (await callApp(path, { headers: { Cookie: amy.cookie } }, bindings)).text();
  const thumb = `src="/p/${page.id}/thumb.jpg?v=`;

  expect(await open(`/p/${page.id}/manage?done=published`)).not.toContain(thumb);
  expect(requests).toEqual([]);
  expect(await open(`/p/${page.id}`)).not.toContain(thumb); // the page view has no picture; the shot comes after the response
  expect(requests).toHaveLength(1);
  expect(requests[0].cookies).toHaveLength(1);
  expect((await get(`/p/${page.id}/thumb.jpg`, amy.cookie)).status).toBe(200);
  expect(await open('/my')).toContain(thumb);
  expect(await open(`/p/${page.id}`)).not.toContain(thumb);
  expect(requests).toHaveLength(1); // it has one now
});

it('catches up a published page with no screenshot after the plain wall loads, so the next look shows it; never a draft, nor after a click', async () => {
  const amy = await owner('amy');
  const missing = await publishedPage(amy.key, 'Missing');
  await sql`update pages set preview_file = null where id = ${missing.id}`;
  await publishedPage(amy.key, 'Has one');
  await createPage(amy.key, 'Draft');
  const { browser, requests } = fakeBrowser();
  const wall = async (path: string) => (await callApp(path, { headers: { Cookie: amy.cookie } }, { ...env, BROWSER: browser })).text();
  const thumb = `src="/p/${missing.id}/thumb.jpg?v=`;

  expect(await wall('/my?done=deleted')).not.toContain(thumb);
  expect(requests).toEqual([]);
  expect(await wall('/my')).not.toContain(thumb); // taken after the response
  expect(requests.map((r) => r.url)).toEqual([`${env.VIEWER_ORIGIN}/${missing.id}`]);
  expect(await wall('/my')).toContain(thumb);
  expect(requests).toHaveLength(1);
});

it('says what a click did, with Undo for Unpublish and for switching who can open the page, and keeps a refused Publish as it was typed', async () => {
  const amy = await owner('amy');
  const page = await createPage(amy.key, 'Plan');
  const publish = `/p/${page.id}/publish`;
  const undo = (access: string) => new RegExp(`action="${publish}"><input type="hidden" name="access" value="${access}"><button[^>]*>Undo</button>`);
  const seen = async (response: Response, done: string) => {
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/p/${page.id}/manage?done=${done}`);
    return htmlOf(response.headers.get('location')!, amy.cookie);
  };

  const refused = await post(publish, amy.cookie, { access: 'approval', emails: 'ingrid@example.com, oops' });
  const refusedHtml = await refused.text();
  expect(refused.status).toBe(400);
  expect(refusedHtml).toContain('“oops” is not an email address. Fix it and try again.');
  expect(refusedHtml).toContain('>ingrid@example.com, oops</textarea>');
  expect(refusedHtml).toContain('value="approval" checked');
  expect((await post(publish, amy.cookie)).status).toBe(400); // nothing chosen
  expect((await sql`select 1 from pages where id = ${page.id} and published_at is not null`).length).toBe(0);

  const published = await seen(await post(publish, amy.cookie, { access: 'link' }), 'published');
  expect(published).toContain('“Plan” is published. Anyone with the link can open it.');
  expect(published).not.toContain('>Undo<');
  expect(await seen(await post(publish, amy.cookie, { access: 'link' }), 'published')).not.toContain('>Undo<'); // nothing switched

  const switched = await seen(await post(publish, amy.cookie, { access: 'approval' }), 'switched');
  expect(switched).toContain('Now only people you approve can open “Plan”.');
  expect(switched).toMatch(undo('link'));
  const back = await seen(await post(publish, amy.cookie, { access: 'link' }), 'switched'); // the Undo button
  expect(back).toContain('Now anyone with the link can open “Plan”.');
  expect(back).toMatch(undo('approval'));

  const unpublished = await seen(await post(`/p/${page.id}/unpublish`, amy.cookie), 'unpublished');
  expect(unpublished).toContain('“Plan” is a draft again. Only you can open it.');
  expect(unpublished).toMatch(undo('link'));
  expect(await seen(await post(publish, amy.cookie, { access: 'link' }), 'published')).toContain('is published');
});

it('groups the people of an approval page, lets people in from the ticks and the box together, and says what each button did', async () => {
  const amy = await owner('amy');
  const page = await createPage(amy.key, 'Plan');
  await click('publish', page.id, env, { access: 'approval', emails: 'omar@example.com' });
  await sql`insert into page_people (page, email, status) values (${page.id}, 'ingrid@example.com', 'waiting'), (${page.id}, 'pia@example.com', 'denied')`;
  await sql`insert into remembered_emails (owner, email) values (${amy.id}, 'lena@example.com')`;
  const [ingrid, omar, pia] = (await sql<{ id: number }[]>`select id from page_people where page = ${page.id} order by email`).map((row) => row.id);

  const html = await htmlOf(`/p/${page.id}`, amy.cookie);
  for (const group of ['Waiting for you', 'Can open it', 'Told no']) expect(html).toContain(`${group} · <span class="num">1</span>`);
  expect(html).toContain('<input type="checkbox" name="emails" value="lena@example.com">'); // remembered, not yet let in
  expect(html).not.toContain('<input type="checkbox" name="emails" value="omar@example.com">'); // already in

  const none = await post(`/p/${page.id}/people`, amy.cookie);
  expect(none.status).toBe(400);
  expect(await none.text()).toContain('Type an email first, or pick one from the list.');

  const letIn = await post(`/p/${page.id}/people`, amy.cookie, { emails: ['lena@example.com', 'sam@example.com, kai@example.com'] });
  expect(letIn.headers.get('location')).toBe(`/p/${page.id}/manage?done=letin`);
  expect(await people(page.id)).toEqual([
    { email: 'ingrid@example.com', status: 'waiting' },
    { email: 'kai@example.com', status: 'approved' },
    { email: 'lena@example.com', status: 'approved' },
    { email: 'omar@example.com', status: 'approved' },
    { email: 'pia@example.com', status: 'denied' },
    { email: 'sam@example.com', status: 'approved' },
  ]);
  expect(await remembered(amy.id)).toEqual(['kai@example.com', 'lena@example.com', 'omar@example.com', 'sam@example.com']);
  expect(await htmlOf(letIn.headers.get('location')!, amy.cookie)).toContain('Let in. They can open “Plan” now.');

  for (const [person, decision, done] of [[ingrid, 'approve', 'approved'], [pia, 'approve', 'approved'], [omar, 'remove', 'removed'], [ingrid, 'deny', 'denied']] as const) {
    const decided = await post(`/p/${page.id}/people/${person}`, amy.cookie, { decision });
    expect(decided.headers.get('location'), decision).toBe(`/p/${page.id}/manage?done=${done}`);
  }
  expect((await post(`/p/${page.id}/people/${ingrid}`, amy.cookie, { decision: 'maybe' })).status).toBe(400);
  expect((await people(page.id)).filter((row) => ['ingrid@example.com', 'pia@example.com', 'omar@example.com'].includes(row.email))).toEqual([
    { email: 'ingrid@example.com', status: 'denied' },
    { email: 'pia@example.com', status: 'approved' },
  ]);
});

it('lists the remembered emails with what each can open, and Forget takes one off the list, its access too when asked', async () => {
  const amy = await owner('amy');
  const bob = await owner('bob');
  expect(await htmlOf('/my/emails', amy.cookie)).toContain('Nobody is remembered yet.');
  const one = await createPage(amy.key, 'One');
  const two = await createPage(amy.key, 'Two');
  await click('publish', one.id, env, { access: 'approval', emails: 'omar@example.com, ingrid@example.com' });
  await click('publish', two.id, env, { access: 'approval', emails: 'omar@example.com' });

  const html = await htmlOf('/my/emails', amy.cookie);
  expect(html).toContain('2 remembered emails');
  expect(html).toContain('Can open 2 pages');
  expect(html).toContain('Can open 1 page');
  expect(html).toContain('<input type="checkbox" name="revoke" value="1" checked>');

  await post('/my/emails/forget', bob.cookie, { email: 'omar@example.com', revoke: '1' }); // only Bob's own list
  expect(await remembered(amy.id)).toEqual(['ingrid@example.com', 'omar@example.com']);

  const kept = await post('/my/emails/forget', amy.cookie, { email: 'ingrid@example.com' });
  expect(kept.status).toBe(303);
  expect(kept.headers.get('location')).toBe('/my/emails?done=forgot');
  expect(await remembered(amy.id)).toEqual(['omar@example.com']);
  expect((await people(one.id)).map((row) => row.email)).toEqual(['ingrid@example.com', 'omar@example.com']); // still let in
  expect(await htmlOf(kept.headers.get('location')!, amy.cookie)).toContain('Forgotten.');

  await post('/my/emails/forget', amy.cookie, { email: 'omar@example.com', revoke: '1' });
  expect(await remembered(amy.id)).toEqual([]);
  expect((await people(one.id)).map((row) => row.email)).toEqual(['ingrid@example.com']);
  expect(await people(two.id)).toEqual([]);
});

// docs/SPEC.md "Page groups" on the wall: /my/groups/:id, and the forms New group, Move to…, Rename and Delete group.
const groupOf = async (id: string) => (await sql<{ group_id: string | null }[]>`select group_id from pages where id = ${id}`)[0]?.group_id;
const groupNamed = async (name: string) => (await sql<{ id: string }[]>`select id from page_groups where name = ${name}`)[0]?.id;

it("opens a group's own wall for its owner only; another owner's group is a 404", async () => {
  const amy = await owner('amy');
  const bob = await owner('bob');
  const page = await createPage(amy.key, 'Round 1');
  expect((await post('/my/groups', amy.cookie, { name: 'Review', id: page.id })).status).toBe(303);
  const gid = (await groupNamed('Review'))!;
  const signedOut = await get(`/my/groups/${gid}`);
  expect(signedOut.headers.get('location')).toBe(`/signin?next=/my/groups/${gid}`);
  const own = await htmlOf(`/my/groups/${gid}`, amy.cookie);
  expect(own).toContain('<span>Review</span>');
  expect(own).toContain(`href="/p/${page.id}"`);
  expect((await get(`/my/groups/${gid}`, bob.cookie)).status).toBe(404);
  expect((await get('/my/groups/AAAAAAAA', amy.cookie)).status).toBe(404);
  // On Your pages the page is inside its group's tile, not loose.
  const top = await htmlOf('/my', amy.cookie);
  expect(top).toContain(`id="group-${gid}"`);
  expect(top).not.toContain(`href="/p/${page.id}"`);
});

it('makes a group with the ticked pages, all or none: a page that is not yours makes nothing', async () => {
  const amy = await owner('amy');
  const bob = await owner('bob');
  const [a, b] = [await createPage(amy.key, 'A'), await createPage(amy.key, 'B')];
  const bobs = await createPage(bob.key, 'Bob page');
  const refused = await post('/my/groups', amy.cookie, { name: 'Mixed', id: [a.id, bobs.id] });
  expect(refused.status).toBe(404);
  expect(await refused.text()).toContain('A page you ticked was deleted meanwhile, so the group was not made and nothing was moved. The other is still ticked.');
  expect(await groupNamed('Mixed')).toBeUndefined();
  expect(await groupOf(bobs.id)).toBeNull();

  const made = await post('/my/groups?sort=name', amy.cookie, { name: 'Pair', id: [a.id, b.id] });
  const gid = await groupNamed('Pair');
  expect(made.headers.get('location')).toBe(`/my?done=group-made&g=${gid}&n=2&sort=name`);
  expect([await groupOf(a.id), await groupOf(b.id)]).toEqual([gid, gid]);
  expect(await htmlOf(made.headers.get('location')!, amy.cookie)).toContain('Made the group “Pair” and moved 2 pages into it.');
  const taken = await post('/my/groups', amy.cookie, { name: ' pair ' });
  expect(taken.status).toBe(400);
  expect(await taken.text()).toContain('You already have a group called “Pair”.'); // the group's own name, not the typed one
});

it('moves ticked pages into a group, out of it, or into a new one, and never into or with another owner\'s', async () => {
  const amy = await owner('amy');
  const bob = await owner('bob');
  const [a, b] = [await createPage(amy.key, 'A'), await createPage(amy.key, 'B')];
  await post('/my/groups', amy.cookie, { name: 'Ours' });
  await post('/my/groups', bob.cookie, { name: 'Theirs' });
  const [ours, theirs] = [(await groupNamed('Ours'))!, (await groupNamed('Theirs'))!];

  expect((await post('/my/move', amy.cookie, { id: a.id, to: theirs })).status).toBe(404);
  expect(await groupOf(a.id)).toBeNull();

  const moved = await post('/my/move', amy.cookie, { id: [a.id, b.id], to: ours });
  expect(moved.headers.get('location')).toBe(`/my?done=moved&g=${ours}&n=2`);
  expect(await htmlOf(moved.headers.get('location')!, amy.cookie)).toContain('Moved 2 pages to “Ours”.');

  // From the group's own wall, out of it, and back there.
  const out = await post('/my/move', amy.cookie, { id: a.id, to: 'none', from: ours });
  expect(out.headers.get('location')).toBe(`/my/groups/${ours}?done=moved-out&g=${ours}&p=${a.id}&n=1`);
  expect(await htmlOf(out.headers.get('location')!, amy.cookie)).toContain('Moved “A” out of “Ours”, onto Your pages.');
  expect(await groupOf(a.id)).toBeNull();

  const fresh = await post('/my/move', amy.cookie, { id: b.id, to: 'new', name: 'Fresh' });
  expect(await groupOf(b.id)).toBe(await groupNamed('Fresh'));
  expect(fresh.status).toBe(303);
  expect((await post('/my/move', amy.cookie, { id: a.id, to: 'new', name: '' })).status).toBe(400); // a new group needs a name
  expect((await post('/my/move', amy.cookie, { to: ours })).status).toBe(400); // nothing ticked
  expect((await post('/my/move', amy.cookie, { id: a.id, to: ours }, CROSS_SITE)).status).toBe(403);
});

it('renames a group, refusing a name another of the owner\'s groups has', async () => {
  const amy = await owner('amy');
  const bob = await owner('bob');
  await post('/my/groups', amy.cookie, { name: 'One' });
  await post('/my/groups', amy.cookie, { name: 'Two' });
  const one = (await groupNamed('One'))!;
  expect((await post(`/my/groups/${one}/rename`, amy.cookie, { name: 'TWO' })).status).toBe(400);
  expect((await post(`/my/groups/${one}/rename`, bob.cookie, { name: 'Mine' })).status).toBe(404);
  const renamed = await post(`/my/groups/${one}/rename`, amy.cookie, { name: 'First' });
  expect(renamed.headers.get('location')).toBe(`/my/groups/${one}?done=group-renamed&g=${one}&was=One`);
  expect(await htmlOf(renamed.headers.get('location')!, amy.cookie)).toContain('Renamed “One” to “First”.');
  const same = await post(`/my/groups/${one}/rename?sort=name`, amy.cookie, { name: ' First ' });
  expect(same.headers.get('location')).toBe(`/my/groups/${one}?sort=name`); // saved as it was: no "Renamed “First” to “First”."
  expect((await get(`/my/groups/${one}/rename`, amy.cookie)).headers.get('location')).toBe(`/my/groups/${one}`); // Back to the post's address
});

it('deletes a group keeping its pages, or with them: only the pages its dialog listed, a published one only once "delete" is typed', async () => {
  const amy = await owner('amy');
  const [draft, live] = [await createPage(amy.key, 'Draft'), await publishedPage(amy.key, 'Live')];
  await post('/my/groups', amy.cookie, { name: 'Keep', id: draft.id });
  const kept = await post(`/my/groups/${await groupNamed('Keep')}/delete`, amy.cookie, { how: 'keep' });
  expect(kept.headers.get('location')).toBe('/my?done=group-deleted-kept&was=Keep&n=1');
  expect(await groupOf(draft.id)).toBeNull();
  expect(await titleOf(draft.id)).toBe('Draft');

  await post('/my/groups', amy.cookie, { name: 'All', id: [draft.id, live.id] });
  const gid = (await groupNamed('All'))!;
  const shown = [draft.id, live.id];
  const refused = await post(`/my/groups/${gid}/delete`, amy.cookie, { how: 'delete', page: shown });
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain('Nothing was deleted. “Live” is published, so deleting it needs the word delete.');
  expect([await groupOf(draft.id), await groupOf(live.id)]).toEqual([gid, gid]);

  // The dialog listed only Draft, and Live was moved in since (another tab): nothing goes.
  const stale = await post(`/my/groups/${gid}/delete`, amy.cookie, { how: 'delete', page: draft.id, confirm: 'delete' });
  expect(stale.status).toBe(400);
  expect(await stale.text()).toContain('Its pages changed since you opened this, maybe in another tab, so nothing was deleted.');
  expect([await titleOf(draft.id), await groupOf(live.id)]).toEqual(['Draft', gid]);

  const gone = await post(`/my/groups/${gid}/delete`, amy.cookie, { how: 'delete', page: shown, confirm: 'delete' });
  expect(gone.headers.get('location')).toBe('/my?done=group-deleted-all&was=All&n=2');
  expect(await htmlOf(gone.headers.get('location')!, amy.cookie)).toContain('Deleted the group “All” and its 2 pages.');
  expect(await sql`select 1 from pages where id in ${sql([draft.id, live.id])} and status = 'live'`).toHaveLength(0);
});

it('deleting a page in a group from its panel lands on that group, or on Your pages when it was opened from a search', async () => {
  const amy = await owner('amy');
  const [one, two] = [await createPage(amy.key, 'One'), await createPage(amy.key, 'Two')];
  await post('/my/groups', amy.cookie, { name: 'Pair', id: [one.id, two.id] });
  const gid = await groupNamed('Pair');
  const gone = await post(`/p/${one.id}/delete`, amy.cookie);
  expect(gone.headers.get('location')).toBe(`/my/groups/${gid}?done=deleted`);
  expect(await htmlOf(gone.headers.get('location')!, amy.cookie)).toContain('Page deleted.');
  expect((await post(`/p/${two.id}/delete?q=tw`, amy.cookie)).headers.get('location')).toBe('/my?done=deleted&q=tw');
});

it('refuses deleting a group of more than 1,000 pages in the owner\'s words', async () => {
  const amy = await owner('amy');
  const page = await createPage(amy.key, 'First');
  await post('/my/groups', amy.cookie, { name: 'Huge', id: page.id });
  const gid = (await groupNamed('Huge'))!;
  await sql`insert into page_ids (id) select 'h' || lpad(n::text, 7, '0') from generate_series(1, 1000) n`;
  await sql`insert into pages (id, owner, title, size, file, group_id) select 'h' || lpad(n::text, 7, '0'), ${amy.id}, 'Filler', 1, 'none', ${gid} from generate_series(1, 1000) n`;
  const refused = await post(`/my/groups/${gid}/delete`, amy.cookie, { how: 'delete', page: page.id });
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain('This group has 1,001 pages; at most 1,000 can be deleted at once. Delete some of its pages first (tick them and press Delete), then delete the group.');
  expect(await titleOf(page.id)).toBe('First');
});

it('sorts by name with numbers in order, and a search lists pages from every group, naming theirs, matching groups first', async () => {
  const amy = await owner('amy');
  const pages = [await createPage(amy.key, 'Round 12'), await createPage(amy.key, 'Round 2'), await createPage(amy.key, 'Other')];
  const order = (html: string) => pages.map((p) => html.indexOf(`id="tile-${p.id}"`));
  const [twelve, two] = order(await htmlOf('/my?sort=name', amy.cookie));
  expect(two).toBeLessThan(twelve);

  await post('/my/groups', amy.cookie, { name: 'Rounds', id: [pages[0].id, pages[1].id] });
  const gid = await groupNamed('Rounds');
  const found = await htmlOf('/my?q=round', amy.cookie);
  expect(found).toContain('<span class="in">');
  expect(found.indexOf(`id="group-${gid}"`)).toBeLessThan(Math.min(...order(found).slice(0, 2)));
  expect(order(found)[2]).toBe(-1); // "Other" does not match
});

it('shows groups, then the pages in no group, in the same order as list_groups and list_pages over MCP, for every sort', async () => {
  const amy = await owner('amy');
  await sortSeed(amy.key);
  const listed = async (name: string, args: object) => {
    const response = await mcp(amy.key, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    const result = JSON.parse((await json(response)).result.content[0].text);
    return (result.groups ?? result.pages).map((item: { id: string }) => item.id);
  };
  for (const sort of ['changed', 'added', 'name', 'visitors', 'people']) {
    const wall = [...(await htmlOf(`/my?sort=${sort}`, amy.cookie)).matchAll(/<a class="tile(?: gtile)?" id="(?:group|tile)-([A-Za-z0-9]+)"/g)].map((match) => match[1]);
    expect(wall, sort).toEqual([...(await listed('list_groups', { sort })), ...(await listed('list_pages', { group: 'none', sort }))]);
  }
});
