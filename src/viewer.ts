import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { askForAccess, askWithEmail, visitorStatus, type GatedPage } from './access.ts';
import { CLIENT_COUNTRY, CLIENT_IP } from './client.ts';
import { withDb, type DbVariables } from './db.ts';
import type { ViewerEnv } from './env.ts';
import { HAS_TERMS } from './hosted.ts';
import { newState, readSignedId, sha256Hex, signedId, STATE, VIEWER_LOGIN, oldCookie } from './keys.ts';
import { escapeHtml, LOGO_MARK, ownerText } from './html.ts';
import { CampfileError } from './pages.ts';
import { cardVersion, PREVIEW_HEIGHT, PREVIEW_WIDTH } from './preview.ts';
import { PREVIEW_WAIT_MS, within } from './preview.ts';
import { HEADLINE, LEDE, sentences } from './pitch.ts';
import { arrive, arriveAi, authorName, countryOf, deviceOf, hasEntry, KEY, shareTree, validCode, type Sharing } from './sharing.ts';
import { designOf, spreadCounts, spreadDescription, spreadHtml, spreadTree, type Design } from './spread-view.ts';
import { spreadFile } from './spread-view.ts';
import { consentBanner } from './consent-banner.ts';
import { checkCode, email } from './signin.ts';
import { countOpen, robot, screenshotBrowser } from './visits.ts';

// docs/SPEC.md "Raw CSP". frame-ancestors: the viewer's own frame page ('self') and the app, whose page view frames its owner's page (src/page-view.ts), so it takes the app's origin.
const framers = (app: string) => {
  let origins = app;
  return origins;
};
const rawCsp = (app: string) =>
  `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self' ${framers(app)}`;
// The frame page loads nothing but its own iframe, the favicon and /bar.js: the copy buttons copy a link; a visitor's bar slims down once they scroll or touch the page.
const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'";
// Appended to every page /raw serves (after its last byte, so its doctype stays first): tells the frame page when the visitor first scrolls, clicks or presses a key in the page, and when they scroll back to the top (viewer/public/bar.js).
// Only these two words leave the page. Its own script could send them too, which can only resize the bar. Shrinks only for something that can scroll past what the bar gives back (64px), so it never bounces.
// 'click', not 'pointerdown': the page moves up as the bar slims, which mid-press would move a button from under the finger or shift a drag. isTrusted: a page's own el.click() on load is not the visitor.
export const BAR_REPORTER = `<script>(()=>{if(parent===window)return;let el=null,slim=false;const say=(s)=>{if(s!==slim){slim=s;parent.postMessage(s?'campfile:slim':'campfile:tall','*')}};addEventListener('scroll',(e)=>{const t=e.target===document?document.scrollingElement:e.target;if(!(t instanceof Element))return;if(t.scrollTop>8&&t.scrollHeight-t.clientHeight>64){el=t;say(true)}else if(t===el&&t.scrollTop<=0){el=null;say(false)}},{capture:true,passive:true});const touch=(e)=>{if(e.isTrusted&&!el)say(true)};addEventListener('click',touch,{capture:true,passive:true});addEventListener('keydown',touch,true)})()</script>`;
const BAR_REPORTER_BYTES = new TextEncoder().encode(BAR_REPORTER);
// AI assistants fetching a link for a user name themselves in the User-Agent (Anthropic, OpenAI, Perplexity and Mistral bot docs; Gemini sends just "Google",
// seen in the request log 2026-11-01). They open no iframes and run no scripts.
// Each one's name in an owner's sharing tree.
const AI_NAMES: Record<string, string> = { 'Claude-User': 'Claude', 'ChatGPT-User': 'ChatGPT', 'Perplexity-User': 'Perplexity', 'MistralAI-User': 'Mistral', Google: 'Gemini' };
const AI_FETCHER = /Claude-User|ChatGPT-User|Perplexity-User|MistralAI-User|^Google$/;
// The page's source, escaped into a <pre>, so a reader keeps its scripts and SVG as text. HTML, not text/plain: Gemini's reader fails on text/plain.
// Escaping keeps it inert; the sandbox covers a browser that renders it anyway.
// Opens with Campfile's own line, so a browser that sends no Sec-Fetch-Dest (old Safari), which still gets /source, never sees the page's text without Campfile's name (and Report address).
let sourceHead = (_page: string) => `<!doctype html><meta charset="utf-8"><pre>\nShared on Campfile.\n\n`; // the self-hosted copy has no Report
const sourceResponse = (body: ReadableStream, page: string) =>
  new Response(
    body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TransformStream<string, string>({
        start: (out) => out.enqueue(sourceHead(page)),
        transform: (text, out) => out.enqueue(escapeHtml(text)),
        flush: (out) => out.enqueue('</pre>'),
      }))
      .pipeThrough(new TextEncoderStream()),
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "sandbox; default-src 'none'" } },
  );
// Static files in viewer/public. The .ico is for browsers without SVG favicons (older Safari).
const FAVICON = '<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml">';
// docs/SPEC.md "Login": one cookie for the whole viewer (VIEWER_LOGIN) says which workspace (person) this browser is logged in as, for LOGIN_DAYS; each page decides what that person sees.
// The login cookie holds the hand-over's state.
const LOGIN_COOKIE = '__Host-campfile-login';
const LOGIN_DAYS = 30;
const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;

// The bar's icons: inline SVG, since the frame page loads nothing.
const svg = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const icon = {
  hide: svg('<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4 9.5 6a12 12 0 0 1-2.4 3.2M6.6 6.6C4.6 8 3.2 10 2.5 12c1 2 4.5 6 9.5 6 1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  exit: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  login: svg('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l4-4-4-4M14 12H4"/>'),
  logout: svg('<path d="M10 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4M16 16l4-4-4-4M20 12H10"/>'),
  flag: svg('<path d="M5 21V4M5 4h12l-2.5 4.5L17 13H5"/>'),
};

const viewer = new Hono<{ Bindings: ViewerEnv; Variables: DbVariables }>();

viewer.use(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store'); // only the preview image sets its own
  c.header('X-Robots-Tag', 'noindex, nofollow');
});

const ogTag = (property: string, content: string | number) => `<meta property="${property}" content="${escapeHtml(String(content))}">`;

const notice = (c: Context, heading: string, text: string, extra = '', status: 400 | 404 = 404) =>
  c.html(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON}
<title>${heading}</title>
<style>body{margin:0;padding:0 20px;min-height:100vh;display:grid;place-items:center;text-align:center;font:18px/1.5 system-ui,sans-serif;color:#222}main{text-wrap:balance}h1{line-height:1.2}</style>
</head>
<body>
<main><h1>${heading}</h1><p>${text}</p>${extra}</main>
</body>
</html>`,
    status,
  );

const removed = (c: Context) => notice(c, 'This page was removed', 'The link may be wrong, or the author took the page down.');
// Says nothing about the page, not even its title.
const unpublished = (c: Context) => notice(c, "This page isn't published", "The author hasn't published it, or took it offline.");

viewer.notFound(removed);

// Someone who deletes the page id from a link lands on the app's front page (docs/SPEC.md "Viewer": never on this domain).
viewer.get('/', (c) => c.redirect(`${c.env.APP_ORIGIN}/`, 302));

type ViewerContext = Context<{ Bindings: ViewerEnv; Variables: DbVariables }>;
/** The workspace this browser is logged in as on the viewer, if any. */
const loggedInAs = (c: ViewerContext) => readSignedId(c.env.PREVIEW_SECRET, 'owner', getCookie(c, VIEWER_LOGIN) ?? getCookie(c, oldCookie(VIEWER_LOGIN)));
// This browser is logged in on the viewer as a workspace: the Set-Cookie value, for LOGIN_DAYS.
async function personCookie(c: ViewerContext, tester: number) {
  const seconds = LOGIN_DAYS * 24 * 60 * 60;
  return cookie(VIEWER_LOGIN, await signedId(c.env.PREVIEW_SECRET, 'owner', tester, Math.floor(Date.now() / 1000) + seconds), seconds);
}
// An invite's pass (src/manage.ts /viewer-login): this one page, for the invited person (a page_people id), for LOGIN_DAYS and only while they stay let in. Not a login: nothing else of that email's opens with it.
// It carries the approval version its invite was opened under (page_people.decided_at in microseconds, from useInvite) and counts only while that is still the person's,
// so Say no ends it for good: approving again (and any renewed invite) is a new version. Letting in someone already let in keeps theirs. A disabled workspace's pass opens nothing, as its login would not.
const passName = (id: string) => `__Host-campfile-pass-${id}`;
const VERSION = /^\d{1,20}$/;
async function passCookie(c: ViewerContext, id: string, person: number, version: string) {
  const seconds = LOGIN_DAYS * 24 * 60 * 60;
  return cookie(passName(id), `${version}.${await signedId(c.env.PREVIEW_SECRET, `pass:${id}:${version}`, person, Math.floor(Date.now() / 1000) + seconds)}`, seconds);
}
async function hasPass(c: ViewerContext, id: string): Promise<boolean> {
  const [version = '', ...signed] = (getCookie(c, passName(id)) ?? '').split('.');
  if (!VERSION.test(version)) return false;
  const person = await readSignedId(c.env.PREVIEW_SECRET, `pass:${id}:${version}`, signed.join('.'));
  if (person === undefined) return false;
  const [row] = await c.var.sql`
    select 1 from page_people pp where pp.id = ${person} and pp.page = ${id} and pp.status = 'approved' and (extract(epoch from pp.decided_at) * 1000000)::bigint = ${version}::bigint
      and exists (select 1 from testers t where t.email = pp.email and t.disabled_at is null)`;
  return row !== undefined;
}
// Logged in as another workspace: Log in asks for an email again instead of handing back the same one.
const loginHref = (id: string, as: number | undefined) => `/${id}/login${as === undefined ? '' : '?switch=1'}`;

// One dark bar above the sandboxed frame: the title, then tools. The uploaded HTML itself comes from /:id/raw.
// Campfile signs it ("Shared on Campfile", right of the title): that opens a short "how to make your own" dialog. Then Report, and Log in or Log out. A draft has no page here, only its 404.
// The page's owner, logged in here, is sent on to the page on the app, with its owner bar and the panel over it (docs/SPEC.md "Managing a page"); the app frames this page's /raw with a ticket (below).
// An approval page opens for a visitor only once they are logged in with an approved email, or hold its invite's pass; otherwise its gate (see "Visitors of an approval page" below).
// /<id>-<code> is the same page, reached through a reader's own link (docs/SPEC.md "See how it's shared"); only the frame page takes the suffix.
viewer.get('/:path{[A-Za-z0-9]{8}(?:-[A-Za-z0-9]{4})?}', withDb, async (c) => {
  const [id, via = null] = c.req.param('path').split('-');
  const [page] = await c.var.sql<(GatedPage & { owner: number; file: string; preview_file: string | null; published: boolean; access: 'link' | 'approval'; sharing: Sharing; display_name: string | null; email: string | null })[]>`
    select p.id, p.title, p.owner, p.file, p.preview_file, p.published_at is not null as published, p.access, p.sharing, t.name as owner_name, coalesce(t.email, '') as owner_email, t.display_name, t.email
    from pages p join testers t on t.id = p.owner where p.id = ${id} and p.status = 'live' and t.disabled_at is null`;
  if (!page) return removed(c);
  const as = await loggedInAs(c);
  const owner = as === page.owner;
  // The screenshot browser stays: it shoots an approval page logged in as its owner (src/pages.ts makePreview) and needs the framed page, not the app's sign-in.
  if (owner && !screenshotBrowser(c)) return c.redirect(`${c.env.APP_ORIGIN}/p/${id}`, 302);
  const draft = !page.published;
  if (draft && !owner) {
    const text = as === undefined ? "The author hasn't published it, or took it offline. Is it yours? Log in to see it." : "The author hasn't published it, or took it offline. You're logged in with an email that didn't make this page.";
    // An AI's web fetch carries no login; the owner's AI reads drafts through the connector instead.
    const forAi = AI_FETCHER.test(c.req.header('User-Agent') ?? '') ? `<p>Its owner's AI can read it with the Campfile connector's get_page tool, id ${id}.</p>` : '';
    return notice(c, "This page isn't published", text, `${forAi}<p><a href="${loginHref(id, as)}">${as === undefined ? 'Log in' : 'Log in with another email'}</a></p>`);
  }
  const approval = page.published && page.access === 'approval';
  if (approval && !owner) {
    const visitor = as === undefined ? undefined : await visitorStatus(c.var.sql, id, as);
    if (visitor?.status !== 'approved' && !(await hasPass(c, id))) return gateScreen(c, page, visitor);
  }
  // Only a page anyone with the link can open is public: its /raw is open and it has a link-preview image.
  const open = page.published && !approval;
  // docs/SPEC.md "See how it's shared": only a page open to anyone with the link tracks, never for its owner. The suffix names the link this visitor came through (src/sharing.ts checks it).
  const sharing = open ? page.sharing : 'off';
  const ai = AI_FETCHER.exec(c.req.header('User-Agent') ?? '')?.[0];
  if (open && ai) {
    const object = await c.env.PAGES.get(page.file);
    if (!object) return removed(c);
    // An AI reader runs no script and asks nobody, acting for whoever gave it the link: its entry is made here.
    if (sharing !== 'off' && !owner) {
      const entered = arriveAi(c.var.sql, { page: id, via, ai: AI_NAMES[ai], country: countryOf(c.req.header(CLIENT_COUNTRY)) });
      c.var.waitUntil(entered.catch((error) => console.error('Recording an AI reader failed:', error)));
    }
    return sourceResponse(object.body, `${new URL(c.req.url).origin}/${id}`);
  }
  // A stranger's browser gets the consent dialog (src/consent-banner.ts, opened by /bar.js); bots never.
  // Nor the screenshot browser (robot, src/visits.ts).
  // The author as readers see them: the name they chose, or one made from their email, never the email itself (src/sharing.ts authorName).
  const author = authorName({ display_name: page.display_name, email: page.email, name: page.owner_name });
  const banner = open && !owner && !robot(c) && sharing !== 'off' ? consentBanner({ author, email: sharing === 'emails', privacyUrl: HAS_TERMS ? `${c.env.APP_ORIGIN}/privacy#sharing` : undefined }) : null;
  const title = escapeHtml(page.title);
  const origin = new URL(c.req.url).origin;
  const publicUrl = `${origin}/${id}`;
  const code = sharing !== 'off' && via ? await validCode(c.var.sql, id, via) : null;
  const sourceUrl = escapeHtml(`${publicUrl}/source`); // the origin comes from the request
  let card = 'summary';
  // Link previews. og:image is the page's screenshot once it has one, and only for a page open to anyone with the link (an approval page's screenshot is its owner's). Without one, a published page gets the drawn title card, where the deployment has one.
  const previewSrc = page.preview_file && open ? await previewUrl(origin, id, page.preview_file) : '';
  const imageTags = previewSrc
    ? [ogTag('og:image', previewSrc), ogTag('og:image:width', PREVIEW_WIDTH), ogTag('og:image:height', PREVIEW_HEIGHT), ogTag('og:image:type', 'image/jpeg')]
    : page.published ? cardTags(c.env, origin, id, page.title) : [];
  if (imageTags.length) card = 'summary_large_image';
  const linkTags = [
    ogTag('og:type', 'website'),
    ogTag('og:title', page.title),
    ogTag('og:description', 'Made for sharing'),
    ...(draft ? [] : [ogTag('og:url', code ? `${publicUrl}-${code}` : publicUrl)]), // a draft has no public address yet, and some crawlers fetch og:url instead of the page they were given
    ...imageTags,
    `<meta name="twitter:card" content="${card}">`,
  ].join('\n');
  // The iframe's /raw checks the same cookies as this page, so its address holds nothing secret.
  const frameSrc = `/${id}/raw`;
  const logout = `<a class="ib" href="/${id}/logout" aria-label="Log out" data-tip="Log out">${icon.logout}</a>`;
  let report = ''; // the self-hosted copy has no Report
  const tools = `${report}${as === undefined ? `<a class="ib" href="/${id}/login" aria-label="Log in" data-tip="Log in">${icon.login}</a>` : logout}`;
  let safety = ''; // the self-hosted copy has no scam checks
  // Campfile signs the bar on the right, apart from the title, so nobody reads it as the page's subtitle. A native modal <dialog> opened by an invoker command: focus stays inside and Esc returns it to the signature, with no script (/bar.js stands in for browsers without invoker commands).
  const signature = `<button class="sig" commandfor="about" command="show-modal" aria-label="Shared on Campfile: share what you made the same way" data-tip="Share what you made the same way"><svg class="logo" viewBox="4 3.5 24 24" aria-hidden="true">${LOGO_MARK}</svg><span class="long">Shared on </span><span class="name">Campfile</span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button><span class="rule" aria-hidden="true"></span>`;
  // Its reader opened someone else's page, so it says so first, then Campfile's headline. The main button goes to the app's front page.
  const about = `<dialog id="about" class="about" aria-labelledby="about-kick about-title" closedby="any">
<p class="kick"><span id="about-kick">This page is shared on Campfile.</span><br><span class="ask">Made something with AI yourself?</span></p>
<h2 id="about-title">${sentences(HEADLINE)}</h2>
<p>${LEDE.join(' ')}</p>
<div class="acts"><a class="go" href="${escapeHtml(c.env.APP_ORIGIN)}/" target="_blank" rel="noopener" aria-label="See what Campfile does (opens in a new tab)">See what Campfile does</a><button class="close" commandfor="about" command="close">Not now</button></div>
</dialog>
`;
  return c.html(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#16130f">
${FAVICON}
<title>${title}</title>
${linkTags}
<link rel="alternate" type="text/html" href="/${id}/source" title="Page source">
<style>
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;font:14px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#16130f;color:#f4eee6}
.bar{flex:none;display:flex;align-items:center;gap:6px;height:46px;padding:0 6px 0 14px}
h1{flex:1;min-width:0;margin:0;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tools{display:flex;align-items:center;gap:4px;flex:none}
svg{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.ib,.meta{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;border:0;border-radius:8px;font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:inherit;text-decoration:none;cursor:pointer;white-space:nowrap}
.ib{width:36px;padding:0;background:transparent}
.rep{width:auto;padding:0 10px 0 9px}
.safety{flex:none;margin:0;padding:0 16px 10px;font-size:12.5px;line-height:1.35;color:#d9cdbb}
.meta{padding:0 9px;background:transparent;color:#d9cdbb}
.ib:hover,.meta:hover{background:rgba(244,238,230,.08)}
.sig{position:relative;flex:none;display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 6px 0 9px;border:0;border-radius:8px;background:transparent;color:#b5a894;font:500 12.5px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;white-space:nowrap;cursor:pointer}
.sig .name{font-weight:600;color:#f4eee6}
.sig:hover{background:rgba(244,238,230,.08)}
.sig:hover .name{text-decoration:underline;text-decoration-color:rgba(244,238,230,.45);text-underline-offset:3px}
.sig .logo{width:15px;height:15px;stroke:none}
.sig .chev{width:14px;height:14px;stroke-width:2}
.rule{flex:none;width:1px;height:18px;margin:0 2px;background:rgba(244,238,230,.16)}
[data-tip]:hover::after,[data-tip]:focus-visible::after,[data-tip].copied::after{content:attr(data-tip);position:absolute;top:calc(100% + 6px);right:0;z-index:2;padding:6px 8px;border-radius:6px;background:#2a241c;color:#f4eee6;font:500 12px/1 system-ui,sans-serif;pointer-events:none}
:focus-visible{outline:2px solid #f2a541;outline-offset:2px}
@media (max-width:520px){.meta .label{display:none}.meta{width:36px;padding:0}.sig .long{display:none}.rep svg{display:none}.rep{padding:0 9px}}
/* Visitors: a title card at the top of the page (56px bar, 19px rounded title; phones give the title its own lines under Campfile's row),
   then today's 46px bar once they scroll or touch the page (.slim, set by /bar.js). Phones move the title up into the slim row and drop "Shared on". */
.visitor{height:56px;padding-left:16px;transition:height .2s cubic-bezier(.22,1,.36,1)}
.visitor .small{display:none}
.visitor .tw{flex:1;min-width:0}
.visitor h1{font:700 19px/1.2 ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:-.01em;transition:font-size .2s cubic-bezier(.22,1,.36,1)}
.visitor.slim{height:46px}
.visitor.slim h1{font-size:15px}
@media (max-width:520px){
.visitor,.visitor.slim{height:auto;display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;grid-template-areas:"small sig rule tools" "big big big big";grid-template-rows:46px auto;gap:0 4px}
.visitor .small{display:block;grid-area:small;min-width:0;opacity:0;font:700 15px/1.2 ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .2s cubic-bezier(.22,1,.36,1)}
.visitor .sig{grid-area:sig}
.visitor .rule{grid-area:rule}
.visitor .tools{grid-area:tools}
.visitor .sig .long{display:inline-block;max-width:80px;overflow:hidden;transition:max-width .2s cubic-bezier(.22,1,.36,1),margin .2s cubic-bezier(.22,1,.36,1)}
.visitor .tw{grid-area:big;display:grid;grid-template-rows:1fr;transition:grid-template-rows .2s cubic-bezier(.22,1,.36,1),opacity .2s cubic-bezier(.22,1,.36,1)}
.visitor .tw>div{min-height:0;overflow:hidden}
.visitor h1,.visitor.slim h1{font-size:19px;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;padding:0 10px 12px 0}
.visitor.slim .tw{grid-template-rows:0fr;opacity:0}
.visitor.slim .small{opacity:1}
.visitor.slim .sig .long{max-width:0;margin-left:-6px} /* the negative margin takes its 6px gap along, so the logo sits 6px from Campfile */
}
/* "Shared on" goes from the tall bar where Campfile's row can't hold it with the tools: below 360px always, below 390px with the share tool shown (four tools).
   Checked with DejaVu Sans, wider than any phone's system font, so the row never overflows the screen. */
@media (max-width:359px){.visitor .sig .long{max-width:0;margin-left:-6px}}
@media (max-width:389px){.visitor:has(.consent-tool:not([hidden])) .sig .long{max-width:0;margin-left:-6px}}
@media (prefers-reduced-motion:reduce){.visitor,.visitor *{transition:none!important}}
/* Full page without leaving the frame (/raw never opens alone): bar.js puts .full on the body, which hides the bar and shows a small way back.
   A class, not #full:target, so a link to the page cannot open it with the bar already hidden. */
.exit{display:none}
.full #full{position:fixed;top:8px;right:8px;z-index:1;display:grid;background:rgba(22,19,15,.72);color:#f4eee6;opacity:.75}
.full #full:hover,.full #full:focus-visible{opacity:1;background:#16130f}
.full .bar,.full .safety{display:none}
iframe{flex:1;width:100%;border:0;background:#fff}
.about{box-sizing:border-box;width:min(420px,calc(100vw - 32px));margin:auto;padding:18px 22px 22px;border:0;border-radius:16px;background:#1f1a14;color:#f4eee6;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.2),0 24px 48px -16px rgba(0,0,0,.6)}
.about::backdrop{background:rgba(10,8,6,.55)}
.about h2{margin:0 0 8px;font-size:18px;line-height:1.25;text-wrap:balance}
.about h2 span{display:block}
.about p{margin:0 0 12px;color:#d9cdbb;text-wrap:pretty}
.about p a{color:#f4eee6;text-underline-offset:3px}
.about .acts{display:flex;flex-wrap:wrap;gap:8px}
.about .go,.about .close{display:flex;align-items:center;justify-content:center;height:42px;padding:0 18px;border:0;border-radius:10px;font:600 15px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;text-decoration:none;cursor:pointer}
/* One row where both fit, See what Campfile does taking the free width; on a narrow phone Not now goes under it, as wide. */
.about .go{flex:999 1 auto;background:#f4eee6;color:#16130f}
.about .close{flex:1 0 auto}
.about .go:hover{background:#fff}
.about .close{background:transparent;color:#f4eee6;box-shadow:inset 0 0 0 1px rgba(244,238,230,.28)}
.about .close:hover{background:rgba(244,238,230,.08)}
.about .kick{margin:0 0 10px;font-size:13.5px;color:#b5a894}
.about .kick .ask{display:inline-block;margin-top:2px;font-size:15px;font-weight:600;color:#f4eee6}
/* For readers without frames (AI fetch tools); out of sight and out of the tab order. Never aria-hidden: Mozilla Readability drops those nodes. */
.source{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
${banner?.css ?? ''}</style>
</head>
<body${banner ? ` data-share="${sharing}"` : ''}>
<p class="source">For AI assistants and other readers that open no frames: this page is built by its own scripts inside a frame, so its words are not on this wrapper page. Read its full source, scripts included, as text at <a href="${sourceUrl}" tabindex="-1">${sourceUrl}</a></p>
<button type="button" id="full" class="ib exit" aria-label="Show the bar again" data-tip="Exit full page">${icon.exit}</button>
<header class="bar visitor"><div class="small" aria-hidden="true">${title}</div><div class="tw"><div><h1>${title}</h1></div></div>${signature}<div class="tools">${banner?.tool ?? ''}${tools}<button type="button" class="ib" data-full aria-label="Full page: hide this bar" data-tip="Full page">${icon.full}</button></div></header>
${safety}<script src="/bar.js" defer></script>
${about}
<iframe title="${title}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="${frameSrc}"></iframe>
${banner?.html ?? ''}</body>
</html>`,
    200,
    // same-origin: a window the page opens gets no handle back to this tab (window.opener), so it cannot send this tab elsewhere.
    // frame-src is this page's own /raw (CSP ignores the query, so the owner's ?t= fits too): the frame cannot load another page under this page's bar and Report flag.
    { 'Content-Security-Policy': `${FRAME_CSP}; frame-src ${new URL(c.req.url).origin}${frameSrc}; script-src ${new URL(c.req.url).origin}/bar.js${banner ? "; connect-src 'self'" : ''}`, 'Cross-Origin-Opener-Policy': 'same-origin' },
  );
});

// Postgres decides whether the page is live; only then is the file read from the bucket. A draft opens for its owner, an approval page for its owner and approved visitors,
// by the same cookies as the frame page, so Remove, Unpublish and Log out also shut an iframe address someone saved. /source is the same file escaped into HTML, for readers.
// The app's page view frames this address for the owner with a ticket (`?t=`, src/page-view.ts), since the login cookie does not reach a frame on another site. It is good for this page only, as its owner, until it expires.
viewer.get('/:id{[A-Za-z0-9]{8}}/:kind{raw|source}', withDb, async (c) => {
  const id = c.req.param('id');
  const [page] = await c.var.sql<{ file: string; owner: number; open: boolean; approval: boolean }[]>`
    select file, owner, published_at is not null and access = 'link' as open, published_at is not null and access = 'approval' as approval
    from pages where id = ${id} and status = 'live' and owner in (select id from testers where disabled_at is null)`;
  if (!page) return removed(c);
  const as = await loggedInAs(c);
  const owner = as === page.owner || (await readSignedId(c.env.PREVIEW_SECRET, `view:${id}`, c.req.query('t'))) === page.owner;
  const letIn = async () => (as !== undefined && (await visitorStatus(c.var.sql, id, as))?.status === 'approved') || (await hasPass(c, id));
  if (!page.open && !owner && !(page.approval && (await letIn()))) return unpublished(c);
  // The page opens only inside a Campfile frame, under its bar: never alone in a tab, where it could pass itself off as any site (docs/SPEC.md "GET /:id/raw").
  // /source, as text, also stays out of a tab: readers that send no Sec-Fetch-Dest (AI fetchers, curl) still get it.
  const dest = c.req.header('Sec-Fetch-Dest');
  c.header('Vary', 'Sec-Fetch-Dest'); // for the redirect and the notice; a returned Response keeps only its own headers
  if (c.req.param('kind') === 'source' ? dest === 'document' : dest !== undefined && dest !== 'iframe') return c.redirect(`/${id}`, 302);
  if (dest === undefined && c.req.param('kind') === 'raw') {
    // Its own sandbox CSP runs nothing, and self-host's single address then leaves it framable (selfhost/routing.ts).
    c.header('Content-Security-Policy', `sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' ${framers(c.env.APP_ORIGIN)}`);
    return notice(c, 'This browser is too old to show this page safely', 'Update it or use another browser.', `<p><a href="/${id}" target="_blank">Open the page in a new tab</a></p>`, 400);
  }
  const object = await c.env.PAGES.get(page.file);
  if (!object) return removed(c);
  if (c.req.param('kind') === 'source') {
    const response = sourceResponse(object.body, `${new URL(c.req.url).origin}/${id}`);
    response.headers.set('Vary', 'Sec-Fetch-Dest');
    return response;
  }
  if (!owner) countOpen(c, id);
  const body = object.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: (out) => out.enqueue(BAR_REPORTER_BYTES) }));
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': rawCsp(c.env.APP_ORIGIN), Vary: 'Sec-Fetch-Dest' } });
});

// The link-preview image. Only for a page anyone with the link can open, once it has one.
viewer.get('/:id{[A-Za-z0-9]{8}}/preview.jpg', withDb, async (c) => {
  const id = c.req.param('id');
  const [page] = await c.var.sql<{ preview_file: string | null }[]>`
    select preview_file from pages where id = ${id} and status = 'live' and published_at is not null and access = 'link' and owner in (select id from testers where disabled_at is null)`;
  const object = page?.preview_file && (await c.env.PAGES.get(page.preview_file));
  if (!object) return removed(c);
  // Cached briefly. A new screenshot gets a new ?v= in og:image, so a changed preview is not hidden by the cache.
  return new Response(object.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300' } });
});

// The drawn title card, for a published page without a screenshot (cardTags). Any access: an approval page's title is in its og:title and gate screen already, and the card holds nothing else.
viewer.get('/:id{[A-Za-z0-9]{8}}/card.png', withDb, async (c) => {
  const [page] = await c.var.sql<{ title: string }[]>`
    select title from pages where id = ${c.req.param('id')} and status = 'live' and published_at is not null and owner in (select id from testers where disabled_at is null)`;
  if (!page || !c.env.TITLE_CARD) return removed(c);
  // The title is in the address's ?v=, so a retitled page gets a new address and the cache can be long.
  return new Response(await c.env.TITLE_CARD(page.title), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
});

// --- How it spread (docs/SPEC.md "How it spread") ---------------------------------------------------------------------
// The page's owner, logged in here, sees their tree with emails, whatever the page's state. Anyone else only when the owner made it public, and only while anyone with the link can open the page: no labels then.
// Countries and devices never leave the server. Nothing here counts an open or files an entry.
const SPREAD_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
// The public view's address for one design: the default needs no ?design=.
const spreadUrl = (origin: string, id: string, design: Design) => `${origin}/${id}/spread${design === 'cascade' ? '' : `?design=${design}`}`;

viewer.get('/:id{[A-Za-z0-9]{8}}/spread', withDb, async (c) => {
  const id = c.req.param('id');
  const [page] = await c.var.sql<{ title: string; owner: number; published_at: Date | null; updated_at: Date; open: boolean; display_name: string | null; email: string | null; name: string }[]>`
    select p.title, p.owner, p.published_at, p.updated_at, p.published_at is not null and p.access = 'link' and p.spread_public as open, t.display_name, t.email, t.name
    from pages p join testers t on t.id = p.owner where p.id = ${id} and p.status = 'live' and t.disabled_at is null`;
  if (!page) return removed(c);
  const as = await loggedInAs(c);
  const owner = as === page.owner;
  if (!owner && !page.open) {
    // As a draft's 404: its Log in comes back here (then=spread), so the sheet's link reaches the owner view.
    const text = as === undefined ? 'Only its author can see how this page spread. Is it yours? Log in to see it.' : "You're logged in with an email that didn't make this page.";
    return notice(c, 'Only its author can see this', text, `<p><a href="${loginHref(id, as)}${as === undefined ? '?' : '&'}then=spread">${as === undefined ? 'Log in' : 'Log in with another email'}</a></p>`);
  }
  const mode = owner ? 'owner' : 'public';
  const design = designOf(c.req.query('design'));
  const origin = new URL(c.req.url).origin;
  const published = (page.published_at ?? page.updated_at).toISOString();
  const tree = await shareTree(c.var.sql, id);
  const data = { mode, design, title: page.title, author: authorName(page), published, now: new Date().toISOString(), tree: spreadTree(tree, mode) } as const;
  const heading = `How “${page.title}” spread`;
  // Link previews of the public view: what it shows (counts, never names). Owner mode is never described.
  const linkTags = owner
    ? ''
    : [
        ogTag('og:type', 'website'),
        ogTag('og:title', heading),
        ogTag('og:description', spreadDescription(spreadCounts(tree, published))),
        ogTag('og:url', spreadUrl(origin, id, design)),
        ogTag('og:image', `${origin}/${id}/spread/preview.jpg?design=${design}`),
        ogTag('og:image:width', PREVIEW_WIDTH),
        ogTag('og:image:height', PREVIEW_HEIGHT),
        ogTag('og:image:type', 'image/jpeg'),
        '<meta name="twitter:card" content="summary_large_image">',
      ].join('\n');
  const html = spreadHtml(data, {
    id, app: c.env.APP_ORIGIN, open: page.open, publicUrl: spreadUrl(origin, id, design), head: `${FAVICON}\n${linkTags}`,
    shot: c.req.query('shot') === '1',
  });
  return c.html(html, 200, { 'Content-Security-Policy': SPREAD_CSP, ...(owner && { 'Cache-Control': 'private, no-store' }) });
});

// The public view's link-preview image, per design: a screenshot the app takes (the viewer has no screenshot service), kept in the bucket and taken again once it is SPREAD_SHOT_HOURS old.
// No image yet: the app is asked and this waits for it, as publishing does; an old one is served while the new one is taken. 404 unless the view is public.
const SPREAD_SHOT_HOURS = 6;
viewer.get('/:id{[A-Za-z0-9]{8}}/spread/preview.jpg', withDb, async (c) => {
  const id = c.req.param('id');
  const design = designOf(c.req.query('design'));
  const [page] = await c.var.sql`
    select 1 from pages where id = ${id} and status = 'live' and published_at is not null and access = 'link' and spread_public and owner in (select id from testers where disabled_at is null)`;
  if (!page) return removed(c);
  let image = await c.env.PAGES.get(spreadFile(id, design));
  if (!image || !image.uploaded || image.uploaded.getTime() < Date.now() - SPREAD_SHOT_HOURS * 3600_000) {
    // Signed for this page and design, so the app's route shoots nothing else; the app checks again that the view is public.
    const token = await signedId(c.env.PREVIEW_SECRET, `spread-shot:${id}:${design}`, 0, Math.floor(Date.now() / 1000) + 60);
    const shot = fetch(`${c.env.APP_ORIGIN}/spread-shot/${id}?design=${design}&t=${token}`, { method: 'POST' }).catch((error) => console.error(`Asking for a spread preview of ${id} failed: ${error}`));
    c.var.waitUntil(shot);
    if (!image) {
      await within(PREVIEW_WAIT_MS, shot);
      image = await c.env.PAGES.get(spreadFile(id, design));
    }
  }
  if (!image) return removed(c);
  return new Response(image.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300' } });
});

// --- Visitors of an approval page (docs/SPEC.md "Publish with approval") ---------------------------------------------
// Not logged in: type an email to ask → the owner is emailed → when they approve, that email gets a login link and a 6-digit code, and either opens the page (the code is typed here, /enter).
// Logged in (the one login, docs/SPEC.md "Login") but not let in: the Ask button, once. Logging in files nothing: an already logged-in browser comes back here with no screen, so another site could otherwise send someone's email to a page's owner.

// The gate screens load nothing and run no script. Their forms post to the viewer; the owner's ask goes on through Log in to the app's login, which browsers check against form-action too.

function gate(c: Context, page: GatedPage, body: string, status: 200 | 400 | 429): Response {
  // The title is on this screen already, so the title card (cardTags) shows nothing more to a chat app's link preview.
  const image = cardTags(c.env, new URL(c.req.url).origin, page.id, page.title);
  const preview = image.length ? [ogTag('og:type', 'website'), ogTag('og:title', page.title), ogTag('og:description', 'Made for sharing'), ...image, '<meta name="twitter:card" content="summary_large_image">'].join('\n') : '';
  return c.html(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#16130f">
${FAVICON}
<title>${escapeHtml(page.title)}</title>
${preview}
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#16130f;color:#f4eee6;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{box-sizing:border-box;width:min(420px,calc(100vw - 32px));padding:26px 24px 22px;border-radius:16px;background:#1f1a14;box-shadow:0 24px 48px -16px rgba(0,0,0,.6)}
.who{margin:0 0 6px;color:#f2a541;font-size:13px;font-weight:600}
h1{margin:0 0 10px;font-size:20px;line-height:1.3;text-wrap:balance;overflow-wrap:anywhere}
p{margin:0 0 12px;color:#d9cdbb}
label{display:block;margin:16px 0 6px;font-weight:600;color:#f4eee6}
input,textarea{box-sizing:border-box;width:100%;height:44px;padding:0 12px;border:0;border-radius:10px;background:#0f0c09;color:#f4eee6;font:inherit;box-shadow:inset 0 0 0 1px rgba(244,238,230,.22)}
textarea{height:auto;padding:10px 12px;resize:vertical}
input[name=code]{font-size:22px;letter-spacing:.35em;text-align:center}
button{display:block;width:100%;height:44px;margin-top:14px;border:0;border-radius:10px;background:#f4eee6;color:#16130f;font:600 15px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;cursor:pointer}
input:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #f2a541;outline-offset:2px}
a{color:#f2a541}
.error{padding:10px 12px;border-radius:10px;background:rgba(240,90,60,.14);color:#ffb4a3}
.fine{margin:16px 0 0;font-size:13px;color:#b5a894}
</style>
</head>
<body>
<main>
<p class="who">A page by ${ownerText(page.owner_name)}</p>
<h1>${escapeHtml(page.title)}</h1>
${body}
</main>
</body>
</html>`,
    status,
    { 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' ${c.env.APP_ORIGIN}; frame-ancestors 'none'; base-uri 'none'` },
  );
}

const errorLine = (error?: string) => (error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '');
// email_off: a CDN's email obfuscation would show "[email protected]", and its decoding script cannot run here.
const emailText = (address: string) => `<strong><!--email_off-->${escapeHtml(address)}<!--/email_off--></strong>`;

/** Someone not logged in: their email, to ask. A mistyped or refused ask comes back here with the email kept. */
function askScreen(c: Context, page: GatedPage, address = '', error?: string, status: 200 | 400 | 429 = 200): Response {
  const owner = ownerText(page.owner_name);
  return gate(
    c,
    page,
    `<p>Only people ${owner} lets in can open this page. Type your email to ask ${owner} for access.</p>
${errorLine(error)}
<form method="post" action="/${page.id}/ask">
<label for="email">Your email</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus value="${escapeHtml(address)}">
<button type="submit">Ask ${owner}</button>
</form>
<p class="fine">Already let in, or is this your page? <a href="/${page.id}/login">Log in</a></p>`,
    status,
  );
}

/**
 * The wait after an email was typed, and the same screen whatever became of it (waiting, approved, told no), so it tells nobody who is let in.
 * The code is the one Approve emails with the login link, or an approved email gets when it asks: typing it here logs in and opens the page (/enter).
 */
function codeScreen(c: Context, page: GatedPage, address: string, error?: string): Response {
  const owner = ownerText(page.owner_name);
  return gate(
    c,
    page,
    `<p>${owner} will get your request. When ${owner} lets you in, you'll get an email with a login link and a 6&#8209;digit code. Click the link, or type the code here.</p>
${errorLine(error)}
<form method="post" action="/${page.id}/enter">
<input type="hidden" name="email" value="${escapeHtml(address)}">
<label for="code">Code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>
<button type="submit">Open the page</button>
</form>
${HAS_TERMS ? `<p class="fine">By continuing you accept the <a href="${c.env.APP_ORIGIN}/terms">Terms</a> and <a href="${c.env.APP_ORIGIN}/privacy">Privacy Policy</a>.</p>\n` : ''}<p class="fine">You typed ${emailText(address)}. Wrong email? <a href="/${page.id}">Start again</a></p>`,
    error ? 400 : 200,
  );
}

/** The gate of an approval page: not logged in, ask (or the code screen once an email was typed); logged in but not let in, Ask; asked (or told no), the wait. */
function gateScreen(c: Context, page: GatedPage, visitor: { email: string; status: string | null } | undefined, error?: string): Response {
  const owner = ownerText(page.owner_name);
  if (!visitor) {
    const typed = email.safeParse(c.req.query('email'));
    return typed.success ? codeScreen(c, page, typed.data) : askScreen(c, page);
  }
  const who = emailText(visitor.email);
  const notYou = `<p class="fine">Not you? <a href="/${page.id}/logout">Log out</a></p>`;
  if (visitor.status) return gate(c, page, `<p role="status">You asked ${owner} for access as ${who}. When ${owner} lets you in, you'll get an email, and this page opens when you reload it.</p>\n${notYou}`, 200);
  return gate(
    c,
    page,
    `<p>You're logged in as ${who}, and ${owner} hasn't let this email in yet.</p>
${errorLine(error)}
<form method="post" action="/${page.id}/ask"><button type="submit" autofocus>Ask ${owner} for access</button></form>
${notYou}`,
    error ? 429 : 200,
  );
}

/** A published approval page, for Ask. Undefined for anything else: asking means nothing there. */
async function gatedPage(c: ViewerContext, id: string): Promise<GatedPage | undefined> {
  const [page] = await c.var.sql<GatedPage[]>`
    select p.id, p.title, t.name as owner_name, coalesce(t.email, '') as owner_email from pages p join testers t on t.id = p.owner
    where p.id = ${id} and p.status = 'live' and p.published_at is not null and p.access = 'approval' and t.disabled_at is null`;
  return page;
}

const smallForm = bodyLimit({ maxSize: 4096, onError: (c) => c.text('That request is too big.', 413) });

// Ask files one request. A logged-in visitor asks as their login's email, with no fields; asking again, or the owner asking, files nothing.
// Anyone else types their email, which nothing has checked: only the inbox it names gets the login link and code, so that is who can open the page (src/access.ts askWithEmail).
viewer.post('/:id{[A-Za-z0-9]{8}}/ask', smallForm, withDb, async (c) => {
  const page = await gatedPage(c, c.req.param('id'));
  if (!page) return removed(c);
  const as = await loggedInAs(c);
  const visitor = as === undefined ? undefined : await visitorStatus(c.var.sql, page.id, as);
  if (visitor) {
    if (!visitor.status && visitor.email !== page.owner_email) {
      try {
        await askForAccess(c.var.sql, c.env, page, visitor.email);
      } catch (error) {
        if (error instanceof CampfileError) return gateScreen(c, page, visitor, error.message);
        throw error;
      }
    }
    return c.redirect(`/${page.id}`, 303);
  }
  const typed = (await c.req.parseBody()).email;
  const address = email.safeParse(typed);
  if (!address.success) return askScreen(c, page, typeof typed === 'string' ? typed : '', address.error.issues[0].message, 400);
  if (address.data === page.owner_email) return c.redirect(`/${page.id}/login`, 303);
  try {
    await askWithEmail(c.var.sql, c.env, page, address.data, c.req.header(CLIENT_IP) ?? 'unknown');
  } catch (error) {
    if (error instanceof CampfileError) return askScreen(c, page, address.data, error.message, 429);
    throw error;
  }
  return c.redirect(`/${page.id}?email=${encodeURIComponent(address.data)}`, 303);
});

// The code from the email, typed here instead of clicking its link: the app's login code (src/signin.ts checkCode), with its limits and its acceptance of the terms.
// A right code logs this browser in as that email, as /signed-in does, and the page opens for it if it is let in.
// Login CSRF, as on the app's login (src/manage.ts sameOrigin): a code posted from another site would log this browser in as the attacker.
viewer.post('/:id{[A-Za-z0-9]{8}}/enter', smallForm, withDb, async (c) => {
  if (c.req.header('Sec-Fetch-Site') !== 'same-origin' && c.req.header('Origin') !== new URL(c.req.url).origin) {
    return c.text('That login came from another site. Open the page and log in there.', 403);
  }
  const page = await gatedPage(c, c.req.param('id'));
  if (!page) return removed(c);
  const form = await c.req.parseBody();
  const address = email.safeParse(form.email);
  if (!address.success) return askScreen(c, page, '', address.error.issues[0].message, 400);
  try {
    const tester = await checkCode(c.var.sql, address.data, typeof form.code === 'string' ? form.code : '', { env: c.env, waitUntil: c.var.waitUntil, via: `the code screen of page ${c.env.VIEWER_ORIGIN}/${page.id}` });
    c.header('Set-Cookie', await personCookie(c, tester));
    return c.redirect(`/${page.id}`, 303);
  } catch (error) {
    if (error instanceof CampfileError) return codeScreen(c, page, address.data, error.message);
    throw error;
  }
});

// The link-preview image's address. Its ?v= changes with every new screenshot, so apps that cached an older image fetch the new one.
const previewUrl = async (origin: string, id: string, file: string) => `${origin}/${id}/preview.jpg?v=${(await sha256Hex(file)).slice(0, 8)}`;

// The title card's tags: none where the deployment draws no card.
const cardTags = (env: ViewerEnv, origin: string, id: string, title: string) =>
  env.TITLE_CARD ? [ogTag('og:image', `${origin}/${id}/card.png?v=${cardVersion(title)}`), ogTag('og:image:width', PREVIEW_WIDTH), ogTag('og:image:height', PREVIEW_HEIGHT), ogTag('og:image:type', 'image/png')] : [];

// --- Readers of a page that sees how it's shared (docs/SPEC.md "See how it's shared") ---------------------------------------
// The page always opens. A stranger's browser gets the consent banner; Allow makes a random key for this page in the browser (bar.js), and /arrive files the browser under the link
// in the address (/<id>-<code>) and answers with its own link, which bar.js puts in the address bar. The server keeps only the key's hash, so only that browser can find its entry.
// AI readers get theirs on the frame page itself.

/** A published page open to anyone with the link, with its sharing. */
async function sharedPage(c: ViewerContext, id: string) {
  const [page] = await c.var.sql<{ owner: number; sharing: Sharing }[]>`
    select owner, sharing from pages
    where id = ${id} and status = 'live' and published_at is not null and access = 'link' and owner in (select id from testers where disabled_at is null)`;
  return page;
}

// Only the bar script's fetch (Sec-Fetch-Dest: empty) from this site, as countOpen takes only the frame's load: no navigation, form post, other site or bot.
const fromBarScript = (c: ViewerContext) => c.req.header('Sec-Fetch-Dest') === 'empty' && c.req.header('Sec-Fetch-Site') === 'same-origin' && !robot(c);
/** The bar script's JSON with a well-formed key, else null. */
async function keyed(c: ViewerContext): Promise<{ key: string; via?: unknown; email?: unknown } | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === 'object' && 'key' in body && typeof body.key === 'string' && KEY.test(body.key) ? (body as { key: string }) : null;
}

// After Allow, and on every later load of a browser that allowed: its own link, the same one every time. Null when not tracking (the owner, a bot, sharing off, at the cap).
// An 'emails' page needs the email for a browser it doesn't know yet; without one, `ask` sends bar.js back to the banner.
viewer.post('/:id{[A-Za-z0-9]{8}}/arrive', smallForm, withDb, async (c) => {
  const id = c.req.param('id');
  if (!fromBarScript(c)) return c.json({ url: null });
  const body = await keyed(c);
  if (!body) return c.json({ error: 'A key of 22 letters and digits is needed.' }, 400);
  const page = await sharedPage(c, id);
  if (!page || page.sharing === 'off' || (await loggedInAs(c)) === page.owner) return c.json({ url: null });
  let label: string | null = null;
  if (page.sharing === 'emails' && !(await hasEntry(c.var.sql, id, body.key))) {
    const typed = email.safeParse(body.email);
    if (!typed.success) return c.json({ url: null, ask: true });
    label = typed.data;
  }
  const via = typeof body.via === 'string' ? body.via : null;
  const { code } = await arrive(c.var.sql, { page: id, via, key: body.key, label, country: countryOf(c.req.header(CLIENT_COUNTRY)), device: deviceOf(c.req.header('User-Agent') ?? '') });
  return c.json({ url: code && `${new URL(c.req.url).origin}/${id}-${code}` });
});

// --- Login (docs/SPEC.md "Login") ----------------------------------------------------------------------------------
// Log in: a fresh state in this browser, then the app's login, which comes back to /signed-in with a ticket for that state. Already logged in on the app: straight back, no screen.
// An approval email links here with `invite`, passed on for the app to fill in the invited email.
// `then=spread` (the sheet's See how it spread) lands on /:id/spread instead of the page: kept with the state in this browser, never sent on, and only that one word.
viewer.get('/:id{[A-Za-z0-9]{8}}/login', (c) => {
  const state = newState();
  c.header('Set-Cookie', cookie(LOGIN_COOKIE, c.req.query('then') === 'spread' ? `${state}.spread` : state, 600));
  const query = new URLSearchParams({ page: c.req.param('id'), state });
  if (c.req.query('switch')) query.set('switch', '1');
  const invite = c.req.query('invite');
  if (invite) query.set('invite', invite);
  return c.redirect(`${c.env.APP_ORIGIN}/viewer-login?${query}`, 303);
});

// The ticket counts only with the state this browser keeps, so a ticket link sent to someone else logs nobody in. An invite's hand-over brings a pass for its page instead, bound the same way.
// The email's login link opened in another browser lands here without that state; that browser is logged in on the app by then, so Continue finishes with no screen.
// Logging in files no request: the gate shows Ask (see "Visitors of an approval page").
viewer.get('/:id{[A-Za-z0-9]{8}}/signed-in', async (c) => {
  const id = c.req.param('id');
  const [state = '', then] = (getCookie(c, LOGIN_COOKIE) ?? '').split('.');
  const ours = STATE.test(state);
  const tester = ours ? await readSignedId(c.env.PREVIEW_SECRET, `ticket:${state}`, c.req.query('t')) : undefined;
  const version = c.req.query('v') ?? '';
  const pass = ours && tester === undefined && VERSION.test(version) ? await readSignedId(c.env.PREVIEW_SECRET, `pass-ticket:${id}:${state}:${version}`, c.req.query('pass')) : undefined;
  const set = tester !== undefined ? await personCookie(c, tester) : pass !== undefined ? await passCookie(c, id, pass, version) : undefined;
  if (!set) return notice(c, 'Almost there', 'This login started in another browser or app, or took too long.', `<p><a href="/${id}/login${then === 'spread' ? '?then=spread' : ''}">Continue</a></p>`);
  c.header('Set-Cookie', set);
  c.header('Set-Cookie', cookie(LOGIN_COOKIE, '', 0), { append: true });
  return c.redirect(`/${id}${then === 'spread' ? '/spread' : ''}`, 303);
});

// Log out here and on the app, or the next Log in would skip the code. It ends this page's pass too.
viewer.get('/:id{[A-Za-z0-9]{8}}/logout', (c) => {
  const pass = passName(c.req.param('id'));
  c.header('Set-Cookie', cookie(VIEWER_LOGIN, '', 0));
  for (const name of [pass, oldCookie(VIEWER_LOGIN), oldCookie(pass)]) c.header('Set-Cookie', cookie(name, '', 0), { append: true });
  return c.redirect(`${c.env.APP_ORIGIN}/signout?page=${c.req.param('id')}`, 303);
});

export default viewer;
