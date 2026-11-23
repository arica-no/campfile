import { expect, it } from 'vitest';
import { authenticate, CampfileError, pageService } from '../src/pages.ts';
import { arrive } from '../src/sharing.ts';
import { addTester, api, callApp, callViewer, createPage, env, form, json, ownerCookie, sql, useCleanDatabase } from './helpers.ts';
import { previewOf } from './helpers.ts';
import { fakeBrowser } from './helpers.ts';

useCleanDatabase();

const publish = (key: string, id: string, body: unknown, bindings = env) => api(key, 'POST', `/api/pages/${id}/publish`, body, bindings);
const sharingOf = async (id: string) => (await sql<{ sharing: string }[]>`select sharing from pages where id = ${id}`)[0].sharing;

/** The owner page's Publish form, with its fields in order: the sharing boxes repeat `sharing`. */
async function submit(id: string, fields: [string, string][], bindings = env) {
  return callApp(`/p/${id}/publish`, { method: 'POST', headers: { ...form, Cookie: await ownerCookie(id) }, body: new URLSearchParams(fields) }, bindings);
}

it('publishing without "sharing" keeps what the page has, so publishing again never turns it off unasked', async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  expect(await json(await publish(key, id, { access: 'link', sharing: 'links' }))).toMatchObject({ access: 'link', sharing: 'links' });
  expect(await json(await publish(key, id, { access: 'link' }))).toMatchObject({ sharing: 'links' });
  expect(await json(await publish(key, id, {}))).toMatchObject({ sharing: 'links' });
  expect((await json(await api(key, 'GET', '/api/pages'))).pages[0]).toMatchObject({ id, sharing: 'links' });
  expect(await json(await api(key, 'GET', `/api/pages/${id}`))).toMatchObject({ sharing: 'links' });
  // The switch and Undo buttons send no boxes either: they keep it too.
  expect((await submit(id, [['access', 'link']])).status).toBe(303);
  expect(await sharingOf(id)).toBe('links');
});

it('publishing with approval stores "off", whatever was asked, and switching back to the link keeps it off', async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  await publish(key, id, { access: 'link', sharing: 'emails' });
  expect(await json(await publish(key, id, { access: 'approval', sharing: 'links' }))).toMatchObject({ access: 'approval', sharing: 'off' });
  expect(await sharingOf(id)).toBe('off');
  expect(await json(await publish(key, id, { access: 'link' }))).toMatchObject({ access: 'link', sharing: 'off' });
});

it.each([['an unknown word', 'yes'], ['true', true], ['null', null]])('refuses "sharing" as %s with a message that names the choices', async (_, sharing) => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  const response = await publish(key, id, { access: 'link', sharing });
  expect(response.status).toBe(400);
  expect((await json(response)).error).toMatch(/^"sharing" must be "off", "links" .* or "emails"/);
  expect(await json(await api(key, 'GET', `/api/pages/${id}`))).toMatchObject({ published: false, sharing: 'off' });
});

const service = async (key: string) => pageService(sql, env, await authenticate(sql, key), () => {});

it("reads the share tree for the page's owner only: another tester gets the same 404 as for no page", async () => {
  const [amy, bob] = [await addTester('amy'), await addTester('bob')];
  const { id } = await createPage(amy);
  await publish(amy, id, { access: 'link', sharing: 'links' });
  expect(await (await service(amy)).sharing(id)).toMatchObject({ sharing: 'links', entries: 0, capped: false, brought: 0, children: [] });
  const refused = await (await service(bob)).sharing(id).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(CampfileError);
  expect(refused).toMatchObject({ status: 404 });
  await expect((await service(bob)).sharing('nosuchpg')).rejects.toMatchObject({ status: 404 });
});

it('clearing the tree, by its owner only, deletes every entry; the page and its readers\' links keep opening', async () => {
  const [amy, bob] = [await addTester('amy'), await addTester('bob')];
  const { id } = await createPage(amy);
  await publish(amy, id, { access: 'link', sharing: 'links' });
  const reader = (key: string, via: string | null) => arrive(sql, { page: id, via, key, label: null, country: null, device: 'phone' });
  const { code } = await reader('a'.repeat(22), null);
  await reader('b'.repeat(22), code);
  expect((await (await service(amy)).sharing(id)).entries).toBe(2);

  await expect((await service(bob)).clearSharing(id)).rejects.toMatchObject({ status: 404 });
  expect((await (await service(amy)).sharing(id)).entries).toBe(2);

  expect(await (await service(amy)).clearSharing(id)).toEqual({ cleared: 2 });
  expect(await (await service(amy)).sharing(id)).toMatchObject({ sharing: 'links', entries: 0, children: [] });
  expect((await callViewer(`/${id}`)).status).toBe(200);
  expect((await callViewer(`/${id}-${code}`)).status).toBe(200);
});

it('shoots every link page as a stranger sees it, and keeps the screenshot when only sharing changes', async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  const { browser, requests } = fakeBrowser();
  const bindings = { ...env, BROWSER: browser };
  await publish(key, id, { access: 'link', sharing: 'emails' }, bindings);
  const shot = await previewOf(id);
  expect(shot).not.toBeNull();
  expect(requests).toHaveLength(1);
  expect(requests[0].cookies).toBeUndefined();

  await publish(key, id, { access: 'link', sharing: 'links' }, bindings);
  expect((await submit(id, [['access', 'link'], ['sharing', 'off']], bindings)).status).toBe(303);
  expect(await sharingOf(id)).toBe('off');
  expect(requests).toHaveLength(1);
  expect(await previewOf(id)).toBe(shot);
});

it("the owner page's boxes: Ask for email counts only with See how it's shared ticked, and the sheet shows what the page has", async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  const cookie = await ownerCookie(id);
  const sheet = async () => (await callApp(`/p/${id}/manage`, { headers: { Cookie: cookie } })).text();
  const draft = await sheet();
  expect(draft).toContain('<input type="checkbox" name="sharing" value="links">');
  expect(draft).toContain('<input type="checkbox" name="sharing" value="emails">');

  const published = await submit(id, [['access', 'link'], ['sharing', 'off'], ['sharing', 'emails']]);
  expect(published.headers.get('Location')).toBe(`/p/${id}/manage?done=published`);
  expect(await sharingOf(id)).toBe('off');

  const saved = await submit(id, [['access', 'link'], ['sharing', 'off'], ['sharing', 'links'], ['sharing', 'emails']]);
  expect(saved.headers.get('Location')).toBe(`/p/${id}/manage?done=shared`);
  expect(await sharingOf(id)).toBe('emails');
  const live = await (await callApp(`/p/${id}/manage?done=shared`, { headers: { Cookie: cookie } })).text();
  expect(live).toContain('<input type="checkbox" name="sharing" value="links" checked>');
  expect(live).toContain('<input type="checkbox" name="sharing" value="emails" checked>');
  expect(live).toContain('who allow it now get their own link and type an email');

  // An approval page has no boxes.
  expect((await submit(id, [['access', 'approval']])).headers.get('Location')).toBe(`/p/${id}/manage?done=switched-emails`);
  expect(await sharingOf(id)).toBe('off');
  expect(await sheet()).not.toContain('name="sharing"');
});

it('"sharing" sent without "access" keeps the page\'s access: an approval page stays approval, with sharing off; with neither, publish opens it to the link as before', async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  await publish(key, id, { access: 'approval' });
  expect(await json(await publish(key, id, { sharing: 'links' }))).toMatchObject({ access: 'approval', sharing: 'off' });
  expect(await json(await api(key, 'GET', `/api/pages/${id}`))).toMatchObject({ access: 'approval', sharing: 'off' });

  const { id: draft } = await createPage(key);
  expect(await json(await publish(key, draft, { sharing: 'emails' }))).toMatchObject({ access: 'link', sharing: 'emails' });
  expect(await json(await publish(key, id, {}))).toMatchObject({ access: 'link', sharing: 'off' });
});

/** The hidden fields of the Undo form in the panel's status line, in order. */
async function undoFields(id: string, done: string): Promise<[string, string][]> {
  const html = await (await callApp(`/p/${id}/manage?done=${done}`, { headers: { Cookie: await ownerCookie(id) } })).text();
  const form = /<div class="status"[^>]*>.*?<form [^>]*>(.*?)<button[^>]*>Undo<\/button><\/form>/s.exec(html)?.[1];
  if (form === undefined) throw new Error(`No Undo on ${done}`);
  return [...form.matchAll(/<input type="hidden" name="(\w+)" value="(\w+)">/g)].map((m) => [m[1], m[2]]);
}

it.each(['links', 'emails'] as const)('Undo after a switch to approval puts back "%s", which approval had turned off', async (sharing) => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  await publish(key, id, { access: 'link', sharing });

  const switched = await submit(id, [['access', 'approval']]);
  expect(switched.headers.get('Location')).toBe(`/p/${id}/manage?done=switched-${sharing}`);
  expect(await sharingOf(id)).toBe('off');

  const undo = await submit(id, await undoFields(id, `switched-${sharing}`));
  expect(undo.headers.get('Location')).toBe(`/p/${id}/manage?done=switched`);
  expect(await json(await api(key, 'GET', `/api/pages/${id}`))).toMatchObject({ access: 'link', sharing });

  // Undoing that goes back to approval; a page without sharing gets a plain Undo that keeps what it has.
  expect(await undoFields(id, 'switched')).toEqual([['access', 'approval']]);
});

const displayName = async (tester: string) => (await sql<{ display_name: string | null }[]>`select display_name from testers where name = ${tester}`)[0].display_name;
const nameBox = (html: string) => /<input class="input" id="name-sheet" name="name" value="([^"]*)"/.exec(html)?.[1];

it("asks a draft's Publish once for the author's name, prefilled from the email; only with the link, and never overwritten", async () => {
  const key = await addTester('amy');
  await sql`update testers set email = 'amy.rivera@example.com' where name = 'amy'`;
  const [{ id: first }, { id: second }] = [await createPage(key), await createPage(key)];
  const sheet = async (id: string) => (await callApp(`/p/${id}`, { headers: { Cookie: await ownerCookie(id) } })).text();
  expect(nameBox(await sheet(first))).toBe('Amy Rivera');

  // Approval does not count: the field was sent but still is asked.
  expect((await submit(first, [['access', 'approval'], ['name', 'Someone']])).status).toBe(303);
  expect(await displayName('amy')).toBeNull();

  expect((await submit(second, [['access', 'link'], ['name', '  Amy R.  ']])).status).toBe(303);
  expect(await displayName('amy')).toBe('Amy R.');
  await api(key, 'POST', `/api/pages/${first}/unpublish`);
  expect(nameBox(await sheet(first))).toBeUndefined();
  // A form sent before that still holds the field: it changes nothing.
  await submit(first, [['access', 'link'], ['name', 'Someone else']]);
  expect(await displayName('amy')).toBe('Amy R.');
});

it('a blank name is declined and never asked again', async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  expect((await submit(id, [['access', 'link'], ['name', '   ']])).status).toBe(303);
  expect(await displayName('amy')).toBe('');
});

it('half-typed emails left in the box after switching to "Anyone with the link" do not block Publish', async () => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  const published = await submit(id, [['access', 'link'], ['emails', 'omar@exa']]);
  expect(published.headers.get('Location')).toBe(`/p/${id}/manage?done=published`);
  expect(await json(await api(key, 'GET', `/api/pages/${id}`))).toMatchObject({ published: true, access: 'link' });
  // With approval the same text is still refused.
  const { id: other } = await createPage(key);
  expect((await submit(other, [['access', 'approval'], ['emails', 'omar@exa']])).status).toBe(400);
});

it.each([
  ['an email address', 'amy@example.com', 'Use your name, not an email address.'],
  ['more than 80 characters', 'a'.repeat(81), 'at most 80 characters'],
  ['a line break', 'Amy\nRivera', 'on one line'],
])('refuses a name with %s: nothing is saved or published, and the form comes back as sent: the link chosen, the boxes ticked, the name typed', async (_, name, message) => {
  const key = await addTester('amy');
  const { id } = await createPage(key);
  await publish(key, id, { access: 'approval' });
  await api(key, 'POST', `/api/pages/${id}/unpublish`);
  const refused = await submit(id, [['access', 'link'], ['sharing', 'off'], ['sharing', 'links'], ['sharing', 'emails'], ['name', name]]);
  expect(refused.status).toBe(400);
  const html = await refused.text();
  expect(html).toContain(message);
  expect(html).toContain('<input type="radio" name="access" value="link" checked>');
  expect(html).toContain('<input type="checkbox" name="sharing" value="links" checked>');
  expect(html).toContain('<input type="checkbox" name="sharing" value="emails" checked>');
  expect(nameBox(html)).toBe(name);
  expect(await displayName('amy')).toBeNull();
  expect(await json(await api(key, 'GET', `/api/pages/${id}`))).toMatchObject({ published: false, sharing: 'off' });
});

it("asks on a published link page's sharing form too, once; an approval page's sheet and Switch to this never ask", async () => {
  const key = await addTester('amy');
  const [{ id: approval }, { id: link }] = [await createPage(key), await createPage(key)];
  await publish(key, approval, { access: 'approval' });
  await publish(key, link, { access: 'link' });
  const sheet = async (id: string) => (await callApp(`/p/${id}`, { headers: { Cookie: await ownerCookie(id) } })).text();
  expect(nameBox(await sheet(approval))).toBeUndefined();
  expect(nameBox(await sheet(link))).toBe('amy');

  // Its sharing form refuses an email as the name and keeps the boxes as ticked.
  const refused = await submit(link, [['access', 'link'], ['sharing', 'off'], ['sharing', 'links'], ['name', 'amy@example.com']]);
  expect(refused.status).toBe(400);
  const html = await refused.text();
  expect(html).toContain('<input type="checkbox" name="sharing" value="links" checked>');
  expect(nameBox(html)).toBe('amy@example.com');
  expect(await sharingOf(link)).toBe('off');

  expect((await submit(link, [['access', 'link'], ['sharing', 'off'], ['sharing', 'links'], ['name', 'Amy']])).headers.get('Location')).toBe(`/p/${link}/manage?done=shared`);
  expect(await displayName('amy')).toBe('Amy');
  expect(nameBox(await sheet(link))).toBeUndefined();
});
