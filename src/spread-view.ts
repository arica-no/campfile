// "How it spread" (docs/SPEC.md): the page <viewer>/<id>/spread. The viewer (src/viewer.ts) decides who sees it and in which mode; this file only writes the HTML.
// The header (.sp-bar) is ours; everything in <main id="spread"> is drawn by the chosen design's script from the #spread-data JSON (viewer/public/spread/data.js reads it).
// Pure: no server imports at run time.
import { escapeHtml as e, LOGO_MARK } from './html.ts';
import type { ShareEntry, ShareTree } from './sharing.ts';

export const DESIGNS = ['ember', 'cascade'] as const;
export type Design = (typeof DESIGNS)[number];
const NAMES: Record<Design, string> = { ember: 'Ember', cascade: 'Cascade' };
/** `?design=`: one of the two, else cascade (so an old `?design=rings` link opens Cascade). */
export const designOf = (asked: string | undefined): Design => (DESIGNS as readonly string[]).includes(asked ?? '') ? (asked as Design) : 'cascade';
/** A public spread view's link-preview image in the bucket: one per page and design, replaced in place when it is refreshed. */
export const spreadFile = (id: string, design: Design) => `spread/${id}/${design}.jpg`;

/** An entry as the designs get it: no country or device ever; no label in public mode. */
export interface SpreadEntry {
  label: string | null;
  ai: string | null;
  first_opened: string;
  brought: number;
  reached: number;
  children: SpreadEntry[];
}
/** The #spread-data JSON (viewer/public/spread/data.js). `published`: the page's published_at, or updated_at for a draft; `now`: the server's time. ISO strings. */
export interface SpreadData {
  mode: 'owner' | 'public';
  design: Design;
  title: string;
  author: string | null;
  published: string;
  now: string;
  tree: { entries: number; capped: boolean; brought: number; children: SpreadEntry[] };
}

/** The owner's tree as the designs get it: country and device dropped, and in public mode every label too, and each first open rounded down to its UTC hour. */
export function spreadTree(tree: ShareTree, mode: SpreadData['mode']): SpreadData['tree'] {
  const owner = mode === 'owner';
  const hour = (iso: string) => new Date(Math.floor(Date.parse(iso) / 36e5) * 36e5).toISOString();
  const strip = (x: ShareEntry): SpreadEntry => ({ label: owner ? x.label : null, ai: x.ai, first_opened: owner ? x.first_opened : hour(x.first_opened), brought: x.brought, reached: x.reached, children: x.children.map(strip) });
  return { entries: tree.entries, capped: tree.capped, brought: tree.brought, children: tree.children.map(strip) };
}

const DAY = 864e5;
const utcDay = (iso: string) => Math.floor(Date.parse(iso) / DAY);

/** The numbers the sheet and the link preview name: people, levels (the deepest), sparks (people who passed it on; never an AI), and days from day 0 to the last first open. */
export interface SpreadCounts {
  entries: number;
  capped: boolean;
  levels: number;
  sparks: number;
  days: number;
}
export function spreadCounts(tree: Pick<ShareTree, 'entries' | 'capped' | 'children'>, published: string): SpreadCounts {
  let levels = 0;
  let sparks = 0;
  let first = utcDay(published);
  let last = first;
  const walk = (list: Pick<ShareEntry, 'ai' | 'brought' | 'first_opened' | 'children'>[], depth: number) => {
    for (const x of list) {
      levels = Math.max(levels, depth);
      if (x.brought > 0 && !x.ai) sparks++;
      first = Math.min(first, utcDay(x.first_opened));
      last = Math.max(last, utcDay(x.first_opened));
      walk(x.children, depth + 1);
    }
  };
  walk(tree.children, 1);
  return { entries: tree.entries, capped: tree.capped, levels, sparks, days: last - first + 1 };
}

const nf = new Intl.NumberFormat('en-GB');
const count = (n: number, one: string, many: string) => `${nf.format(n)} ${n === 1 ? one : many}`;
/** "1,000+ people" at the cap, else "1 person", "20 people". */
const peopleText = (c: { entries: number; capped: boolean }) => (c.capped ? `${nf.format(c.entries)}+ people` : count(c.entries, 'person', 'people'));
/** The link preview's description: "1,000+ people, 6 levels deep, in 12 days. Made with Campfile." */
export function spreadDescription(c: SpreadCounts): string {
  return c.entries ? `${peopleText(c)}, ${count(c.levels, 'level', 'levels')} deep, in ${count(c.days, 'day', 'days')}. Made with Campfile.` : 'Made with Campfile.';
}

const svg = (body: string) => `<svg class="sp-ic" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICON = {
  lock: svg('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5s1.1-6.1 3.5-8.5Z"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  open: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  chevron: '<svg class="sp-ic sp-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  check: '<svg class="sp-ic sp-ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  back: svg('<path d="M19 12H5M11 18l-6-6 6-6"/>'),
};

export interface SpreadShell {
  id: string;
  /** The app's origin: the status link (the sheet's How it spread section) and Made with Campfile. */
  app: string;
  /** Owner mode: whether anyone with the link can see it now (pages.spread_public on a page open to anyone with the link). */
  open: boolean;
  /** The public address of this view, for Copy link (owner, when open). */
  publicUrl: string;
  /** More of <head>: icons, link-preview tags. */
  head?: string;
  /** Where /spread/*.css and *.js are; the harness serves them from the repo. */
  assets?: string;
  /** Each design's address in the switch: `?design=<d>` here; the harness links its own files. */
  href?: (design: Design) => string;
  /** Public mode, `?shot=1`: the link-preview screenshot's layout (shell.css [data-shot]). It only hides things. */
  shot?: boolean;
}

// Browsers keep /spread/* for 4 hours (the CDN's browser cache) and this HTML is no-store, so a new ?v= makes them fetch new files.
// It is the first 8 hex of the SHA-256 of viewer/public/spread/* in name order; test/spread.test.ts fails with the new value when a file changes.
export const SPREAD_V = 'cf13763e';

/** The whole page. Loads only our own files (CSP script-src 'self', style-src 'self'): no inline script, style or handler. */
export function spreadHtml(data: SpreadData, s: SpreadShell): string {
  const assets = s.assets ?? '/spread';
  const v = `?v=${SPREAD_V}`;
  const href = s.href ?? ((d: Design) => `?design=${d}`);
  const title = e(data.title);
  const owner = data.mode === 'owner';
  let shot = '';
  if (s.shot && !owner) shot = ' data-shot="1"';
  const tabs = DESIGNS.map((d) => `<a href="${e(href(d))}"${d === data.design ? ' aria-current="page"' : ''}>${NAMES[d]}</a>`).join('');
  const said = s.open ? 'Anyone with the link can see this view (no names)' : 'Only you can see this view';
  const status = `<a class="sp-btn sp-st" href="${e(`${s.app}/p/${s.id}/manage#spread`)}" aria-label="${said}. Change who can see it">${s.open ? ICON.globe : ICON.lock}<span class="sp-long">${said}</span><span class="sp-short">${s.open ? 'Public view' : 'Private view'}</span>${ICON.chevron}</a>`;
  const tools = owner
    ? `${status}${
        s.open ? `<button type="button" class="sp-btn sp-primary" data-copy="${e(s.publicUrl)}" aria-label="Copy link to this view" hidden>${ICON.link}${ICON.check}<span class="sp-label">Copy link</span></button>` : ''
      }`
    : `<a class="sp-btn" href="/${e(s.id)}" aria-label="Open the page">${ICON.open}<span class="sp-label">Open the page</span></a><a class="sp-cta" href="${e(`${s.app}/`)}"><span class="sp-long">Made with&nbsp;</span><b>Campfile</b></a>`; // nbsp: .sp-cta is flex, which drops a plain trailing space
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#16130f" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f7f5f2" media="(prefers-color-scheme: light)">
<title>How “${title}” spread</title>
${s.head ?? ''}
<link rel="stylesheet" href="${assets}/tokens.css${v}">
<link rel="stylesheet" href="${assets}/shell.css${v}">
<link rel="stylesheet" href="${assets}/${data.design}.css${v}">
<script src="${assets}/shell.js${v}" defer></script>
</head>
<body class="spread" data-design="${data.design}" data-mode="${data.mode}"${shot}>${owner ? '\n<span id="from-sheet" hidden></span>' : ''}
<header class="sp-bar">
${owner ? `<a class="sp-btn sp-back" href="${e(`${s.app}/p/${s.id}/manage#spread`)}" data-back aria-label="Back">${ICON.back}<span class="sp-label">Back</span></a>\n` : ''}<svg class="sp-logo" viewBox="4 3.5 24 24" aria-hidden="true">${LOGO_MARK}</svg>
<p class="sp-title"><span class="sp-q">How “</span><span class="sp-name">${title}</span><span class="sp-q">” spread</span></p>
<nav class="sp-seg" aria-label="Design">${tabs}</nav>
<div class="sp-tools">${tools}</div>
</header>
<main id="spread"></main>
<script type="application/json" id="spread-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script src="${assets}/data.js${v}"></script>
<script src="${assets}/${data.design}.js${v}"></script>
</body>
</html>
`;
}
