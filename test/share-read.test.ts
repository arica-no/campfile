import { expect, it } from 'vitest';
import { arrive, arriveAi } from '../src/sharing.ts';
import { addTester, api, callViewer, createPage, json, mcp, sql, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

/** tools/call through the connector; returns the JSON-RPC result. */
async function call(key: string, name: string, args: object) {
  const response = await mcp(key, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  expect(response.status).toBe(200);
  return (await json(response)).result;
}
const answer = async (key: string, name: string, args: object) => JSON.parse((await call(key, name, args)).content[0].text);

/** A browser's secret key for one page (KEY: 22 base62 characters). */
const key = (n: number) => `k${String(n).padStart(21, '0')}`;

/** Four entries: a browser through the author's link, who brings b@, who brings a third; and Claude through the author's link. Returns the codes. */
async function spread(page: string) {
  const a = (await arrive(sql, { page, via: null, key: key(1), label: null, country: 'NO', device: 'phone' })).code!;
  const b = (await arrive(sql, { page, via: a, key: key(2), label: 'b@example.com', country: 'SE', device: 'computer' })).code!;
  const c = (await arrive(sql, { page, via: b, key: key(3), label: null, country: null, device: null })).code!;
  const ai = (await arriveAi(sql, { page, via: null, ai: 'Claude', country: 'US' }))!;
  return [a, b, c, ai];
}

const tree = {
  sharing: 'links',
  entries: 4,
  capped: false,
  brought: 2,
  children: [
    {
      label: null, ai: null, country: 'NO', device: 'phone', brought: 1, reached: 2,
      children: [{ label: 'b@example.com', ai: null, country: 'SE', device: 'computer', brought: 1, reached: 1, children: [{ label: null, ai: null, brought: 0, reached: 0, children: [] }] }],
    },
    { label: null, ai: 'Claude', country: 'US', brought: 0, reached: 0, children: [] },
  ],
};

it("answers the owner's GET /api/pages/:id/sharing with the tree, codes left out, and another tester's with 404", async () => {
  const amy = await addTester('amy');
  const bob = await addTester('bob');
  const { id } = await createPage(amy);
  expect((await api(amy, 'POST', `/api/pages/${id}/publish`, { access: 'link', sharing: 'links' })).status).toBe(200);
  const codes = await spread(id);

  const response = await api(amy, 'GET', `/api/pages/${id}/sharing`);
  expect(response.status).toBe(200);
  const body = await json(response);
  expect(body).toMatchObject(tree);
  expect(new Date(body.children[0].first_opened).toISOString()).toBe(body.children[0].first_opened);
  for (const code of codes) expect(JSON.stringify(body)).not.toContain(`"${code}"`);

  const other = await api(bob, 'GET', `/api/pages/${id}/sharing`);
  expect(other.status).toBe(404);
  expect(JSON.stringify(await json(other))).not.toContain('b@example.com');
});

it("clears the tree on the owner's DELETE /api/pages/:id/sharing only, and the page and readers' links still open", async () => {
  const amy = await addTester('amy');
  const bob = await addTester('bob');
  const { id } = await createPage(amy);
  await api(amy, 'POST', `/api/pages/${id}/publish`, { access: 'link', sharing: 'links' });
  const [code] = await spread(id);

  expect((await api(bob, 'DELETE', `/api/pages/${id}/sharing`)).status).toBe(404);
  expect((await json(await api(amy, 'GET', `/api/pages/${id}/sharing`))).entries).toBe(4);

  const cleared = await api(amy, 'DELETE', `/api/pages/${id}/sharing`);
  expect(cleared.status).toBe(200);
  expect(await json(cleared)).toEqual({ cleared: 4 });
  expect(await json(await api(amy, 'GET', `/api/pages/${id}/sharing`))).toMatchObject({ sharing: 'links', entries: 0, brought: 0, children: [] });
  expect(await json(await api(amy, 'GET', `/api/pages/${id}`))).toMatchObject({ published: true, sharing: 'links' });
  for (const path of [`/${id}`, `/${id}-${code}`]) expect(await (await callViewer(path)).text(), path).toContain('<iframe');
});

it('takes sharing in publish_page, keeps it when left out, and get_sharing and clear_sharing answer like the API', async () => {
  const owner = await addTester('amy');
  const { id } = await answer(owner, 'create_page', { title: 'Hi', html: '<h1>Hi</h1>' });

  expect((await call(owner, 'publish_page', { id, access: 'link', sharing: 'emails' })).isError).toBeUndefined();
  expect(await answer(owner, 'get_page', { id })).toMatchObject({ access: 'link', sharing: 'emails' });
  await call(owner, 'publish_page', { id, access: 'link' });
  expect(await answer(owner, 'get_page', { id })).toMatchObject({ sharing: 'emails' });
  const refused = await call(owner, 'publish_page', { id, sharing: 'everyone' });
  expect(refused.isError).toBe(true);
  expect((await answer(owner, 'list_pages', {})).pages[0]).toMatchObject({ id, sharing: 'emails' });

  await call(owner, 'publish_page', { id, sharing: 'links' });
  await spread(id);
  const read = await call(owner, 'get_sharing', { id });
  expect(read.isError).toBeUndefined();
  expect(JSON.parse(read.content[0].text)).toEqual(await json(await api(owner, 'GET', `/api/pages/${id}/sharing`)));
  expect(JSON.parse(read.content[0].text)).toMatchObject(tree);

  expect(await answer(owner, 'clear_sharing', { id })).toEqual({ cleared: 4 });
  expect(await answer(owner, 'get_sharing', { id })).toMatchObject({ entries: 0, children: [] });
  expect((await call(await addTester('bob'), 'clear_sharing', { id })).isError).toBe(true);
});

it('publish_page with sharing but no access keeps an approval page approval, with sharing off', async () => {
  const owner = await addTester('amy');
  const { id } = await answer(owner, 'create_page', { title: 'Hi', html: '<h1>Hi</h1>' });
  await call(owner, 'publish_page', { id, access: 'approval' });
  expect(await answer(owner, 'publish_page', { id, sharing: 'links' })).toMatchObject({ access: 'approval', sharing: 'off' });
});
