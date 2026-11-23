import type { Context } from 'hono';
import { hasSession, screenHeaders } from './connector.ts';
import type { DbVariables } from './db.ts';
import type { AppEnv } from './env.ts';
import { FAVICON_LINKS } from './html.ts';
import { signinWith } from './signin.ts';
import { BTN_CSS, SITE_CSS, siteFooter, siteHeader } from './site.ts';

/** The home page of a self-hosted install (SELF_HOSTED in src/env.ts) at GET /: what this is, Log in, and a Get started list for whoever runs the server. A step ticks itself once it is done. The list goes when every step is done, or when someone logged in hides it (POST /setup/instructions, src/manage.ts). */

/** The bucket object that hides the Get started list for everyone while it exists. `static/` is outside what the daily sweepOrphans (src/pages.ts) deletes. */
export const SETUP_HIDDEN = 'static/setup-hidden';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// One reading column, as the info pages' .doc (src/site.ts).
const CSS = `
body{display:flex;flex-direction:column;min-height:100dvh}
.home{flex:1;padding-block:clamp(20px,4vw,48px) clamp(16px,3vw,32px)}
.home>*{max-width:46rem}
h1{font:800 clamp(2rem,1.4rem + 2.6vw,3rem)/1.08 var(--display);letter-spacing:-.025em;text-wrap:balance}
.nw{white-space:nowrap}
.lede{margin-top:14px;color:var(--muted);font-size:1.1875rem;line-height:1.45}
.cta{margin-top:28px}
.start{margin-top:48px;padding-top:24px;border-top:1px solid var(--hairline)}
h2{font:800 1.5rem/1.2 var(--display);letter-spacing:-.015em}
.steps{display:grid;gap:20px;margin-top:20px}
.steps li{display:grid;grid-template-columns:28px minmax(0,1fr);column-gap:14px}
.n{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;box-shadow:inset 0 0 0 1.5px rgba(244,238,230,.28);font:700 .875rem/1 var(--display)}
.n svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
h3{padding-top:2px;font:700 1.125rem/1.3 var(--display)}
.steps p{margin-top:4px;color:var(--muted)}
.steps b{white-space:nowrap}
.steps a,.steps b{color:var(--cream)}
.done .n{background:var(--cream);box-shadow:none;color:var(--ember)}
.done h3{color:var(--dim)}
.quiet{min-height:44px;margin-top:12px;padding:0;border:0;background:none;color:var(--dim);font:inherit;font-size:.9375rem;text-decoration:underline;text-decoration-thickness:1.5px;text-underline-offset:.22em;cursor:pointer}
.quiet:hover{color:var(--cream)}
@media(forced-colors:active){.btn,.n{border:1px solid CanvasText}}
`;

const TICK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const toggle = (hide: boolean) =>
  `<form method="post" action="/setup/instructions"><input type="hidden" name="hide" value="${hide ? 1 : 0}"><button class="quiet" type="submit">${hide ? 'Hide these instructions' : 'Show the setup instructions'}</button></form>`;

/** GET / of a self-hosted install, for browsers, bots and link-preview fetchers (src/app.ts). Never counted, never cached. */
export async function home(c: Context<{ Bindings: AppEnv; Variables: DbVariables }>): Promise<Response> {
  const smtp = !c.env.EMAIL_IN_LOG; // selfhost/server.ts sets EMAIL_IN_LOG when SMTP is not set
  const signedIn = await hasSession(c);
  const [{ signed_in, has_page }] = await c.var.sql<{ signed_in: boolean; has_page: boolean }[]>`
    select exists(select 1 from testers where email is not null) as signed_in, exists(select 1 from pages) as has_page`;
  const steps = [
    {
      title: 'Log in for the first time',
      done: signed_in,
      text: [
        smtp
          ? 'Press <b>Log in</b> and type your email. Campfile emails you a link and a 6&#8209;digit code: open the link, or type the code.'
          : `Press <b>Log in</b> and type your email, then ${signinWith(c.env)}.`,
      ],
    },
    {
      title: c.env.OWNER_LOGIN ? 'Connect email (optional)' : 'Connect email',
      done: smtp,
      optional: !!c.env.OWNER_LOGIN, // single-user mode works without email
      text: [
        'Campfile sends login codes, invitations and access requests by email. Put your email provider’s SMTP settings in <b>selfhost/.env</b>, then run <b>docker compose up -d</b> (“Get outgoing email” in <b>docs/DEPLOY.md</b>).',
        'With email set up, password sign-in (single-user mode) is off, and anyone who reaches this address can make an account.',
      ],
    },
    {
      title: 'Connect your AI and put a page here',
      done: has_page,
      text: ['Add this Campfile to your AI, then ask it for a page. <a href="/guide">The guide shows how</a>.'],
    },
  ];
  const left = steps.some((step) => !step.done && !('optional' in step && step.optional));
  const hidden = left && (await c.env.PAGES.list({ prefix: SETUP_HIDDEN })).objects.length > 0;
  const start =
    left && !hidden
      ? `
<section class="start" aria-labelledby="start-h">
<h2 id="start-h">Get started</h2>
<ol class="steps">
${steps
  .map((step, at) =>
    step.done
      ? `<li class="done"><span class="n" aria-hidden="true">${TICK}</span><div><h3>${step.title}<span class="sr"> (done)</span></h3></div></li>`
      : `<li><span class="n" aria-hidden="true">${at + 1}</span><div><h3>${step.title}</h3>${step.text.map((line) => `<p>${line}</p>`).join('')}</div></li>`,
  )
  .join('\n')}
</ol>
${signedIn ? toggle(true) : ''}
</section>`
      : hidden && signedIn
        ? `\n${toggle(false)}`
        : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#16130f">
<meta name="color-scheme" content="dark">
<title>Campfile</title>
<meta name="description" content="A self-hosted Campfile: pages made with AI, each on one link to share.">
${FAVICON_LINKS}
<style>${SITE_CSS}${BTN_CSS}${CSS}</style>
</head>
<body>
${siteHeader(signedIn)}
<main class="wrap home">
<h1>Campfile, <span class="nw">on its own server</span></h1>
<p class="lede">Campfile puts the pages your AI makes online, each on one link to share. A page stays private until its owner publishes it. This is a self&#8209;hosted install: its pages and accounts live on this server.</p>
<p class="cta"><a class="btn" href="/my">${signedIn ? 'Your pages' : 'Log in'}</a></p>${start}
</main>
${siteFooter()}
</body>
</html>`;
  // noindex: an install stays out of search results; link-preview fetchers ignore it.
  return new Response(html, { headers: screenHeaders(CSP, new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' })) });
}
