import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import postgres from 'postgres';
import { z } from 'zod';
import { CLIENT_IP } from './client.ts';
import { connector, hasSession } from './connector.ts';
import { withDb, type DbVariables } from './db.ts';
import type { AppEnv } from './env.ts';
import { groupService, type GroupService } from './groups.ts';
import { home } from './home.ts';
import { FAVICON_SVG } from './html.ts';
import { instructions } from './instructions.ts';
import { groupsListed, pagesListed, pagesMoved, shown } from './mcp.ts';
import { infoPage } from './site.ts';
import { senderAddress, SETUP_MARK, setupSteps } from './setup.ts';
import { manage } from './manage.ts';
import { authenticate, CampfileError, CRON_SHOTS, INTERNAL_ERROR, MAX_BODY_BYTES, pageService, parse, REQUEST_TOO_BIG, shootDue, sweepOrphans, TOO_BIG, type PageService } from './pages.ts';
import { CODE_MINUTES, issueKey, purgeExpired, sendCode, signinInput, signinWith } from './signin.ts';
import { robot } from './visits.ts';
import { SORT_ORDERS } from './wall.ts';

/** The daily cleanup's cron, as in the cron schedule. The other cron is the screenshot retry. */
const DAILY = '17 3 * * *';

const app = new Hono<{ Bindings: AppEnv; Variables: DbVariables & { pages: PageService; groups: GroupService } }>();

app.onError((error, c) => {
  if (error instanceof CampfileError) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: INTERNAL_ERROR }, 500);
});

app.notFound((c) => c.json({ error: `There is nothing at ${c.req.path}. Instructions for AI agents are at ${c.env.APP_ORIGIN}/agents` }, 404));

// www.<any of the app's hosts> goes to the same path without www.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname.startsWith('www.')) return c.redirect(`https://${url.hostname.slice(4)}${url.pathname}${url.search}`, 302);
  await next();
});

// A browser's GET / goes to its pages, which ask it to sign in first; on a self-hosted install it, and bots and link-preview fetchers, get the install's home page (src/home.ts). Anything else (curl, most agents) gets the instructions, so text that points an AI at / still works.
app.get('/', (c, next) => {
  const html = c.req.header('Accept')?.includes('text/html');
  if (c.env.SELF_HOSTED && (html || robot(c))) return next();
  return html ? c.redirect('/my', 302) : c.text(instructions(c.env.APP_ORIGIN), 200, { Vary: 'Accept, User-Agent' });
});
app.get('/', withDb, home);
app.get('/agents', (c) => c.text(instructions(c.env.APP_ORIGIN)));
// The info pages are fragments in public/, shown in the site's header and footer (src/site.ts). Where they name an address they hold {{APP_ORIGIN}}, {{VIEWER_HOST}} or {{SENDER}}, so every deployment shows its own; {{SIGNIN}} is what a login asks for besides the email.
app.get('/:page{docs|guide|pricing|support|privacy|terms}', async (c) => {
  // A bare request: the browser's If-None-Match names the unchanged file, and its 304 would keep a cached copy with other addresses.
  const file = await c.env.ASSETS.fetch(new Request(c.req.url));
  if (!file.ok) return file;
  const { APP_ORIGIN, VIEWER_ORIGIN, EMAIL_FROM } = c.env;
  const html = (await file.text()).replaceAll('{{APP_ORIGIN}}', APP_ORIGIN).replaceAll('{{VIEWER_HOST}}', new URL(VIEWER_ORIGIN).host).replaceAll('{{SENDER}}', senderAddress(EMAIL_FROM)).replaceAll('{{SIGNIN}}', signinWith(c.env));
  return c.html(infoPage(c.req.path, html.replace(SETUP_MARK, setupSteps(APP_ORIGIN, VIEWER_ORIGIN, EMAIL_FROM, c.env)), await hasSession(c)));
});
// /favicon.ico and /favicon-192.png are static files in public/ (FAVICON_LINKS in src/html.ts).
app.get('/favicon.svg', (c) => c.body(FAVICON_SVG, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }));

/** The request body must be JSON; anything else gets a message an AI can act on. */
async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new CampfileError(
      400,
      'The request body must be JSON, for example {"title": "My page", "html": "<h1>Hello</h1>"}, sent with the header "Content-Type: application/json".',
    );
  }
}

// CLI sign-in (docs/SPEC.md "Sign-in and workspaces"): email → code → a new key. No key needed, so these sit outside /api/pages.
const smallBody = bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: 'That request is too big.' }, 413) });
app.post('/api/signin', smallBody, withDb, async (c) => {
  const { email } = parse(signinInput, await jsonBody(c.req.raw));
  await sendCode(c.var.sql, c.env, email, c.req.header(CLIENT_IP) ?? 'unknown');
  const { OWNER_LOGIN, EMAIL_IN_LOG } = c.env;
  return c.json({
    sent: true,
    // Self-hosted without SMTP no code is emailed: the owner types their password, anyone else reads the code from the server log.
    message:
      OWNER_LOGIN?.email === email
        ? `This server is in single-user mode, so no code is emailed. Ask the user for their password (OWNER_PASSWORD in the server's .env) and send it as the code to POST /api/signin/verify.`
        : EMAIL_IN_LOG
          ? `This server has no email set up, so the 6-digit code for ${email} is in the server's log, not an inbox. Ask the user to run docker compose logs campfile in the server's selfhost folder and give you the code from its last lines. It works for ${CODE_MINUTES} minutes. Then send it to POST /api/signin/verify.`
          : `If ${email} can receive email, a 6-digit code is on its way. It works for ${CODE_MINUTES} minutes. Ask the user for it, and tell them to check their spam folder if it's not in their inbox. Then send it to POST /api/signin/verify.`,
  });
});
// Accept: text/plain answers the bare key, so `curl -f -o <file>` saves it without printing it (GET / step 4).
app.post('/api/signin/verify', smallBody, withDb, async (c) => {
  const signedIn = await issueKey(c.var.sql, await jsonBody(c.req.raw), { env: c.env, waitUntil: c.var.waitUntil, via: 'the CLI sign-in (an AI that runs commands)' });
  return c.req.header('Accept')?.includes('text/plain') ? c.text(signedIn.key) : c.json(signedIn);
});

// The tester key's API: pages, and the groups they sit in (docs/SPEC.md "Page groups").
for (const path of ['/api/pages/*', '/api/groups/*'])
  app.use(
    path,
    withDb,
    async (c, next) => {
      const key = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '')?.[1];
      const tester = await authenticate(c.var.sql, key);
      c.set('pages', pageService(c.var.sql, c.env, tester, c.var.waitUntil));
      c.set('groups', groupService(c.var.sql, c.env, tester, c.var.waitUntil));
      return bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: tester.unlimited ? REQUEST_TOO_BIG : TOO_BIG }, 413) })(c, next);
    },
  );

const sortQuery = z.enum(SORT_ORDERS, `sort must be one of: ${SORT_ORDERS.join(', ')}.`).optional();
const moveInput = z.object(
  {
    ids: z.array(z.string('ids must be a list of page ids.'), 'ids must be a list of page ids.').min(1, 'ids must name at least one page.'),
    group: z.string('group must be the id of one of your groups, or null to take the pages out of their group.').nullable(),
  },
  'The request body must be JSON like {"ids": ["PAGE_ID"], "group": "GROUP_ID"}.',
);

app.post('/api/pages/move', async (c) => {
  const { ids, group } = parse(moveInput, await jsonBody(c.req.raw));
  return c.json(await pagesMoved(c.var.groups, ids, group));
});

app.post('/api/pages', async (c) => c.json(await c.var.pages.create(await jsonBody(c.req.raw)), 201));
app.put('/api/pages/:id', async (c) => c.json(await c.var.pages.update(c.req.param('id'), await jsonBody(c.req.raw))));
app.delete('/api/pages/:id', async (c) => c.json(await c.var.pages.remove(c.req.param('id'))));
app.get('/api/pages', async (c) => c.json(await pagesListed(c.var.pages, c.var.groups, c.req.query('group'), parse(sortQuery, c.req.query('sort')))));
app.get('/api/pages/:id', async (c) => c.json(await c.var.pages.get(c.req.param('id'))));
// What the owner page's buttons do (src/manage.ts). The AI publishes only when the user explicitly asks (src/instructions.ts).
app.post('/api/pages/:id/publish', async (c) => c.json(await c.var.pages.publish(c.req.param('id'), await jsonBody(c.req.raw))));
app.post('/api/pages/:id/unpublish', async (c) => c.json(await c.var.pages.unpublish(c.req.param('id'))));
app.get('/api/pages/:id/people', async (c) => c.json(await c.var.pages.people(c.req.param('id'))));
app.post('/api/pages/:id/people', async (c) => c.json(await c.var.pages.letIn(c.req.param('id'), await jsonBody(c.req.raw))));
app.post('/api/pages/:id/people/decide', async (c) => c.json(await c.var.pages.decide(c.req.param('id'), await jsonBody(c.req.raw))));
app.get('/api/pages/:id/sharing', async (c) => c.json(await c.var.pages.sharing(c.req.param('id'))));
app.delete('/api/pages/:id/sharing', async (c) => c.json(await c.var.pages.clearSharing(c.req.param('id'))));
app.get('/api/groups', async (c) => c.json(await groupsListed(c.var.groups, parse(sortQuery, c.req.query('sort')))));
app.post('/api/groups', async (c) => {
  const { name, page_ids } = parse(z.object({ name: z.unknown(), page_ids: z.array(z.string(), 'page_ids must be a list of page ids.').optional() }, 'The request body must be JSON like {"name": "Group name"}.'), await jsonBody(c.req.raw));
  return c.json(shown(await c.var.groups.create(name, page_ids)), 201);
});
app.put('/api/groups/:id', async (c) => {
  const { name } = parse(z.object({ name: z.unknown() }, 'The request body must be JSON like {"name": "New name"}.'), await jsonBody(c.req.raw));
  return c.json(shown(await c.var.groups.rename(c.req.param('id'), name)));
});
// Only the group: its pages stay, in no group. To delete them too, delete each page first (DELETE /api/pages/:id), as the user confirms.
app.delete('/api/groups/:id', async (c) => c.json(await c.var.groups.remove(c.req.param('id'), { pages: 'keep' })));

// The owner's page: publish, unpublish and who can open it, behind the browser's email sign-in (src/manage.ts).
app.route('/', manage);

app.route('/', connector);

export default {
  fetch: app.fetch,
  // The daily cleanup.
  // And every 10 minutes up to CRON_SHOTS missing screenshots whose turn it is, where there is a screenshot service.
  async scheduled(controller: { cron: string }, env: AppEnv, ctx: { waitUntil(work: Promise<unknown>): void }) {
    const sql = postgres(env.DB.connectionString, { max: 1, fetch_types: false });
    try {
      if (controller.cron === DAILY) {
        await purgeExpired(sql);
        await sweepOrphans(sql, env.PAGES);
      }
      if (controller.cron !== DAILY) await shootDue(sql, env, (work) => ctx.waitUntil(work), CRON_SHOTS);
    } finally {
      await sql.end();
    }
  },
};
