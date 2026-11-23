// The connector for Claude Desktop and claude.ai: `<app>/mcp` behind OAuth 2.1 (@cloudflare/workers-oauth-provider), signed in with an email code.
// docs/SPEC.md "Sign-in and workspaces". The library serves discovery, client registration, tokens and the protected resource; /authorize is ours.
import {
  AuthorizationError,
  CimdFetchError,
  OAuthAuthorizationServer,
  OAuthResourceServer,
  type AuthRequest,
  type OAuthHelpers,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { CLIENT_IP } from './client.ts';
import { withDb, type DbVariables } from './db.ts';
import type { AppEnv } from './env.ts';
import { groupService } from './groups.ts';
import { escapeHtml, FAVICON_LINKS } from './html.ts';
import { oldCookie, readSignedId, signedId } from './keys.ts';
import { handleMcp } from './mcp.ts';
import { activeTester, CampfileError, pageService, type PageService, type Tester } from './pages.ts';
import { checkCode, CODE_MINUTES, codeInput, email, noEmailNote, passwordIntro, sendCode, TERMS_NOTICE } from './signin.ts';

/** What a connector token carries: the workspace it was issued for. */
interface Props {
  tester: number;
}

type Env = { Bindings: AppEnv; Variables: DbVariables };

const DAY = 24 * 60 * 60;
const SESSION_DAYS = 30;
/** A connector in use stays signed in; one left alone this many days signs in again. */
export const CONNECTOR_IDLE_DAYS = 30;
const CONNECTOR_IDLE = CONNECTOR_IDLE_DAYS * DAY;
export const SESSION_COOKIE = '__Host-campfile-session';
const DISABLED = 'This account is disabled. Ask the Campfile admin about it.';

// Each tool call through the connector, once the library has checked the token.
const connectorMcp = new Hono<Env>();
connectorMcp.on(['GET', 'DELETE'], '*', (c) => c.json({ error: 'This connector only accepts POST requests.' }, 405, { Allow: 'POST' }));
connectorMcp.post('*', withDb, async (c) => {
  // Hono types executionCtx as its own ExecutionContext; the library hands the handler its resource context, which adds the token's props and auth.
  const { props, auth } = c.executionCtx as unknown as OAuthResourceContext<Props>;
  const tester = await activeTester(c.var.sql, props.tester);
  if (!tester) return c.json({ error: DISABLED }, 403);
  const pages = pageService(c.var.sql, c.env, tester, c.var.waitUntil);
  // A token reads `{userId}:{grantId}:{secret}` (the library's format), so it names its own grant: two installs of one app share a client id.
  return handleMcp(c.req.raw, pages, groupService(c.var.sql, c.env, tester, c.var.waitUntil), () => whoAmI(c, tester, pages, auth.token.split(':')[1]));
});

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** who_am_i: the workspace this connection acts for and every app connected to it. Only this workspace's own grants are listed. */
async function whoAmI(c: Context<Env>, tester: Tester, pages: PageService, grantId: string | undefined) {
  const api = oauth(c.req.raw).authorization.getOAuthApi(c.env);
  // shortcut: one page of up to 1000 grants (the library's maximum); page through `cursor` if a workspace ever has more.
  const [[account], { pages: list }, { items }] = await Promise.all([
    c.var.sql<{ email: string | null }[]>`select email from testers where id = ${tester.id}`,
    pages.list(),
    api.listUserGrants(String(tester.id), { limit: 1000 }),
  ]);
  const apps = await Promise.all(
    items.map(async (grant) => {
      // A client-id metadata document is fetched from the app's site and can fail; the grant itself still counts.
      const client = await api.lookupClient(grant.clientId).catch(() => null);
      return {
        name: client?.clientName ?? null, // chosen by the app itself
        // The callback this sign-in's code went to, as recorded on the grant (absent on old grants). The app registered it, so it is not proof of who the app is.
        returns_to: grant.redirectUri ? new URL(grant.redirectUri).host : null,
        connected: iso(grant.createdAt),
        // Each token the app gets (the first one or a refresh) pushes the grant's expiry to CONNECTOR_IDLE ahead; access tokens last an hour.
        last_active: grant.expiresAt ? iso(grant.expiresAt - CONNECTOR_IDLE) : null,
        this_connection: grant.id === grantId,
      };
    }),
  );
  return { account: tester.name, email: account?.email ?? null, pages: list.length, connected_apps: apps };
}

// Each domain the app answers on (the main address and any alias) is its own issuer and resource, so a connector added at either address keeps working there.
const servers = new Map<string, { authorization: OAuthAuthorizationServer<AppEnv>; resource: OAuthResourceServer<AppEnv, Props> }>();
function oauth(request: Request) {
  const origin = new URL(request.url).origin;
  let found = servers.get(origin);
  if (!found) {
    const resource = `${origin}/mcp`;
    const authorization = new OAuthAuthorizationServer<AppEnv>({
      issuer: origin,
      resources: [resource],
      clientRegistrationEndpoint: '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      refreshTokenIdleTTL: CONNECTOR_IDLE,
    });
    found = {
      authorization,
      resource: new OAuthResourceServer<AppEnv, Props>({
        resourceMetadata: { resource, authorization_servers: [origin], resource_name: 'Campfile' },
        validateToken: (env) => (resource, token) => authorization.validateToken(resource, token, env),
        handler: { fetch: (request, env, ctx) => connectorMcp.fetch(request, env, ctx) },
      }),
    };
    servers.set(origin, found);
  }
  return found;
}

export const connector = new Hono<Env>();

// Library-owned: authorization server metadata, client registration, token and revocation; protected resource metadata and the resource itself.
connector.all('/.well-known/oauth-authorization-server', (c) => oauth(c.req.raw).authorization.fetch(c.req.raw, c.env, c.executionCtx));
connector.all('/oauth/*', (c) => oauth(c.req.raw).authorization.fetch(c.req.raw, c.env, c.executionCtx));
connector.all('/.well-known/oauth-protected-resource/*', (c) => oauth(c.req.raw).resource.fetch(c.req.raw, c.env, c.executionCtx));
connector.all('/mcp', (c) => oauth(c.req.raw).resource.fetch(c.req.raw, c.env, c.executionCtx));

// --- The sign-in page at /authorize ---------------------------------------------------------------------------
// GET: a signed-in browser whose approval for this app is remembered goes straight back to the app. Otherwise one of three screens:
//   email  → send a code  → code + consent ("Verify and connect")
//   a session cookie skips the email step: consent alone ("Connect").
// A correct code alone never authorizes an app: any app can register itself with its own redirect URI, so the user approves where access goes.

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The headers every app screen sends: not framed, not cached, no referrer, and `csp` as its Content Security Policy. */
export function screenHeaders(csp: string, headers = new Headers()): Headers {
  headers.set('Content-Security-Policy', csp);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  return headers;
}

export function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  screenHeaders(PAGE_CSP, headers); // replaces beginConsent()'s CSP, which is only frame-ancestors 'none'
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${FAVICON_LINKS}
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--surface:#fff;--panel:#f6f5f2;--ink:#1d1d1b;--muted:#555;--accent:#9a3412;--control:#bbb;--line:#ddd;--rule:#eee;--field:Field;--field-ink:FieldText;--focus:#e06c1f;--primary:#c2410c;--primary-ink:#fff;--error-bg:#fde8e1;--error:#7c2d12;--shadow:#0002}
/* Dark: src/wall-style.ts's ember roles. Links, warning and focus in flame; the primary fill stays, white on it is 5.2:1. */
@media (prefers-color-scheme:dark){:root{--bg:#16130f;--surface:#1f1a14;--panel:#2a241c;--ink:#f4eee6;--muted:#b5a894;--accent:#f2a541;--control:rgba(244,238,230,.28);--line:rgba(244,238,230,.12);--rule:rgba(244,238,230,.12);--field:#0f0c09;--field-ink:#f4eee6;--focus:#f2a541;--error-bg:#3a271f;--error:#ff8a70;--shadow:#0008}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:17px/1.5 system-ui,sans-serif}
a{color:var(--accent)}
h2{margin:1.75rem 0 .25rem;font-size:1.1rem}
textarea{box-sizing:border-box;width:100%;padding:.7rem .8rem;font:inherit;border:1px solid var(--control);border-radius:8px;background:var(--field);color:var(--field-ink)}
textarea:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
fieldset{margin:1rem 0 0;padding:0;border:0}
legend{font-weight:600;margin-bottom:.35rem}
label.choice{display:flex;gap:.6rem;align-items:flex-start;margin:.5rem 0;padding:.75rem;border:1px solid var(--line);border-radius:10px;font-weight:400;cursor:pointer}
label.choice input{width:auto;margin:.3rem 0 0}
.people{list-style:none;margin:0;padding:0}
.people li{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.6rem 0;border-top:1px solid var(--rule)}
.people li>span{flex:1;min-width:10rem;overflow-wrap:anywhere}
.people form{display:flex;gap:.4rem}
.people button,button.inline{width:auto;margin:0;padding:.45rem .8rem}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:6px;background:var(--panel);font-size:.85rem;font-weight:600}
main{box-sizing:border-box;width:min(30rem,calc(100% - 2rem));margin:2rem 0;padding:2rem;background:var(--surface);border-radius:14px;box-shadow:0 1px 3px var(--shadow)}
h1{margin:0 0 .5rem;font-size:1.4rem;line-height:1.3}
p{margin:.5rem 0}
label{display:block;margin:1.25rem 0 .35rem;font-weight:600}
input{box-sizing:border-box;width:100%;padding:.7rem .8rem;font:inherit;border:1px solid var(--control);border-radius:8px;background:var(--field);color:var(--field-ink)}
input[name=code]{font-size:1.5rem;letter-spacing:.35em;text-align:center}
input:focus-visible,button:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
button{margin-top:1rem;width:100%;padding:.75rem;font:inherit;font-weight:600;border-radius:8px;border:0;background:var(--primary);color:var(--primary-ink);cursor:pointer}
button.secondary{background:none;color:var(--ink);border:1px solid var(--control)}
button.link{width:auto;margin:0;padding:0;background:none;color:var(--accent);font-weight:400;text-decoration:underline}
.access{margin-top:1.5rem;padding:1rem;border-radius:10px;background:var(--panel)}
.warning{color:var(--accent)}
.error{padding:.6rem .8rem;border-radius:8px;background:var(--error-bg);color:var(--error)}
.muted{color:var(--muted);font-size:.95rem}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`,
    { status, headers },
  );
}

export const errorLine = (error?: string) => (error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '');

function emailScreen(env: AppEnv, address = '', error?: string): Response {
  return page(
    'Sign in to Campfile',
    `<h1>Sign in to Campfile</h1>
<p>${env.EMAIL_IN_LOG ? `Enter your email. ${noEmailNote(env)}` : `Enter your email and we'll send you a 6-digit code. New here? The same code makes your account.`}</p>
${errorLine(error)}
<form method="post">
<input type="hidden" name="step" value="email">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus value="${escapeHtml(address)}">
<button type="submit">${env.EMAIL_IN_LOG ? 'Continue' : 'Send code'}</button>
</form>`,
    error ? 400 : 200,
  );
}

/** What the user approves: the app, how far its name can be trusted, and where access goes. Every value from the client is escaped. */
async function accessBox(api: OAuthHelpers, request: AuthRequest): Promise<string> {
  const app = await api.describeConsent(request);
  const name = escapeHtml(app.clientName);
  const origin = app.clientDomain
    ? `It is published by <strong>${escapeHtml(app.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  const local = app.redirectIsLoopback
    ? '<p class="warning"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>'
    : '';
  return `<div class="access">
<p><strong>${name}</strong> wants to create, update, publish and delete your Campfile pages.</p>
<p class="muted">${origin} Access will be sent to <strong>${escapeHtml(app.redirectHost)}</strong>.</p>
${local}
</div>`;
}

const denyButton = '<button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Deny</button>';

async function codeScreen(env: AppEnv, api: OAuthHelpers, request: AuthRequest, address: string, handle: string, error?: string, headers?: Headers): Promise<Response> {
  const password = passwordIntro(env, address);
  return page(
    password ? 'Type your password' : 'Enter your code',
    `${password
      ?? (env.EMAIL_IN_LOG
      ? `<h1>Get your code from the server</h1>
<p>This server has no email set up, so nothing was sent to <strong>${escapeHtml(address)}</strong>. On the server, in the selfhost folder, run <strong>docker compose logs campfile</strong> and type the 6-digit code from its last lines here. It works for ${CODE_MINUTES} minutes.</p>`
      : `<h1>Check your email</h1>
<p>We sent a 6-digit code to <strong>${escapeHtml(address)}</strong>. It works for ${CODE_MINUTES} minutes. Not in your inbox? Check your spam folder.</p>`)}
${errorLine(error)}
<form method="post">
<input type="hidden" name="step" value="code">
<input type="hidden" name="email" value="${escapeHtml(address)}">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
${codeInput(env, address)}
${await accessBox(api, request)}
<button type="submit" name="decision" value="approve">Verify and connect</button>
${denyButton}
</form>
${TERMS_NOTICE}
<form method="post"><input type="hidden" name="step" value="switch"><p class="muted">Wrong email or no code? <button class="link" type="submit">Start again</button></p></form>`,
    error ? 400 : 200,
    headers,
  );
}

async function connectScreen(api: OAuthHelpers, request: AuthRequest, address: string, handle: string, headers: Headers): Promise<Response> {
  return page(
    'Connect to Campfile',
    `<h1>Connect to Campfile</h1>
<p>Signed in as <strong>${escapeHtml(address)}</strong>.</p>
<form method="post">
<input type="hidden" name="step" value="connect">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
${await accessBox(api, request)}
<button type="submit" name="decision" value="approve">Connect</button>
${denyButton}
</form>
<form method="post"><input type="hidden" name="step" value="switch"><p class="muted">Not you? <button class="link" type="submit">Use another email</button></p></form>`,
    200,
    headers,
  );
}

export const sessionClearCookies = [SESSION_COOKIE, oldCookie(SESSION_COOKIE)].map((name) => `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);

/** The Set-Cookie value that signs this browser in to the workspace for SESSION_DAYS. SameSite=Lax: a form on another site cannot post with it. */
export async function sessionSetCookie(secret: string, tester: number): Promise<string> {
  const value = await signedId(secret, 'session', tester, Math.floor(Date.now() / 1000) + SESSION_DAYS * DAY);
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_DAYS * DAY}; HttpOnly; Secure; SameSite=Lax`;
}

/** The signed-in workspace and its email, if the browser has a valid session for a workspace that is not disabled. Also the owner check of src/manage.ts. */
export async function session(c: Context<Env>): Promise<{ tester: number; email: string } | undefined> {
  const tester = await sessionId(c);
  if (tester === undefined) return undefined;
  const [row] = await c.var.sql<{ email: string }[]>`select coalesce(email, name) as email from testers where id = ${tester} and disabled_at is null`;
  return row ? { tester, email: row.email } : undefined;
}

// The login cookie's signature only, no database call. Enough for the header's "Your pages": a disabled account still sees it, and /my then says so.
const sessionId = <E extends { Bindings: AppEnv }>(c: Context<E>) => readSignedId(c.env.CONSENT_SECRET, 'session', getCookie(c, SESSION_COOKIE) ?? getCookie(c, oldCookie(SESSION_COOKIE)));
export const hasSession = async <E extends { Bindings: AppEnv }>(c: Context<E>) => (await sessionId(c)) !== undefined;

/** Issues the authorization code and sends the browser back to the app, signed in for next time. */
async function finish(c: Context<Env>, api: OAuthHelpers, request: AuthRequest, tester: number, headers = new Headers()): Promise<Response> {
  const { redirectTo } = await api.completeAuthorization({ request, userId: String(tester), metadata: {}, scope: request.scope, props: { tester } satisfies Props });
  headers.append('Set-Cookie', await sessionSetCookie(c.env.CONSENT_SECRET, tester));
  headers.set('Location', redirectTo);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

/** Approves the consent handle (remembering it for this workspace) and finishes. */
async function approve(c: Context<Env>, api: OAuthHelpers, handle: string, tester: number): Promise<Response> {
  const approved = await api.approveConsent(c.req.raw, handle, { remember: { secret: c.env.CONSENT_SECRET, subject: String(tester) } });
  return finish(c, api, approved.request, tester, approved.headers);
}

async function deny(c: Context<Env>, api: OAuthHelpers, handle: string): Promise<Response> {
  const denied = await api.denyConsent(c.req.raw, handle);
  return new Response(null, { status: 302, headers: denied.headers });
}

// Errors the library expects: a request it could validate goes back to the app with the error; anything else is shown here, never redirected.
function oauthFailure(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
    return page(
      'Sign-in problem',
      `<h1>This sign-in link doesn't work</h1>${errorLine(message)}<p>Go back to the app you were connecting and start again from there.</p>`,
      400,
    );
  }
  throw error;
}

connector.get('/authorize', withDb, async (c) => {
  try {
    const api = oauth(c.req.raw).authorization.getOAuthApi(c.env);
    const request = await api.parseAuthRequest(c.req.raw);
    const signedIn = await session(c);
    if (!signedIn) return emailScreen(c.env);
    if (await api.isConsentRemembered(c.req.raw, request, { secret: c.env.CONSENT_SECRET, subject: String(signedIn.tester) })) {
      return await finish(c, api, request, signedIn.tester);
    }
    const consent = await api.beginConsent(request);
    return await connectScreen(api, request, signedIn.email, consent.handle, consent.headers);
  } catch (error) {
    return oauthFailure(error);
  }
});

connector.post(
  '/authorize',
  bodyLimit({ maxSize: 8192, onError: (c) => c.text('That request is too big.', 413) }),
  withDb,
  async (c) => {
    try {
      const api = oauth(c.req.raw).authorization.getOAuthApi(c.env);
      const request = await api.parseAuthRequest(c.req.raw);
      const form = await c.req.parseBody();
      const field = (name: string) => (typeof form[name] === 'string' ? form[name] : '');
      const handle = field('handle');

      switch (field('step')) {
        case 'email': {
          const parsed = email.safeParse(field('email'));
          if (!parsed.success) return emailScreen(c.env, field('email'), parsed.error.issues[0].message);
          try {
            await sendCode(c.var.sql, c.env, parsed.data, c.req.header(CLIENT_IP) ?? 'unknown');
          } catch (error) {
            if (error instanceof CampfileError) return emailScreen(c.env, parsed.data, error.message);
            throw error;
          }
          const consent = await api.beginConsent(request);
          return await codeScreen(c.env, api, request, parsed.data, consent.handle, undefined, consent.headers);
        }
        case 'code': {
          if (field('decision') === 'deny') return await deny(c, api, handle);
          const parsed = email.safeParse(field('email'));
          if (!parsed.success) return emailScreen(c.env);
          let tester: number;
          try {
            tester = await checkCode(c.var.sql, parsed.data, field('code'), { env: c.env, waitUntil: c.var.waitUntil, via: 'connecting an AI app (the MCP connector)' });
          } catch (error) {
            if (error instanceof CampfileError) return await codeScreen(c.env, api, request, parsed.data, handle, error.message);
            throw error;
          }
          return await approve(c, api, handle, tester);
        }
        case 'connect': {
          if (field('decision') === 'deny') return await deny(c, api, handle);
          const signedIn = await session(c);
          if (!signedIn) return emailScreen(c.env, undefined, 'Your sign-in has expired. Enter your email again.');
          return await approve(c, api, handle, signedIn.tester);
        }
        case 'switch': {
          const response = emailScreen(c.env);
          for (const clear of sessionClearCookies) response.headers.append('Set-Cookie', clear);
          return response;
        }
        default:
          return emailScreen(c.env);
      }
    } catch (error) {
      return oauthFailure(error);
    }
  },
);
