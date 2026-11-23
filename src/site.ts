import { FOOTER_NOTE, OWN_CSS, OWN_PAGES } from './hosted.ts';
import { FAVICON_LINKS, LOGO_MARK } from './html.ts';

/** What the site's pages share: colours, type, the header and the footer. The info pages (/docs, /guide and OWN_PAGES of src/hosted.ts) are fragments in public/: a `<title>` line, then the content, put in this shell by infoPage. */

export const SITE_CSS = `
:root{--ember:#16130f;--umber:#1f1a14;--umber-2:#2a241c;--well:#0f0c09;--cream:#f4eee6;--muted:#d9cdbb;--dim:#b5a894;--flame:#f2a541;--on-flame:#3d2c10;--hairline:rgba(244,238,230,.12);--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--display:ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--ring:var(--flame);--gutter:clamp(18px,5vw,40px)}
*{box-sizing:border-box}
html{background:var(--ember);color:var(--cream);color-scheme:dark;scroll-behavior:smooth;scrollbar-color:var(--umber-2) var(--ember);-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:rgba(242,165,65,.28)}
body{margin:0;font:1.0625rem/1.55 var(--sans);text-wrap:pretty}
h1,h2,h3,p,ul,ol,figure{margin:0}
ul,ol{padding:0;list-style:none}
a{color:inherit;text-decoration-thickness:1.5px;text-underline-offset:.22em}
a:hover{text-decoration-thickness:3px}
::selection{background:var(--flame);color:var(--ember)}
:focus-visible{outline:2px solid var(--ring);outline-offset:3px}
.sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wrap{width:min(100% - 2*var(--gutter),72.5rem);margin-inline:auto}

/* header */
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px}
.brand{display:inline-flex;align-items:center;gap:9px;min-height:44px;font:800 1.2rem/1 var(--display);letter-spacing:-.01em;text-decoration:none}
.logo{width:26px;height:26px;flex:none}
.brand:hover{opacity:.8}
.nav{display:flex;align-items:center;gap:4px}
.nav a{white-space:nowrap}
.login{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border-radius:10px;font:700 .9375rem/1 var(--display);text-decoration:none}
.login:hover{background:var(--umber-2)}
@media(max-width:399px){.top{gap:10px}.nav{gap:0}.login{padding:0 8px}}
/* Under 360px the header keeps the logo and drops the word: the link's aria-label still names it. */
@media(max-width:359px){.top .brand .wm{display:none}}

/* footer */
.foot{padding:0 0 56px;color:var(--dim);font-size:.9375rem}
.foot .wrap{padding-top:40px}
.foot ul{display:grid;margin:6px 0 0}
.foot li a{display:inline-flex;align-items:center;min-height:44px}
.foot a{color:var(--muted)}
.foot a[aria-current]{color:var(--cream);font-weight:600}
.foot .co{margin-top:18px}
@media(min-width:900px){.foot ul{grid-auto-flow:column;justify-content:start;gap:28px}}

@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

/** The flame button of the landing page and the self-hosted home (src/home.ts). */
export const BTN_CSS = `
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:52px;padding:12px 22px;border:0;border-radius:12px;background:var(--flame);color:var(--ember);font:700 1.0625rem/1.2 var(--display);text-align:center;text-wrap:balance;text-decoration:none;cursor:pointer;transition:transform .15s,filter .15s}
@media(hover:hover){.btn:hover{filter:brightness(1.08)}}
.btn:active{transform:translateY(1px)}
`;

/** A /guide step: words and actions on the left, the chat or form it makes on the right. */
export const STEP_CSS = `
.gd :is(h2,h3,p,ul,ol,li){margin:0;padding:0;border:0;list-style:none}
.gd li+li{margin:0}
.gd fieldset{min-width:0;margin:0;padding:0;border:0}
.gd code{padding:0;border-radius:0;background:none;color:var(--cream)}
.gd p{color:var(--muted)}
.gd b{color:var(--cream)}
.gd .step{display:grid;grid-template-columns:minmax(0,420px) minmax(0,1fr);gap:64px;align-items:start;padding:36px 0;border-top:1px solid var(--hairline);scroll-margin-top:72px}
.gd .n{color:var(--dim);font:700 .9375rem/1 var(--display)}
.gd h3{margin-top:10px;font:800 1.625rem/1.15 var(--display);letter-spacing:-.02em;text-wrap:balance}
.gd .step p{margin-top:10px}
.gd .step p.n{margin-top:0}
.gd .step p.note,.gd .step p.lead{color:var(--dim);font-size:.9375rem}
.gd .step p.lead{margin-top:18px}
.gd .app b{font-weight:600}
.gd .say{margin-top:16px;padding:12px 14px;border-radius:10px;background:var(--well);box-shadow:inset 0 0 0 1px rgba(242,165,65,.45);color:var(--cream);font:500 .9375rem/1.45 var(--mono)}
.gd .say code{font:inherit}
.gd .go{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.gd .say+.go{margin-top:8px}
.gd .btn{display:inline-flex;align-items:center;gap:8px;height:42px;min-height:0;padding:0 16px;border:0;border-radius:10px;background:var(--cream);color:var(--ember);font:700 .9375rem/1 var(--display);text-decoration:none;cursor:pointer}
.gd .btn:hover{background:#fff}
.gd .btn.alt{background:none;color:var(--cream);box-shadow:inset 0 0 0 1px rgba(244,238,230,.28)}
.gd .btn.alt:hover{background:var(--umber-2)}
.gd button[data-copy]{display:none}
.js .gd button[data-copy]{display:inline-flex}
.gd .ic{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
/* step 2: four starters, radios without script like step 1's tabs, each swapping its prompt and the chat beside it */
.gd .tries{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:16px}
.gd .tries label{display:grid;gap:8px;padding:6px 6px 10px;border-radius:12px;background:var(--well);box-shadow:inset 0 0 0 1px var(--hairline);color:var(--muted);font:700 .9375rem/1.2 var(--display);text-align:center;cursor:pointer}
.gd .tries img{display:block;width:100%;height:auto;border-radius:7px}
.gd .tries label:has(:checked){color:var(--cream);box-shadow:inset 0 0 0 2px var(--cream)}
.gd .tries label:has(:focus-visible){outline:2px solid var(--ring);outline-offset:2px}
@media(hover:hover){.gd .tries label:not(:has(:checked)):hover{background:var(--umber);color:var(--cream)}}
.gd .try{display:none}
.gd:has(#t-yoga:checked) .t-yoga,.gd:has(#t-campaign:checked) .t-campaign,.gd:has(#t-pay:checked) .t-pay,.gd:has(#t-conference:checked) .t-conference{display:block}
.gd .tries~.try{margin-top:24px}
.gd .try>.say{margin-top:0}
.gd .note a{color:var(--cream)}
.gd .shot{display:block;width:100%;max-width:30rem;height:auto;border-radius:12px;box-shadow:0 0 0 1px var(--hairline)}
/* step 1: four equal app tabs, radios without script, each swapping the words and the form beside them */
.gd .apps{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:20px 0 6px;padding:4px;border-radius:12px;background:var(--well);box-shadow:inset 0 0 0 1px var(--hairline)}
.gd .apps label{display:grid;place-items:center;height:40px;border-radius:9px;color:var(--muted);font:700 .9375rem/1 var(--display);cursor:pointer}
.gd :is(.apps,.tries) input{position:absolute;opacity:0;pointer-events:none}
.gd .apps label:has(:checked){background:var(--cream);color:var(--ember)}
.gd .apps label:has(:focus-visible){outline:2px solid var(--ring);outline-offset:2px}
.gd .app{display:none}
.gd:has(#a-claude:checked) .claude,.gd:has(#a-gpt:checked) .gpt,.gd:has(#a-gem:checked) .gem,.gd:has(#a-other:checked) .other{display:grid}
/* step 2: "I have a page" or "Try an example", one path at a time; Open in follows step 1's app */
.gd .ways{grid-template-columns:repeat(2,1fr);margin-bottom:16px}
.gd .way{display:none}
.gd:has(#w-have:checked) .w-have,.gd:has(#w-try:checked) .w-try{display:block}
.gd .way>p:first-child{margin-top:0}
.gd .open,.gd .at{display:none}
.gd:has(#a-claude:checked) .o-claude,.gd:has(#a-gpt:checked) .o-gpt{display:inline-flex}
.gd:has(#a-gpt:checked) .at,.gd:has(#a-gem:checked) .at{display:block}
.gd #step-2 .go{display:grid;grid-template-columns:minmax(0,1fr)}
.gd #step-2 .go .btn{justify-content:center}
.gd .fields{gap:16px}
.gd .fields label{display:grid;gap:8px;color:var(--dim);font:600 .8125rem/1 var(--sans)}
.gd .addr{display:flex;align-items:center;gap:12px;min-height:50px;padding:8px 8px 8px 14px;border-radius:10px;background:var(--well);box-shadow:inset 0 0 0 1px var(--hairline)}
.gd .addr code{flex:1;min-width:0;font:500 .9375rem/1.4 var(--mono);overflow-wrap:anywhere}
.gd .addr .btn{height:34px;font-size:.875rem}
/* the example chat: a plain conversation, not any one app's look */
.gd .chat{padding:22px 24px 24px;border-radius:18px;background:var(--umber);box-shadow:inset 0 0 0 1px var(--hairline),0 18px 40px -24px rgba(0,0,0,.7)}
.gd .who{color:var(--dim);font:600 .8125rem/1 var(--sans)}
.gd .me{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.gd .me+.me{margin-top:14px}
.gd .me q{quotes:none;max-width:30rem;padding:12px 16px;border-radius:16px 16px 4px 16px;background:var(--cream);color:var(--ember);font:500 1.0625rem/1.4 var(--sans)}
.gd .ai{display:flex;flex-direction:column;gap:8px;margin-top:18px}
.gd .ai p{max-width:34rem;font-size:1rem}
.gd .card{display:flex;flex-wrap:wrap;align-items:center;gap:12px;max-width:30rem;padding:10px 12px 10px 14px;border-radius:12px;background:var(--well);box-shadow:inset 0 0 0 1px var(--hairline)}
.gd .card .t{flex:1 1 auto;min-width:0}
.gd .card b{display:block;font:600 .9375rem/1.3 var(--sans)}
.gd .card .t span{display:block;color:var(--dim);font:.8125rem/1.3 var(--mono);overflow-wrap:anywhere}
.gd .lamp{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:4px;background:rgba(245,197,66,.1);box-shadow:inset 0 0 0 1.5px rgba(245,197,66,.45);color:#f5c542;font:800 10.5px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase}
.gd .lamp.live{background:#3ddc6e;box-shadow:none;color:#08210f}
.gd .rows{display:grid;gap:6px;max-width:30rem}
.gd .rows li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px 10px 14px;border-radius:12px;background:var(--well);box-shadow:inset 0 0 0 1px var(--hairline);color:var(--cream);font:.9375rem/1.3 var(--mono)}
.gd .rows em{color:var(--dim);font:700 .8125rem/1 var(--sans)}
.gd .rows em.ok{color:#7bd88f}
.gd .bars{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;align-items:end;max-width:30rem;height:120px;padding:12px 14px 30px;border-radius:12px;background:var(--well);box-shadow:inset 0 0 0 1px var(--hairline)}
.gd .bars i{position:relative;height:var(--h);border-radius:3px;background:var(--flame)}
.gd .bars span{position:absolute;top:calc(100% + 8px);left:50%;translate:-50% 0;color:var(--dim);font:600 .75rem/1 var(--sans)}
.gd .fold{width:22px;height:22px;color:var(--flame)}
.gd .tree{max-width:30rem;padding:12px 14px;border-radius:12px;background:var(--well);box-shadow:inset 0 0 0 1px var(--hairline);color:var(--cream);font-size:.9375rem}
.gd .tree ul{margin-left:10px;padding-left:14px;border-left:1px solid var(--hairline)}
.gd .tree li{padding-top:6px}
.gd .tree span{margin-left:6px;color:var(--dim);font-size:.8125rem}
@media(max-width:900px){
.gd .step{grid-template-columns:minmax(0,1fr);gap:24px}
.gd .go{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))}
.gd .go>:only-child{grid-column:1/-1}
.gd .btn{height:44px}
.gd .chat.try .me{display:none}
.gd .chat.try .ai{margin-top:0}
.gd .go .btn{justify-content:center}
}
`;

// The info pages' text: one reading column, left-aligned with the header's logo.
const DOC_CSS = `
.doc{padding-block:clamp(20px,4vw,48px) clamp(16px,3vw,32px)}
.doc>*{max-width:46rem}
.doc h1{font:800 clamp(2rem,1.4rem + 2.6vw,3rem)/1.08 var(--display);letter-spacing:-.025em;text-wrap:balance}
.doc .meta{margin-top:12px;color:var(--dim)}
.doc h2{margin-top:48px;padding-top:24px;border-top:1px solid var(--hairline);font:800 1.5rem/1.2 var(--display);letter-spacing:-.015em;text-wrap:balance}
.doc h3{margin-top:28px;font:700 1.125rem/1.3 var(--display)}
.doc h3+p{margin-top:6px}
.doc p,.doc ul,.doc ol,.doc .tw{margin-top:14px}
.doc p,.doc li{color:var(--muted)}
.doc ul,.doc ol{padding-left:1.25em}
.doc ul{list-style:disc}
.doc ol{list-style:decimal}
.doc li+li{margin-top:8px}
.doc li::marker{color:var(--dim)}
.doc strong,.doc b,.doc a{color:var(--cream)}
.doc code{padding:1px 6px;border-radius:6px;background:var(--umber-2);color:var(--cream);font:.9em/1.4 var(--mono);overflow-wrap:anywhere}
.tw{overflow-x:auto;border-radius:12px;box-shadow:inset 0 0 0 1px var(--hairline)}
.tw table{width:100%;border-collapse:collapse;font-size:.9375rem;line-height:1.5}
.tw th,.tw td{padding:10px 14px;text-align:left;vertical-align:top;color:var(--muted)}
.tw tr+tr td{border-top:1px solid var(--hairline)}
.tw th{background:var(--umber);color:var(--cream);font-weight:600}
${OWN_CSS}/* /guide: per step, the sentence to say and the chat it makes; a bar under the header keeps "Step N of 16" in view */
html:has(.gd){overflow-x:clip}
.doc:has(.gd){padding-top:0}
.doc>.gd{max-width:none}
${STEP_CSS}
.gd .here{position:sticky;top:0;z-index:1;display:grid;grid-template-columns:340px minmax(0,1fr);align-items:center;gap:28px;height:56px;background:var(--ember);box-shadow:0 0 0 100vmax var(--ember);clip-path:inset(0 -100vmax)}
.gd .here::before,.gd .here::after{content:"";position:absolute;left:-100vmax;right:-100vmax;height:1px;background:var(--hairline)}
.gd .here::before{top:0}
.gd .here::after{bottom:0}
.gd .now{display:flex;align-items:baseline;gap:8px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--cream);font:700 .9375rem/1 var(--display)}
.gd .now span{color:var(--dim);font:600 .875rem/1 var(--sans)}
.gd .lv{display:grid;grid-template-columns:5fr 6fr 5fr;gap:10px}
.gd .lv li{display:grid;gap:7px}
.gd .gl{order:2;color:var(--dim);font:600 .8125rem/1 var(--sans);text-decoration:none}
.gd .on .gl{color:var(--cream)}
.gd .seg{display:grid;grid-auto-flow:column;gap:3px;height:4px}
.gd .seg a{position:relative;border-radius:2px;background:var(--umber-2)}
.gd .seg a::after{content:"";position:absolute;inset:-10px 0}
.gd .seg a.done{background:var(--cream)}
.gd .gh{padding-top:clamp(28px,4vw,44px)}
.gd .lede{max-width:40rem;margin-top:10px;font-size:1.125rem}
.gd .lvh{padding:72px 0 12px;scroll-margin-top:56px}
.gd .lvh h2{font:800 2rem/1.1 var(--display);letter-spacing:-.02em}
.gd .lvh p{margin-top:8px}
.gd .end{margin-top:56px}
@media(max-width:900px){
.gd .here{grid-template-columns:1fr;gap:8px;height:auto;padding:10px 0}
}
@media(forced-colors:active){.tw{border:1px solid CanvasText}}
`;

/** The Campfile mark itself (src/html.ts), as the viewer's signature draws it. */
export const logo = `<svg class="logo" viewBox="4 3.5 24 24" aria-hidden="true">${LOGO_MARK}</svg>`;

/** `signedIn`: this browser has a login, so the link to its pages says so. */
export const siteHeader = (signedIn = false) => `<header class="wrap top">
<a class="brand" href="/" aria-label="Campfile, home">${logo}<span class="wm">Campfile</span></a>
<nav class="nav" aria-label="Main"><a class="login" href="/guide">Guide</a><a class="login" href="/my">${signedIn ? 'Your pages' : 'Log in'}</a></nav>
</header>`;

const FOOTER_LINKS = [
  ['/guide', 'What you can do'],
  ['/docs', 'How it works'],
  ...OWN_PAGES,
  ['/agents', 'For AI assistants (plain text)'],
];

/** The footer; `current` is the path of the page it is on, so its link says so. */
export const siteFooter = (current = '/') => `<footer class="foot">
<div class="wrap">
<a class="brand" href="/" aria-label="Campfile, home">${logo}Campfile</a>
<ul>
${FOOTER_LINKS.map(([href, label]) => `<li><a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a></li>`).join('\n')}
</ul>
${FOOTER_NOTE && `<p class="co">${FOOTER_NOTE}</p>
`}</div>
</footer>`;

/** An info page at `path`, from its fragment in public/ (a `<title>` line, then the content). */
export function infoPage(path: string, fragment: string, signedIn = false): string {
  const match = /^<title>(.+)<\/title>\n/.exec(fragment);
  if (!match) throw new Error(`${path}: its file in public/ must start with a <title> line`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#16130f">
<meta name="color-scheme" content="dark">
${match[0].trim()}
${FAVICON_LINKS}
<style>${SITE_CSS}${DOC_CSS}</style>
</head>
<body>
${siteHeader(signedIn)}
<main class="wrap doc">
${fragment.slice(match[0].length)}</main>
${siteFooter(path)}
</body>
</html>`;
}
