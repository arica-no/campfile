// The owner's page view (docs/SPEC.md "Managing a page"): `/p/:id` is the page itself, in a frame served by the viewer, under a dark bar of tools; `/p/:id/manage` is the same screen with the page's panel (src/wall-view.ts pageSheet) slid over it.
// The frame's address carries a ticket (src/manage.ts) that makes the viewer treat this browser as the page's owner: the viewer's login cookie is SameSite=Lax, so a frame on another site never gets it.
import { screenHeaders } from './connector.ts';
import { escapeHtml as e, FAVICON_LINKS } from './html.ts';
import { SCAN_CSS, WALL_CSS } from './wall-style.ts';
import { keep, pageSheet, WALL_CSP, who, type PageSheet, type SheetView } from './wall-view.ts';

// The bar's icons are the viewer's owner bar's, drawn with the wall's .ic (the same 18px line style).
const svg = (path: string) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const icon = {
  up: svg('<path d="M12 15V4M7 9l5-5 5 5M5 20h14"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  manage: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  exit: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  logout: svg('<path d="M10 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4M16 16l4-4-4-4M20 12H10"/>'),
  back: svg('<path d="M19 12H5M11 18l-6-6 6-6"/>'),
};

// The bar is the viewer's owner bar as it was: dark in a light browser too, with its phone sizes. Its rules sit under .bar (and #full) so the wall's own .tools, .label and h1 do not reach it, and it does not reach the panel's .btn.primary.
const BAR_CSS = `
html{height:100%;background:#16130f;scrollbar-gutter:auto}
body.pv-screen{height:100%;min-height:0;background:#16130f}
#page{display:flex;flex-direction:column;height:100%}
.bar{flex:none;display:flex;align-items:center;gap:6px;height:46px;padding:0 6px;background:#16130f;color:#f4eee6}
.bar h1{flex:1;min-width:0;margin:0;font:600 14px/1.2 var(--sans);letter-spacing:normal;text-wrap:wrap;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar .tools{display:flex;flex:none;flex-wrap:nowrap;align-items:center;gap:4px;margin:0}
.bar .label{font:inherit}
.ib,.bar .meta,.bar .primary{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;border:0;border-radius:8px;font:600 13px/1 var(--sans);color:inherit;text-decoration:none;cursor:pointer;white-space:nowrap}
.ib{width:36px;padding:0;background:transparent}
.bar .meta{padding:0 9px;background:transparent;color:#d9cdbb}
.ib:hover,.bar .meta:hover{background:rgba(244,238,230,.08)}
.bar .primary{padding:0 13px 0 10px}
.bar .primary.publish{background:#f4eee6;color:#16130f}
.bar .primary.publish:hover{background:#fff}
.bar .primary.manage{background:transparent;box-shadow:inset 0 0 0 1px rgba(244,238,230,.28)}
.bar .primary.manage:hover{background:rgba(244,238,230,.08)}
.bar .state{flex:none;display:inline-flex;align-items:center;height:26px;padding:0 10px;margin-left:2px;border-radius:4px;font:800 11px/1 system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;cursor:default}
.bar .state.draft{color:#f5c542;background:rgba(245,197,66,.1);box-shadow:inset 0 0 0 1.5px rgba(245,197,66,.45)}
.bar .state.live{color:#08210f;background:#3ddc6e}
.bar .acc{flex:none;margin:0 6px 0 2px;color:#d9cdbb;font:500 13px/1 var(--sans);white-space:nowrap}
[data-tip]:hover::after,[data-tip]:focus-visible::after,[data-tip].copied::after{content:attr(data-tip);position:absolute;top:calc(100% + 6px);right:0;z-index:2;padding:6px 8px;border-radius:6px;background:#2a241c;color:#f4eee6;font:500 12px/1 system-ui,sans-serif;pointer-events:none}
.bar .back[data-tip]::after{right:auto;left:0}
.bar :focus-visible,#full:focus-visible{outline-color:#f2a541}
/* Phones (≤520px): Copy link, Publish and Manage go icon-only (the labels stay in their aria-labels and tips) and the title may take two lines; a tighter lamp under 420px. */
@media (max-width:520px){.bar .meta .label,.bar .primary .label{display:none}.bar .meta,.bar .primary.manage,.bar .primary.publish{width:36px;padding:0}.bar h1{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;white-space:normal;overflow-wrap:anywhere;line-height:16px}}
/* Up to 799px: the lamp and who can open it go on their own row under the title, so the title keeps the width beside the tools; the bar grows to hold it. One row from 800px. */
@media (max-width:799px){.bar{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;align-items:center;column-gap:6px;row-gap:3px;height:auto;min-height:46px;padding:7px 6px 6px}.bar>.back{grid-column:1;grid-row:1}.bar h1{grid-column:2/4;grid-row:1}.bar>.tools{grid-column:4;grid-row:1}.bar>.state{grid-column:2;grid-row:2;margin:0;height:22px}.bar .acc{grid-column:3/-1;grid-row:2;margin:0;white-space:normal;font-size:12px;line-height:14px}}
@media (max-width:420px){.bar .state{padding:0 7px;letter-spacing:.06em}}
/* Full page: #full hides the bar and shows a small way back. */
.exit{display:none}
#full:target{position:fixed;top:8px;right:8px;z-index:1;display:grid;background:rgba(22,19,15,.72);color:#f4eee6;opacity:.75}
#full:target:hover,#full:target:focus-visible{opacity:1;background:#16130f}
#full:target ~ #page .bar{display:none}
iframe.page{flex:1;width:100%;border:0;background:#fff}
`;

/**
 * The whole screen of one page: the bar, the page in its frame, and the panel (open or not). `ticket` is the 12-hour pass the frame's address carries (see above); `open` shows the panel, with the page behind it inert.
 * `status` is the HTTP status (400 for a form that failed).
 */
export function pageScreen(v: SheetView, s: PageSheet, open: boolean, ticket: string, status = 200): Response {
  const { page: p } = s;
  const k = keep(v);
  // Back goes to the page's group, unless the owner came from a filter or search, which lists every group's pages under Your pages.
  const group = v.show === 'all' && !v.q.trim() ? p.group_id : null;
  const title = e(p.title);
  const manage = `/p/${p.id}/manage${k}`;
  // The public link works only once the page is published, so only then is it shown.
  const tools = p.published
    ? `<button type="button" class="meta" data-copy="${e(`${v.viewer}/${p.id}`)}" aria-label="Copy link, the one to share" data-tip="Copy link to share" hidden>${icon.link}<span class="label">Copy link</span></button><a class="primary manage" href="${manage}" aria-label="Manage: who can open it, unpublish, delete" data-tip="Who can open it, unpublish, delete" data-manage>${icon.manage}<span class="label">Manage</span></a>`
    : `<a class="primary publish" href="${manage}" aria-label="Publish or delete" data-tip="Publish or delete" data-manage>${icon.up}<span class="label">Publish</span></a>`;
  const state = p.published
    ? `<span class="state live" title="${p.access === 'approval' ? 'Published: only people you approve can open it' : 'Published: anyone with the link can open it'}">Published</span>`
    : `<span class="state draft" title="Draft: only you can open it">Draft</span>`;
  // The panel slides in when it is opened from the page, not when it reloads after an action or a refused form.
  const enter = open && !v.done && !s.error;
  // Log out ends this address's session first (src/manage.ts /signout: an alias has its own), then goes by the viewer's /logout: it ends the viewer's login, which sends the owner's visits to the viewer's /<id> back here for LOGIN_DAYS, then the main address's session, and lands on the public page.
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#16130f">
<meta name="robots" content="noindex">
${FAVICON_LINKS}
<title>${title} · Campfile</title>
<style>${WALL_CSS}${v.scan ? SCAN_CSS : ''}${BAR_CSS}</style>
<script src="/takeover.js"></script>
<script src="/manage.js" defer></script>
</head>
<body class="pv-screen${enter ? ' enter' : ''}"${v.scan ? ' data-scan' : ''}>
<a id="full" class="ib exit" href="#" aria-label="Show the bar again" data-tip="Exit full page">${icon.exit}</a>
<div id="page"${open ? ' inert' : ''}>
<header class="bar"><a class="ib back" href="${group ? `/my/groups/${group}` : '/my'}${k}#tile-${p.id}" aria-label="Back to ${group ? 'its group' : 'your pages'}" data-tip="${group ? 'Its group' : 'Your pages'}">${icon.back}</a><h1>${title}</h1>${state}<span class="acc">${who(p)}</span><div class="tools">${tools}<a class="ib" href="/signout?page=${p.id}&amp;viewer=1" aria-label="Log out" data-tip="Log out">${icon.logout}</a><a class="ib" href="#full" aria-label="Full page: hide this bar" data-tip="Full page">${icon.full}</a></div></header>
<iframe class="page" title="${title}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="${e(`${v.viewer}/${p.id}/raw?t=${ticket}`)}"></iframe>
</div>
<div id="panel"${open ? '' : ' hidden'}>${pageSheet(v, s, Date.now(), ticket)}</div>
</body>
</html>`;
  return new Response(body, { status, headers: screenHeaders(`${WALL_CSP}; frame-src ${v.viewer}`, new Headers({ 'Content-Type': 'text/html; charset=utf-8' })) });
}
