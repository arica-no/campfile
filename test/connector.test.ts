import { createHash, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { callApp, json, kvEntries, lastCode, sql, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const MAIN = 'https://app.test'; // APP_ORIGIN in the test env
const RESOURCE = `${MAIN}/mcp`;

/** Sends a GET, or a POST of the form, with the browser's cookies. */
type Browser = (path: string, form?: Record<string, string>) => Promise<Response>;

/** A registered app: the domain it connected at, its client id, PKCE verifier, redirect URI and the /authorize URL it opens. */
interface RegisteredApp {
  origin: string;
  clientId: string;
  verifier: string;
  redirect: string;
  authorize: string;
}

/** A browser: keeps the cookies the app sets and sends them back. */
function browser(origin = MAIN): Browser {
  const cookies = new Map<string, string>();
  return async (path: string, form?: Record<string, string>) => {
    const headers = new Headers({ Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') });
    if (form) headers.set('Content-Type', 'application/x-www-form-urlencoded');
    const response = await callApp(path, { method: form ? 'POST' : 'GET', headers, body: form && new URLSearchParams(form) }, undefined, origin);
    for (const cookie of response.headers.getSetCookie()) {
      const [, name, value] = /^([^=]+)=([^;]*)/.exec(cookie)!;
      if (/Max-Age=0\b/i.test(cookie)) cookies.delete(name);
      else cookies.set(name, value);
    }
    return response;
  };
}

/** Registers an app the way Claude does (dynamic client registration) and returns what it needs to sign in. */
async function registerApp(name = 'Claude', redirect = CALLBACK, origin = MAIN): Promise<RegisteredApp> {
  const registered = await callApp(
    '/oauth/register',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
    },
    undefined,
    origin,
  );
  expect(registered.status).toBe(201);
  const { client_id: clientId } = await json(registered);
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'the-state',
    resource: `${origin}/mcp`,
  });
  return { origin, clientId, verifier, redirect, authorize: `/authorize?${query}` };
}

const handleIn = async (response: Response) => /name="handle" value="([^"]+)"/.exec(await response.text())?.[1] ?? '';

/** Email screen → code screen; returns the code screen's consent handle. */
async function askCode(go: Browser, authorize: string, email = 'amy@example.com') {
  expect((await go(authorize)).status).toBe(200);
  const codeScreen = await go(authorize, { step: 'email', email });
  expect(codeScreen.status).toBe(200);
  return handleIn(codeScreen);
}

/** Trades the authorization code in a redirect for tokens, as the app does. */
async function tokens(app: RegisteredApp, redirect: Response): Promise<{ access_token: string; refresh_token: string }> {
  const location = new URL(redirect.headers.get('Location')!);
  const { token_endpoint: endpoint } = await json(await callApp('/.well-known/oauth-authorization-server', undefined, undefined, app.origin));
  const response = await callApp(
    new URL(endpoint).pathname,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: location.searchParams.get('code')!,
        redirect_uri: app.redirect,
        client_id: app.clientId,
        code_verifier: app.verifier,
        resource: `${app.origin}/mcp`,
      }),
    },
    undefined,
    app.origin,
  );
  expect(response.status).toBe(200);
  return json(response);
}
const token = async (app: RegisteredApp, redirect: Response) => (await tokens(app, redirect)).access_token;

const tool = (accessToken: string, name: string, args: unknown, origin = MAIN) =>
  callApp(
    '/mcp',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    },
    undefined,
    origin,
  );
const createPage = (accessToken: string, origin = MAIN) => tool(accessToken, 'create_page', { title: 'From Claude', html: '<p>hi</p>' }, origin);

it('connects Claude: email, code and approval on one page, then tool calls land in that workspace', async () => {
  const app = await registerApp();
  const go = browser();
  const handle = await askCode(go, app.authorize);

  const redirect = await go(app.authorize, { step: 'code', email: 'amy@example.com', handle, code: lastCode('amy@example.com'), decision: 'approve' });
  expect(redirect.status).toBe(302);
  const location = new URL(redirect.headers.get('Location')!);
  expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
  expect(location.searchParams.get('state')).toBe('the-state');
  expect(location.searchParams.get('iss')).toBe('https://app.test');

  const response = await createPage(await token(app, redirect));
  expect(response.status).toBe(200);
  expect((await json(response)).result.isError).toBeFalsy();
  expect(await sql`select t.email from pages p join testers t on t.id = p.owner`).toEqual([{ email: 'amy@example.com' }]);
});

it('shows the app, whether its name is verified, and where access goes, escaping what the app sent', async () => {
  const app = await registerApp('<img src=x onerror=alert(1)>', 'http://127.0.0.1:33418/callback');
  const go = browser();
  await go(app.authorize);
  const page = await (await go(app.authorize, { step: 'email', email: 'amy@example.com' })).text();
  expect(page).toContain('img src=x onerror=alert(1)');
  expect(page).not.toContain('<img');
  expect(page).toContain('registered itself, so its name is not verified');
  expect(page).toContain('127.0.0.1');
  expect(page).toContain('an app on your computer');
});

it('asks for a token on /mcp without one, pointing at the resource metadata', async () => {
  const response = await callApp('/mcp', { method: 'POST', body: '{}' });
  expect(response.status).toBe(401);
  expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata="https://app.test/.well-known/oauth-protected-resource/mcp"');
  const metadata = await json(await callApp('/.well-known/oauth-protected-resource/mcp'));
  expect(metadata).toMatchObject({ resource: RESOURCE, authorization_servers: ['https://app.test'] });
});

it('Deny sends the app access_denied and grants nothing', async () => {
  const app = await registerApp();
  const go = browser();
  const handle = await askCode(go, app.authorize);
  const denied = await go(app.authorize, { step: 'code', email: 'amy@example.com', handle, code: '', decision: 'deny' });
  expect(denied.status).toBe(302);
  expect(new URL(denied.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
  expect([...kvEntries.keys()].filter((key) => key.startsWith('grant:'))).toEqual([]);
});

it('a wrong code shows the code screen again; a handle used from another browser does not authorize', async () => {
  const app = await registerApp();
  const go = browser();
  const handle = await askCode(go, app.authorize);
  const code = lastCode('amy@example.com');
  const wrong = await go(app.authorize, { step: 'code', email: 'amy@example.com', handle, code: code === '000000' ? '111111' : '000000', decision: 'approve' });
  expect(wrong.status).toBe(400);
  expect(await wrong.text()).toContain('name="code"');

  // Someone else's browser has no consent cookie for this handle, so even the right code does not send access anywhere.
  const other = await browser()(app.authorize, { step: 'code', email: 'amy@example.com', handle, code, decision: 'approve' });
  expect(other.status).toBe(400);
  expect(other.headers.get('Location')).toBeNull();
});

it('a signed-in browser goes straight back for an approved app, and asks only for approval for a new one', async () => {
  const claude = await registerApp();
  const go = browser();
  const handle = await askCode(go, claude.authorize);
  await go(claude.authorize, { step: 'code', email: 'amy@example.com', handle, code: lastCode('amy@example.com'), decision: 'approve' });

  const again = await go(claude.authorize);
  expect(again.status).toBe(302);
  expect(new URL(again.headers.get('Location')!).searchParams.get('code')).toBeTruthy();

  const other = await registerApp('Other app');
  const connect = await go(other.authorize);
  expect(connect.status).toBe(200);
  const page = await connect.text();
  expect(page).toContain('amy@example.com');
  expect(page).not.toContain('name="code"');
  const redirect = await go(other.authorize, { step: 'connect', handle: /name="handle" value="([^"]+)"/.exec(page)![1], decision: 'approve' });
  expect(redirect.status).toBe(302);
  expect((await createPage(await token(other, redirect))).status).toBe(200);

  const switched = await go(other.authorize, { step: 'switch' });
  expect(await switched.text()).toContain('name="email"');
  expect((await go(other.authorize)).status).toBe(200); // signed out: the email screen again, not a redirect
});

it('who_am_i names the account and its connected apps, marks the caller, and lists no other account’s apps', async () => {
  const claude = await registerApp();
  const go = browser();
  const handle = await askCode(go, claude.authorize);
  const claudeToken = await token(claude, await go(claude.authorize, { step: 'code', email: 'amy@example.com', handle, code: lastCode('amy@example.com'), decision: 'approve' }));
  expect((await createPage(claudeToken)).status).toBe(200);

  const local = await registerApp('Local app', 'http://127.0.0.1:33418/callback');
  const connect = await handleIn(await go(local.authorize));
  const localToken = await token(local, await go(local.authorize, { step: 'connect', handle: connect, decision: 'approve' }));

  const bob = await registerApp('Bob app', 'https://bob.example/callback');
  const bobBrowser = browser();
  const bobHandle = await askCode(bobBrowser, bob.authorize, 'bob@example.com');
  await token(bob, await bobBrowser(bob.authorize, { step: 'code', email: 'bob@example.com', handle: bobHandle, code: lastCode('bob@example.com'), decision: 'approve' }));

  const answer = (await json(await tool(localToken, 'who_am_i', {}))).result;
  expect(answer.isError).toBeFalsy();
  const me = JSON.parse(answer.content[0].text);
  expect(me).toMatchObject({ email: 'amy@example.com', pages: 1 });
  const apps = me.connected_apps.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
  expect(apps).toMatchObject([
    { name: 'Claude', returns_to: 'claude.ai', this_connection: false },
    { name: 'Local app', returns_to: '127.0.0.1:33418', this_connection: true },
  ]);
  for (const app of apps) expect(Math.abs(Date.parse(app.last_active) - Date.now())).toBeLessThan(60_000); // just got its token
});

it('shows a page, not a redirect, for an unknown app', async () => {
  const response = await callApp('/authorize?response_type=code&client_id=nobody&redirect_uri=https%3A%2F%2Fevil.test%2F&code_challenge=x&code_challenge_method=S256');
  expect(response.status).toBe(400);
  expect(response.headers.get('Location')).toBeNull();
});

it('stops a disabled workspace: its tokens get 403 and its browser session no longer signs in', async () => {
  const app = await registerApp();
  const go = browser();
  const handle = await askCode(go, app.authorize);
  const redirect = await go(app.authorize, { step: 'code', email: 'amy@example.com', handle, code: lastCode('amy@example.com'), decision: 'approve' });
  const accessToken = await token(app, redirect);
  await sql`update testers set disabled_at = now()`;
  expect((await createPage(accessToken)).status).toBe(403);
  expect((await go(app.authorize)).status).toBe(200); // the email screen

  const handle2 = await askCode(go, app.authorize);
  const refused = await go(app.authorize, { step: 'code', email: 'amy@example.com', handle: handle2, code: lastCode('amy@example.com'), decision: 'approve' });
  expect(refused.status).toBe(400);
  expect(refused.headers.get('Location')).toBeNull();
});
