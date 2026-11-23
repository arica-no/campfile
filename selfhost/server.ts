// One Node process for a self-hosted Campfile: one app/viewer address, or separate listeners for advanced isolation, with file stores and cron timers.
// Settings are environment variables (selfhost/.env.example, docs/DEPLOY.md). Run it from the repository root: node selfhost/server.ts
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import type { AppEnv, ViewerEnv } from '../src/env.ts';
import { screenshotService } from './screenshot-client.ts';
import { staticFiles } from './assets.ts';
import { readConfig, type Config } from './config.ts';
import { CRONS, schedule, SHOT_CRON } from './cron.ts';
import { inFlight, newContext, pending, serve } from './http.ts';
import { limitPosts } from './limit.ts';
import { guardOutbound, resolveHosts } from './outbound.ts';
import { singleOriginHandler } from './routing.ts';
import { FileBucket, FileKv } from './storage.ts';
import { titleCard } from './title-card.ts';

let config: Config;
try {
  config = readConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// Everything the code fetches from now on goes through the guard of outbound.ts: public addresses only, and none of this server's own, which the names of the two origins resolve to. Exempt: the app and the viewer, whose addresses the code fixes.
// It comes before the code loads, so that no module can keep a reference to the plain fetch.
guardOutbound({ allow: [config.appOrigin, config.viewerOrigin, ...(config.screenshot ? [config.screenshot.url] : [])], ownAddresses: await resolveHosts([config.appOrigin, config.viewerOrigin]) });

// The OAuth library imports `cloudflare:workers`, a module Node does not have: point that import at the stub. The imports below are dynamic because static ones run before this call, when the hook is not in place yet.
registerHooks({
  resolve: (specifier, context, next) => (specifier === 'cloudflare:workers' ? { url: new URL('./oauth-runtime.ts', import.meta.url).href, shortCircuit: true } : next(specifier, context)),
});
const { default: app } = await import('../src/app.ts');
const { default: viewer } = await import('../src/viewer.ts');
const { senderKey } = await import('../src/signin.ts');

const root = fileURLToPath(new URL('..', import.meta.url));
const appFiles = staticFiles(join(root, 'public'));
const viewerFiles = staticFiles(join(root, 'viewer/public'));
const crons = config.screenshot ? [...CRONS, SHOT_CRON] : CRONS;
const kv = new FileKv(join(config.dataDir, 'oauth-kv'));

const mail = config.smtp ? nodemailer.createTransport({
  ...config.smtp,
  secure: config.smtp.port === 465,
  requireTLS: true,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
}) : undefined;

// The viewer gets only what it needs, so the app's secrets stay out of its code.
const viewerEnv: ViewerEnv = {
  DB: { connectionString: config.databaseUrl },
  PAGES: new FileBucket(join(config.dataDir, 'files')),
  APP_ORIGIN: config.appOrigin,
  VIEWER_ORIGIN: config.viewerOrigin,
  PREVIEW_SECRET: config.previewSecret,
  // Without SMTP every email, sign-in codes included, goes to this log, so one person can still sign in on their own server.
  SEND_EMAIL: mail ? async (to, subject, text) => {
    await mail.sendMail({ from: config.emailFrom, to: { name: '', address: to }, subject, text });
  } : async (to, subject, text) => console.log(`No SMTP, so this email is printed here instead of sent. To ${to}: ${subject}\n\n${text}`),
  EMAIL_IN_LOG: !mail,
  OWNER_LOGIN: config.ownerLogin,
  EMAIL_FROM: config.emailFrom,
  ADMIN_EMAIL: config.adminEmail,
  TITLE_CARD: titleCard, // a page without a screenshot gets a drawn card (selfhost/title-card.ts)
};
const appEnv: AppEnv = {
  ...viewerEnv,
  BROWSER: config.screenshot && screenshotService(config.screenshot.url, config.screenshot.secret),
  OAUTH_KV: kv,
  CONSENT_SECRET: config.consentSecret,
  ASSETS: appFiles.assets,
  SELF_HOSTED: true,
};

// A file in public/ or viewer/public/ answers before the app or the viewer runs (the info pages, which the app wraps, are not served as files).
const appHandler = limitPosts(async (request, ctx) => (await appFiles.exact(request)) ?? app.fetch(request, appEnv, ctx), { path: '/oauth/register', perClient: 100, total: 500, windowMs: 24 * 60 * 60 * 1000, keyOf: senderKey }); // no sign-in, and each call stores an entry for 90 days, renewed while the client is used: so 100 a day per client (IPv6 by /64) and 500 for all, however many addresses they come from
const viewerHandler: Parameters<typeof serve>[0]['handler'] = async (request, ctx) => (await viewerFiles.exact(request)) ?? viewer.fetch(request, viewerEnv, ctx);
const sharedOrigin = config.appOrigin === config.viewerOrigin;
const appServer = serve({ origin: config.appOrigin, trusted: config.trusted, screenshotSecret: config.screenshot?.secret, handler: sharedOrigin ? singleOriginHandler(appHandler, viewerHandler) : appHandler });
const viewerServer = sharedOrigin ? undefined : serve({ origin: config.viewerOrigin, trusted: config.trusted, screenshotSecret: config.screenshot?.secret, handler: viewerHandler });
appServer.listen(config.appPort);
viewerServer?.listen(config.viewerPort);
schedule(crons, (cron) => {
  inFlight.used++; // a cron is never refused, but it takes a database connection like a request
  const run = app.scheduled({ cron }, appEnv, newContext());
  pending.add(run); // shutdown waits for a cron that is running, as for work handed to waitUntil
  return run.finally(() => {
    pending.delete(run);
    inFlight.used--;
  });
});
let purging: Promise<unknown> | undefined; // a purge reads every connector entry, so the next one does not start while this one runs
const purge = () => (purging ??= kv.purge().catch((error) => console.error('Purging expired connector entries failed:', error)).finally(() => (purging = undefined)));
void purge();
setInterval(purge, 60 * 60 * 1000).unref();

const warnings = config.warnings.map((warning) => `Warning: ${warning}\n`).join('');
console.log(`${warnings}Campfile is up. App ${config.appOrigin} on port ${config.appPort}, viewer ${config.viewerOrigin} on port ${sharedOrigin ? config.appPort : config.viewerPort}, data in ${config.dataDir}, crons: ${crons.join(' | ')}.`); // one write, so Docker's separate stdout and stderr readers cannot put a warning after this line, which ends every start

// docker stop: stop taking requests, let the ones running and their background work (emails) finish, for 8 s at most.
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('Stopping.');
  const closed = (viewerServer ? [appServer, viewerServer] : [appServer]).map((server) => {
    server.close();
    return once(server, 'close');
  });
  await Promise.race([Promise.all(closed).then(() => Promise.allSettled([...pending])), sleep(8000)]);
  process.exit(0);
}
process.on('SIGTERM', stop).on('SIGINT', stop);
