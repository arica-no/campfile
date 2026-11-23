// What the owner wall shows: `/my`, a group's own wall (`/my/groups/<id>`), and over the wall the remembered emails' side sheet (`/my/emails`). A page's own panel (`pageSheet`, below) is drawn over the page itself by src/page-view.ts.
// It renders what src/manage.ts loaded through src/wall.ts and src/groups.ts, and links and forms back to src/manage.ts's routes. Every action is a plain form POST, so no script is needed: public/manage.js only makes it smoother (and adds drag-and-drop and the Move dialog's search).
import { screenHeaders } from './connector.ts';
import { SETUP_PATH } from './hosted.ts';
import { escapeHtml as e, FAVICON_LINKS, LOGO_MARK } from './html.ts';
import type { Group } from './groups.ts';
import type { Access } from './pages.ts';
import { OPEN, publish, SAY } from './pitch.ts';
import { cardTier } from './preview.ts';
import type { Sharing } from './sharing.ts';
import type { SpreadCounts } from './spread-view.ts';
import { SCAN_CSS, WALL_CSS } from './wall-style.ts';
import { PAGE_KEY, SHELF_KEY, sortPages, sortShelves, sum, type Person, type Remembered, type Shelf, type Sort, type WallPage } from './wall.ts';

// Scripts only from our own origin (public/manage.js); forms and its background saves only to ourselves. src/page-view.ts adds the viewer as its one frame source.
export const WALL_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
// shortcut: the tick boxes show the latest 12 remembered emails and the list on its own sheet has no search; add a filter when owners remember hundreds.
const PICKS = 12;
const AUTOFOCUS = ' tabindex="-1" autofocus';

export type Show = 'all' | 'live' | 'drafts' | 'asking';
export const SHOWS: Record<Show, string> = { all: 'All', live: 'Published', drafts: 'Draft', asking: 'Asking' };
/** The labels of the wall's orders (src/wall.ts SORT_ORDERS), in the menu's order. One order for the whole wall, kept as the owner opens groups and searches. */
export const SORTS: Record<Sort, string> = { changed: 'Last changed', added: 'Date added', name: 'Name', visitors: 'Most visitors', people: 'Most people let in' };

/** The page panel's extra state: who is on the page, and after a failed form the message and what was typed (a title for Rename; the access, emails and name for Publish; the emails for Let them in). */
export interface PageSheet {
  page: WallPage;
  people: Person[];
  /** What the share tree adds up to, for the How it spread section. */
  spread?: SpreadCounts;
  error?: string;
  typed?: { title?: string; emails?: string; access?: string; sharing?: Sharing; name?: string };
}

/** A wall form that changed nothing (`POST /my/delete`, docs/SPEC.md "Deleting pages"; and the group forms): the wall comes back with the pages that still exist ticked again, and says why. */
export interface Refused {
  /** 404 when a ticked page was gone already, 400 for the rest. */
  status: number;
  /** The service's own message: shown as it is for a refusal that is neither of the two below (nothing ticked, too many, a group's name). */
  message: string;
  /** The ticked pages that still exist. */
  ticked: string[];
  /** How many of the ticked pages were gone already. */
  missing: number;
  /** The titles of the published ones that need the word typed. */
  published: string[];
}

export interface WallView {
  email: string;
  /** The viewer's origin: the public link of a page. */
  viewer: string;
  /** Every live page of the owner's, in every group. */
  pages: WallPage[];
  /** The owner's groups, last changed first. */
  groups: Group[];
  /** The group whose own wall this is (`/my/groups/<id>`); undefined on Your pages. */
  group?: Group;
  /** The owner's remembered emails, loaded where they are shown: the sheet, the tick boxes. Elsewhere only whether there are any matters. */
  book: Remembered[];
  show: Show;
  q: string;
  sort: Sort;
  /** The name the publish form asks for, prefilled (src/sharing.ts authorName), while the owner has never been asked; undefined after that. */
  name?: string;
  /** What the browser just did (`?done=` after an action): a word from `done()`; any other word shows nothing. */
  done?: string;
  /** How many pages `done=deleted-many` deleted, or a group action moved, kept or deleted (`?n=`): only digits make a count. */
  n?: string;
  /** What a group action's `done` is about: the group (`?g=`, an id, its name looked up), the one page moved (`?p=`, an id), the group's name before a rename or a delete (`?was=`, shown as typed). */
  g?: string;
  p?: string;
  was?: string;
  /** The remembered emails' sheet is open over the wall (`/my/emails`). */
  emails?: boolean;
  /** A delete that was refused (`POST /my/delete`). */
  refused?: Refused;
  /** The pass for the lone draft (src/manage.ts viewTicket), carried by its Delete form (deleteDialog). */
  ticket?: string;
  scan?: boolean;
}

/** What a page's panel takes from the wall's state: where its links go back to (`show`, `q`, `sort`), the viewer's address, the emails and name its forms offer, and what was just done. */
export type SheetView = Pick<WallView, 'viewer' | 'book' | 'name' | 'done' | 'show' | 'q' | 'sort' | 'scan'>;

// --- Words --------------------------------------------------------------------------------------------------

const nf = new Intl.NumberFormat('en-GB');
const plural = (n: number, one: string, many: string) => `${nf.format(n)} ${n === 1 ? one : many}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });

/** "just now", "20 min ago", "2 h ago", "yesterday", "5 days ago", "3 Oct". */
export function when(time: Date, now = Date.now()): string {
  const age = Math.max(0, now - time.getTime());
  if (age < 2 * MIN) return 'just now';
  if (age < HOUR) return `${Math.round(age / MIN)} min ago`;
  if (age < 20 * HOUR) return `${Math.round(age / HOUR)} h ago`;
  if (age < 2 * DAY) return 'yesterday';
  if (age < 7 * DAY) return `${Math.round(age / DAY)} days ago`;
  return dayMonth.format(time);
}

const ACCESS: Record<Access, { label: string; text: string }> = {
  link: { label: 'Anyone with the link', text: 'Whoever gets the link can open it, also when it is forwarded.' },
  approval: { label: 'Only people I approve', text: 'Visitors type their email to ask. You approve them here, then they can open it.' },
};
const lamp = (p: WallPage) => (!p.published ? '<span class="lamp draft">Draft</span>' : '<span class="lamp live">Published</span>');
export const who = (p: WallPage) => (!p.published ? 'Only you can open it' : p.access === 'approval' ? 'Only people you approve' : 'Anyone with the link');
/** Waiting people count for a published approval page only: the rows stay when a page switches or is unpublished. */
const asking = (p: WallPage) => (p.published && p.access === 'approval' ? p.waiting : 0);

/** The line after an action: what happened and, for Unpublish and a switch, the way back. HTML. Words that do not fit the page shown, or are unknown, give nothing. */
function outcome(word: string | undefined, p?: WallPage, n?: string): { text: string; undo?: { access: Access; sharing?: Sharing } } | undefined {
  const name = p && `“${e(p.title)}”`;
  const gate = p?.access === 'link' ? 'anyone with the link' : 'only people you approve';
  switch (word) {
    case 'published': return p && { text: `${name} is published. ${p.access === 'link' ? 'Anyone with the link can open it.' : 'Only people you approve can open it.'}` };
    // A switch to approval from a page that showed how it's shared names what it had (approval stored "off"), so Undo puts it back.
    case 'switched':
    case 'switched-links':
    case 'switched-emails':
      return p && { text: `Now ${gate} can open ${name}.`, undo: p.access === 'link' ? { access: 'approval' } : { access: 'link', sharing: word === 'switched' ? undefined : word === 'switched-links' ? 'links' : 'emails' } };
    case 'shared': return p && { text: { off: `You no longer see how ${name} is shared. Every link to it keeps working.`, links: `Readers of ${name} who allow it now get their own link, so you see how it’s shared.`, emails: `Readers of ${name} who allow it now get their own link and type an email.` }[p.sharing] };
    case 'unpublished': return p && { text: `${name} is a draft again. Only you can open it.`, undo: { access: p.access } };
    case 'letin': return p && { text: `Let in. They can open ${name} now.` };
    case 'approved': return p && { text: `They can open ${name} now.` };
    case 'denied': return p && { text: 'Told no. They can’t open it.' };
    case 'removed': return p && { text: 'Removed. They can’t open it any more.' };
    case 'renamed': return p && { text: `Renamed to ${name}.` };
    case 'spread-public': return p && { text: `Anyone with the link can now see how ${name} spread, with no names.` };
    case 'spread-private': return p && { text: `Only you can see how ${name} spread now.` };
    case 'deleted': return p ? undefined : { text: 'Page deleted.' };
    case 'deleted-many': return p ? undefined : { text: /^\d{1,4}$/.test(n ?? '') ? `${plural(Number(n), 'page', 'pages')} deleted.` : 'Pages deleted.' };
    case 'forgot': return p ? undefined : { text: 'Forgotten. That email is no longer suggested when you let people in.' };
  }
}

// --- Icons: 24-unit line drawings, shown at 18px ------------------------------------------------------------

const ICONS = {
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3a6.5 6.5 0 0 1 3.5 5.7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  publish: '<path d="M12 19V6M6 11l6-6 6 6"/>',
  unpublish: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.1 3.9M6.6 6.6A16.6 16.6 0 0 0 2.5 12S6 19 12 19a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5 12 13l8.5-6.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  forget: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 11h6"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
  down: '<path d="M5 9l7 7 7-7"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 10v6M9 13h6"/>',
  move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M10 13h6M13 10l3 3-3 3"/>',
  loose: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h5"/>',
};
const icon = (name: keyof typeof ICONS) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// --- The wall -----------------------------------------------------------------------------------------------

// ?v= is the screenshot's random key part: thumb.jpg is cached for a few minutes, and a switch or an edit takes a new one.
const thumb = (p: WallPage) => `/p/${p.id}/thumb.jpg?v=${e(p.thumb!.split('/').pop()!.slice(0, 8))}`;
/** A page's drawn card, laid out like the link preview's (src/preview.ts CARD_TIERS): its title over Campfile's mark, in CSS that scales with its box, so nothing is rendered on the server. */
const card = (p: WallPage) =>
  `<span class="dc" aria-hidden="true"><span class="dc-i c${cardTier(p.title.trim())}"><span class="dc-t"><span>${e(p.title.trim())}</span></span><span class="dc-m"><svg viewBox="4 3.5 24 24">${LOGO_MARK}</svg>Campfile</span></span></span>`;
/** A page's picture: its drawn card, under its screenshot when it has one (a draft has none, and a published page's may be on its way). */
const picture = (p: WallPage, lazy: boolean, extra = '') =>
  `<span class="pv">${card(p)}${p.thumb ? `<img src="${thumb(p)}" alt=""${lazy ? ' loading="lazy"' : ''}>` : ''}${extra}</span>`;

/** What a tile needs besides its page: the time, keep(), the order, and in a list across groups the groups' names, for each page's chip. */
interface Tiles {
  now: number;
  k: string;
  sort: Sort;
  names?: Map<string, string>;
}

/** A tile's last line: when it was added if that is the order, else when it changed. */
const whenLine = (t: Tiles, changed: Date, added: Date) => (t.sort === 'added' ? `Added ${when(added, t.now)}` : `Changed ${when(changed, t.now)}`);

function tile(p: WallPage, t: Tiles, checked: boolean): string {
  const n = asking(p);
  const group = p.group_id && t.names?.get(p.group_id);
  const people = t.sort === 'people' && PAGE_KEY.people(p);
  return `<li><a class="tile" id="tile-${p.id}" href="/p/${p.id}${t.k}">${picture(p, true, n ? `<span class="ask">${icon('people')}<span class="num">${n}</span> asking</span>` : '')}
<span class="tx"><span class="ti">${e(p.title)}</span><span class="st">${lamp(p)}<span>${who(p)}</span></span>
<span class="mt">${group ? `<span class="in">${icon('folder')}<span><span class="sr">In group </span>${e(group)}</span></span>` : ''}${people ? `<span class="num">${plural(people, 'person', 'people')} let in</span>` : ''}${p.published ? `<span class="num">${plural(p.week, 'visitor', 'visitors')} this week</span>` : ''}<span>${whenLine(t, p.updated_at, p.created_at)}</span></span></span></a>
<label class="sel" title="Select to move or delete"><input type="checkbox" name="id" value="${p.id}"${p.group_id ? ` data-group="${p.group_id}"` : ''}${p.published ? ' data-live' : ''}${checked ? ' checked' : ''}><span class="sr">Select “${e(p.title)}”</span></label></li>`;
}

/** "12 pages · 11 published · 1 asking": what a group holds, for its cover's caption. */
function groupLine(ps: WallPage[]): string {
  const live = ps.filter((p) => p.published).length;
  const ask = sum(ps, asking);
  // "·" ends a line, never starts one.
  return [ps.length ? plural(ps.length, 'page', 'pages') : 'Empty', live ? `${nf.format(live)} published` : '', ask ? `${nf.format(ask)} asking` : ''].filter(Boolean).join('\u00a0· ');
}

/** A group's cover (its folder on the wall, and the Move dialog): its newest three pages fanned, the newest on top and straight, each its screenshot or its drawn card. */
function fan(ps: WallPage[], cls = ''): string {
  const top = ps.slice(0, 3).reverse();
  if (!top.length) return `<span class="fan bare ${cls}" aria-hidden="true">${icon('folder')}</span>`;
  const sheets = top.map((p) => (p.thumb ? `<img src="${thumb(p)}" alt="" loading="lazy">` : card(p)));
  return `<span class="fan f${top.length} ${cls}" aria-hidden="true">${sheets.join('')}</span>`;
}

/** A group on the wall: one more tile, a folder with its newest pages fanned out of it, that opens the group's own wall (the order kept). Pages dragged onto it move in (public/manage.js). */
function groupTile(shelf: Shelf, t: Tiles): string {
  const { g, pages: ps } = shelf;
  const people = t.sort === 'people' && SHELF_KEY.people(shelf);
  const seen = t.sort === 'visitors' && SHELF_KEY.visitors(shelf);
  return `<li><a class="tile gtile" id="group-${g.id}" href="${e(listHref(`/my/groups/${g.id}`, 'all', '', t.sort))}" data-drop="${g.id}"><span class="pv gpv"><span class="fold" aria-hidden="true"><span class="fb"></span>${ps.length ? fan(ps) : ''}<span class="ff"></span></span></span>
<span class="tx"><span class="ti">${e(g.name)}</span><span class="st"><span class="gl">${icon('folder')}Group</span><span>${groupLine(ps)}</span></span>
<span class="mt">${people ? `<span class="num">${plural(people, 'person', 'people')} let in</span>` : ''}${seen ? `<span class="num">${plural(seen, 'visitor', 'visitors')} this week</span>` : ''}<span>${whenLine(t, g.changed_at, g.created_at)}</span></span></span></a></li>`;
}

// The product's own phrase stays on one line in the delete dialogs: a hyphen is a place to break, and "how-it-⏎spread" reads as a typo (public/manage.js words the wall's dialog the same way).
const HOW = '<span class="nw">how-it-spread</span>';

/** A published page is deleted only after "delete" is typed (docs/SPEC.md "Deleting pages"); the server checks it too. `required` is the panel's, where the page is known; the wall's script sets it as pages are ticked. public/manage.js checkWord words what the browser says about a wrong one. */
const typeDelete = (id: string, required: boolean) =>
  `<label class="label" for="${id}">Type <b>delete</b> to confirm</label><input class="input" id="${id}" name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false"${required ? ' required' : ''}>`;

/**
 * Delete's confirm dialog for one page, opened by a button with commandfor="delete": a draft with a plain Yes, a published page with "delete" typed too (docs/SPEC.md "Deleting pages"). `k` is keep().
 * `ticket` is the owner's 12-hour pass for this page and workspace (src/manage.ts viewTicket): sent back with the form, it tells the route that a delete of a page that is gone already (deleted in another tab) was the owner's own.
 */
const deleteDialog = (p: WallPage, k: string, ticket?: string) =>
  `<dialog class="dlg" id="delete" aria-labelledby="delete-h" closedby="any"><h2 id="delete-h">Delete “${e(p.title)}”?</h2>
<form method="post" action="/p/${p.id}/delete${k}" data-plain>${ticket ? `<input type="hidden" name="ticket" value="${e(ticket)}">` : ''}<div class="dlg-body">${p.published ? `<p>It is published: its link stops working for everyone. Its ${HOW} tree and people list go too. This can’t be undone.</p>` : `<p>Are you sure? Its ${HOW} tree and people list go too. This can’t be undone.</p>`}</div>${p.published ? typeDelete('delete-confirm', true) : ''}
<div class="row"><button class="btn ghost" type="button" commandfor="delete" command="close" autofocus>Cancel</button><button class="btn danger" type="submit">Yes, delete</button></div></form></dialog>`;

/**
 * The tiles in one form with the bar that shows once one is ticked, and its dialog: drafts only, a plain Yes; a published page among them, "delete" typed too.
 * Which of the dialog's lines shows follows the ticks (src/wall-style.ts); public/manage.js counts them, names the first few in the dialog and adds Select all (of the pages shown, when `filtered`).
 * The bar comes before the tiles in the document, so the keyboard meets it first, and is drawn below them (src/wall-style.ts).
 * autocomplete="off": a browser's restore of the boxes by position (Back, reload) could tick other pages than the owner did; a refused delete ticks them again from the server.
 */
// Enter on a tick box clicks the form's first submit button (Chrome skips disabled ones), so that is a harmless reload of the wall, not Yes, delete; manage.js opens the dialog instead (ticking the box in hand first, with other pages ticked or none) and says so to a screen reader.
// formnovalidate: else the required word, inside the closed dialog, stops the submit before manage.js sees it.
const picker = (tiles: string, v: WallView, shelves: Shelf[], filtered: boolean) => `<form id="pick" method="post" action="/my/delete${keep(v)}" autocomplete="off"><button type="submit" formmethod="get" formaction="${here(v)}" formnovalidate hidden></button>${v.group ? `<input type="hidden" name="from" value="${v.group.id}">` : ''}
<div class="selbar"><span class="num" id="picked" aria-live="polite">Pages selected</span><label class="ck" id="all-l" hidden><input type="checkbox" id="all"><span>${filtered ? 'Select all shown' : 'Select all'}</span></label><span class="sp"></span><span class="acts"><button class="btn ghost small" type="reset">Clear</button><button class="btn ghost small" type="button" commandfor="move" command="show-modal">${icon('move')} Move to…</button><button class="btn quiet link-danger small" type="button" commandfor="delete-many" command="show-modal">${icon('trash')} Delete</button></span></div>
<ul class="grid">${tiles}</ul>
${moveDialog(v, shelves, filtered)}
<dialog class="dlg" id="delete-many" aria-labelledby="dm-h" closedby="any"><h2 id="dm-h">Delete the selected pages?</h2>
<div class="dlg-body"><ul class="dm-list" id="dm-list" hidden></ul>
<p class="dm-drafts" id="dm-drafts">Are you sure? Their ${HOW} trees and people lists go too. This can’t be undone.</p>
<div class="dm-live"><p id="dm-live">Some of them are published: their links stop working for everyone. Their ${HOW} trees and people lists go too. This can’t be undone.</p></div></div>
<div class="dm-live">${typeDelete('dm-confirm', false)}</div>
<div class="row"><button class="btn ghost" type="button" commandfor="delete-many" command="close" autofocus>Cancel</button><button class="btn danger" type="submit">Yes, delete</button></div></dialog></form>`;

/** A group's name: required where the form is about the name alone. In the Move dialog it is never `required`, since it shares the tick form with Yes, delete: public/manage.js checks it on Move (the server checks it either way). */
const nameBox = (id: string, value: string, required: boolean) =>
  `<label class="label" for="${id}">Name</label><input class="input" id="${id}" name="name" maxlength="80" autocomplete="off" value="${e(value)}" placeholder="Bulk delete review"${required ? ' required' : ''}>`;

/**
 * Move to…: where the ticked pages go, inside the tick form, so its Move posts them (`POST /my/move`). Each group with its cover, "A new group" (named here), and "No group" (out of their group); the group they are all in is not offered.
 * Without the script the server cannot know the ticks: a group's own wall leaves out that group and offers No group, Your pages (pages in no group only) leaves out No group, and a list across groups offers everything.
 * public/manage.js decides by the ticks, words the heading, and past five groups adds Find a group. formnovalidate: the delete dialog's word, required once a published page is ticked, is not this form's business.
 */
function moveDialog(v: WallView, shelves: Shelf[], filtered: boolean): string {
  const own = filtered ? undefined : v.group?.id;
  const first = shelves.find((s) => s.g.id !== own);
  const choice = (value: string, body: string, checked: boolean, attrs = '') => `<label class="choice mv"${attrs}><input type="radio" name="to" value="${value}"${checked ? ' checked' : ''}>${body}</label>`;
  return `<dialog class="dlg" id="move" aria-labelledby="mv-h" closedby="any"><h2 id="mv-h">Move the selected pages to…</h2>
<div class="dlg-body"><div class="gfind" hidden><label class="sr" for="gq">Find a group</label>${icon('search')}<input class="input" id="gq" type="search" placeholder="Find a group" autocomplete="off"></div>
<div class="mvw"><div class="opts mvl" role="radiogroup" aria-labelledby="mv-h">
${shelves.map((s) => choice(s.g.id, `${fan(s.pages, 'mini')}<span class="ct"><b>${e(s.g.name)}</b><small>${groupLine(s.pages)}</small></span>`, s === first, ` data-name="${e(s.g.name.toLowerCase())}"${s.g.id === own ? ' hidden' : ''}`)).join('\n')}
<p class="mvn" aria-live="polite"></p>
${choice('new', `<span class="fan bare mini">${icon('folderPlus')}</span><span class="ct"><b>A new group</b><small>Name it below</small></span>`, !first)}
${choice('none', `<span class="fan bare mini">${icon('loose')}</span><span class="ct"><b>No group</b><small>Back onto Your pages</small></span>`, false, ` data-none${v.group || filtered ? '' : ' hidden'}`)}
</div><div class="newname">${nameBox('mv-name', '', false)}</div></div><p class="dlg-note err" aria-live="polite"></p></div>
<div class="row"><button class="btn ghost" type="button" commandfor="move" command="close">Cancel</button><button class="btn primary" type="submit" formaction="/my/move${keep(v)}" formnovalidate>Move</button></div></dialog>`;
}

/** New group, on Your pages: with pages ticked, public/manage.js sends them along and the button reads "Make and move". */
const newGroupDialog = (k: string) =>
  `<dialog class="dlg" id="new-group" aria-labelledby="ng-h" closedby="any"><h2 id="ng-h">New group</h2>
<form method="post" action="/my/groups${k}"><div class="dlg-body"><p id="ng-p">Put review rounds or the prototypes of one thing together.</p>${nameBox('ng-name', '', true)}<p class="dlg-note err" aria-live="polite"></p></div>
<div class="row"><button class="btn ghost" type="button" commandfor="new-group" command="close">Cancel</button><button class="btn primary" type="submit">Make group</button></div></form></dialog>`;

/** A group's own Rename and Delete group. Delete keeps its pages unless the owner picks "Delete its pages too": then a published one among them needs the word typed, as the wall's delete does (docs/SPEC.md "Deleting pages"); public/manage.js follows the choice in the button's words. */
function groupDialogs({ g, pages: ps }: Shelf, k: string): string {
  const live = ps.filter((p) => p.published).length;
  const all = plural(ps.length, 'page', 'pages');
  const one = ps.length === 1;
  const its = one ? 'its page' : `its ${ps.length} pages`;
  const which = !live ? '' : live === ps.length ? (one ? 'It is published: its link stops' : 'All are published: their links stop') : `${live} of them ${live === 1 ? 'is published: its link stops' : 'are published: their links stop'}`;
  const body = !ps.length
    ? '<p>It has no pages in it.</p>'
    : `<div class="opts"><label class="choice"><input type="radio" name="how" value="keep" checked><span class="ct"><b>Keep ${its}</b><small>${one ? 'It goes' : 'They go'} back onto Your pages, as ${one ? 'it is' : 'they are'}.</small></span></label>
<label class="choice"><input type="radio" name="how" value="delete"><span class="ct"><b>Delete ${its} too</b><small>${which ? `${which} working for everyone. ` : ''}${one ? `Its ${HOW} tree and people list go` : `Their ${HOW} trees and people lists go`} too. This can’t be undone.</small></span></label></div>
${live ? `<div class="typed">${typeDelete('dg-confirm', false)}</div>` : ''}${ps.map((p) => `<input type="hidden" name="page" value="${p.id}">`).join('')}`;
  return `<dialog class="dlg" id="rename-group" aria-labelledby="rg-h" closedby="any"><h2 id="rg-h">Rename group</h2>
<form method="post" action="/my/groups/${g.id}/rename${k}"><div class="dlg-body">${nameBox('rg-name', g.name, true)}<p class="dlg-note err" aria-live="polite"></p></div>
<div class="row"><button class="btn ghost" type="button" commandfor="rename-group" command="close">Cancel</button><button class="btn primary" type="submit">Save</button></div></form></dialog>
<dialog class="dlg" id="delete-group" aria-labelledby="dg-h" closedby="any"><h2 id="dg-h">Delete the group “${e(g.name)}”?</h2>
<form method="post" action="/my/groups/${g.id}/delete${k}" data-pages="${e(all)}"><div class="dlg-body">${body}<p class="dlg-note err" aria-live="polite"></p></div>
<div class="row"><button class="btn ghost" type="button" commandfor="delete-group" command="close" autofocus>Cancel</button><button class="btn danger" type="submit">Delete group</button></div></form></dialog>`;
}

const listHref = (base: string, show: Show, q: string, sort: Sort) => {
  const query = new URLSearchParams();
  if (show !== 'all') query.set('show', show);
  if (q.trim()) query.set('q', q.trim());
  if (sort !== 'changed') query.set('sort', sort);
  const text = query.toString();
  return text ? `${base}?${text}` : base;
};
/** The wall's filter, search and order as a query (`''` or `?show=…`), kept on every link and form of a page's panel and the wall's forms, so the owner lands back on the same wall. */
export const keep = (v: Pick<WallView, 'show' | 'q' | 'sort'>) => listHref('', v.show, v.q, v.sort);
/** The wall this is: Your pages, or a group's own. */
const here = (v: Pick<WallView, 'group'>) => (v.group ? `/my/groups/${v.group.id}` : '/my');

/** Emails to tick (the latest remembered ones, minus `skip`) above a box to type more. All are the form field `emails`. */
function emailBox(id: string, hint: string, book: Remembered[], typed = '', skip: ReadonlySet<string> = new Set()): string {
  const picks = book.filter((r) => !skip.has(r.email)).slice(0, PICKS);
  return `${picks.length ? `<fieldset class="picks"><legend>Pick from your remembered emails</legend><div>${picks.map((r) => `<label class="pick"><input type="checkbox" name="emails" value="${e(r.email)}"><span>${icon('check')}${e(r.email)}</span></label>`).join('')}</div></fieldset>` : ''}<textarea class="input" id="${id}" name="emails" rows="2" placeholder="name@example.com, omar@example.com"${hint ? ` aria-describedby="${hint}"` : ''}>${e(typed)}</textarea>`;
}

/**
 * See how it's shared, and under it Ask for their email, which shows once the first is ticked (src/wall-style.ts). For a link page only.
 * The hidden "off" tells the route these boxes were sent, so unticking both turns sharing off; Switch and Undo send no `sharing` and keep the page's.
 */
const shareBoxes = (sharing: Sharing) =>
  `<fieldset class="shr"><legend class="sr">How it’s shared</legend><input type="hidden" name="sharing" value="off">
<label class="ck"><input type="checkbox" name="sharing" value="links"${sharing === 'off' ? '' : ' checked'}><span class="ct"><b>See how it’s shared</b><small>Readers who allow it get their own link to pass on, so you see who brought whom.</small></span></label>
<label class="ck askmail"><input type="checkbox" name="sharing" value="emails"${sharing === 'emails' ? ' checked' : ''}><span class="ct"><b>Ask for their email</b><small>Readers who allow it type an email, shown as their name in your tree. Campfile doesn’t check it.</small></span></label></fieldset>`;

/** Publish: who can open it, with how it's shared under "Anyone with the link", and optionally who to let in right away (approval only: the box shows once that choice is ticked). `where` keeps the ids of the hero's and the sheet's copies apart; `k` is keep(). */
function publishForm(p: WallPage, where: 'hero' | 'sheet', book: Remembered[], name: string | undefined, typed: PageSheet['typed'] = {}, k = ''): string {
  const title = 'Who can open it once it’s published?';
  // A form that failed comes back with the access it sent, so the box that goes with it shows.
  const chosen: Access = typed.access === 'link' || typed.access === 'approval' ? typed.access : p.access;
  const choices = (['link', 'approval'] as const)
    .map((access) => {
      const radio = `<input type="radio" name="access" value="${access}"${chosen === access ? ' checked' : ''}><span class="ct"><b>${ACCESS[access].label}</b><small>${ACCESS[access].text}</small></span>`;
      // The link card holds the sharing boxes, which a label must not wrap: the radio gets its own label inside the card.
      return access === 'link' ? `<div class="choice lk"><label class="cl">${radio}</label>${shareBoxes(typed.sharing ?? p.sharing)}</div>` : `<label class="choice">${radio}</label>`;
    })
    .join('');
  return `<form class="pub" method="post" action="/p/${p.id}/publish${k}">
${where === 'hero' ? `<p class="label" id="pub-${where}">${title}</p>` : `<h3 id="pub-${where}">${title}</h3>`}
<div class="opts" role="radiogroup" aria-labelledby="pub-${where}">${choices}</div>
<div class="ef"><label class="label" for="emails-${where}">Let these people in right away</label><p class="hint" id="hint-${where}">Optional. They get an email, so they don’t have to ask.</p>${emailBox(`emails-${where}`, `hint-${where}`, book, typed.emails)}</div>
${nameField(where, name, typed.name)}
<div class="acts"><button class="btn primary" type="submit">${icon('publish')} Publish</button></div>
</form>`;
}

/** "Your name, shown to readers", asked once when sharing with anyone with the link: in a draft's Publish and a link page's sharing form. Nothing once asked (`name` undefined). */
const nameField = (where: string, name: string | undefined, typed: string | undefined) =>
  name === undefined
    ? ''
    : `<div class="nf"><label class="label" for="name-${where}">Your name, shown to readers</label><p class="hint" id="nhint-${where}">Readers see this instead of your email. We ask once.</p><input class="input" id="name-${where}" name="name" value="${e(typed ?? name)}" maxlength="80" autocomplete="name" aria-describedby="nhint-${where}"></div>`;

/** The only page, and a draft: it is the whole screen, with Publish on it and a quiet Delete. */
function hero(v: WallView, p: WallPage, now: number): string {
  return `<article class="hero">
<a class="hero-pv" id="tile-${p.id}" href="/p/${p.id}" aria-label="Open ${e(p.title)}">${picture(p, false)}</a>
<div class="hero-b"><div><h2>${e(p.title)}</h2><div class="st">${lamp(p)}<span>${who(p)}</span></div></div>
<p class="made">You put this on Campfile ${when(p.created_at, now)}. Check it, then publish it when you’re happy.</p>
${publishForm(p, 'hero', v.book, v.name)}
<div class="alt"><a class="btn ghost" href="/p/${p.id}">Open preview</a><a class="btn quiet" href="/p/${p.id}/manage">Details ${icon('right')}</a><button class="btn quiet link-danger" type="button" commandfor="delete" command="show-modal">${icon('trash')} Delete</button></div>
${deleteDialog(p, '', v.ticket)}</div></article>`;
}

/** The line after an action, or a failed form's message. `focus` puts the keyboard there, so a screen reader reads it. `k` is keep(). */
function statusLine(text: string, undo: { id: string; access: Access; sharing?: Sharing } | undefined, focus: boolean, k = ''): string {
  // Sharing as the boxes send it (src/manage.ts): "links" ticked, and "emails" too for that; none keeps the page's.
  const boxes = undo?.sharing ? `<input type="hidden" name="sharing" value="links">${undo.sharing === 'emails' ? '<input type="hidden" name="sharing" value="emails">' : ''}` : '';
  const way = undo ? `<form method="post" action="/p/${undo.id}/publish${k}"><input type="hidden" name="access" value="${undo.access}">${boxes}<button class="btn ghost small" type="submit">Undo</button></form>` : '';
  return `<div class="status" role="status"${focus ? AUTOFOCUS : ''}>${icon('check')}<span>${text}</span>${way}</div>`;
}

/** Why a delete deleted nothing, in the owner's words (docs/SPEC.md "Deleting pages"): text, to be escaped. `kept` is how many of the ticked pages are ticked on the wall again. */
function refusal(r: Refused, kept: number): string {
  if (r.missing) {
    const gone = r.ticked.length ? `${r.missing} of the pages you ticked ${r.missing === 1 ? 'was' : 'were'}` : r.missing === 1 ? 'The page you ticked was' : 'The pages you ticked were';
    return `${gone} already deleted, so nothing was deleted.${kept ? ` The ${kept === 1 ? 'other is' : 'others are'} still ticked.` : ''}`;
  }
  if (r.published.length) {
    const names = r.published.slice(0, 3).map((title) => `“${title}”`);
    const more = r.published.length - names.length;
    const list = more ? `${names.join(', ')} and ${more} more` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    const many = r.published.length > 1;
    return `Nothing was deleted. ${list} ${many ? 'are' : 'is'} published, so deleting ${many ? 'them' : 'it'} needs the word delete. Press Delete again and type it.`;
  }
  return r.message;
}

/** The line after a group action (`?done=`, with `g`, `p`, `n` and `was`; src/manage.ts): HTML. A group or page that is not the owner's, or gone, gives nothing. */
function groupSaid(v: WallView): string | undefined {
  const group = v.groups.find((g) => g.id === v.g);
  const name = group && `“${e(group.name)}”`;
  const was = v.was && `“${e(v.was)}”`;
  const n = /^\d{1,4}$/.test(v.n ?? '') ? Number(v.n) : 0;
  const page = v.p ? v.pages.find((p) => p.id === v.p) : undefined;
  const what = page ? `“${e(page.title)}”` : n ? plural(n, 'page', 'pages') : undefined;
  switch (v.done) {
    case 'group-made': return name && (n ? `Made the group ${name} and moved ${plural(n, 'page', 'pages')} into it.` : `Made the group ${name}. Tick pages and choose Move to put pages in it.`);
    case 'group-renamed': return name && was && `Renamed ${was} to ${name}.`;
    case 'group-deleted': return was && `Deleted the group ${was}.`;
    case 'group-deleted-kept': return was && n ? `Deleted the group ${was}. ${n === 1 ? 'Its page is' : `Its ${n} pages are`} back on Your pages.` : undefined;
    case 'group-deleted-all': return was && n ? `Deleted the group ${was} and ${n === 1 ? 'its page' : `its ${n} pages`}.` : undefined;
    case 'moved': return name && what && `Moved ${what} to ${name}.`;
    case 'moved-out': return what && `Moved ${what} out of ${name ?? 'their groups'}, onto Your pages.`;
  }
}

function wallMain(v: WallView, now: number): string {
  const { pages, groups } = v;
  const shelves: Shelf[] = groups.map((g) => ({ g, pages: pages.filter((p) => p.group_id === g.id) }));
  const own = v.group && shelves.find((s) => s.g.id === v.group!.id)!;
  const q = v.q.trim();
  const filtered = v.show !== 'all' || q !== '';
  const t: Tiles = { now, k: keep(v), sort: v.sort, names: filtered ? new Map(groups.map((g) => [g.id, g.name])) : undefined };
  const live = pages.filter((p) => p.published).length;
  const waiting = sum(pages, asking);
  const summary = own
    ? groupLine(own.pages)
    : pages.length || groups.length
      ? [plural(pages.length, 'page', 'pages'), groups.length ? plural(groups.length, 'group', 'groups') : '', live ? `${live} published` : 'none published', waiting ? `${plural(waiting, 'person', 'people')} asking` : ''].filter(Boolean).join(' · ')
      : 'No pages yet';
  // A filter or a word: one list across every group, each tile naming its group; with a word and All, the groups whose name has it come first.
  const shown = filtered ? sortPages(pages.filter((p) => (v.show === 'all' || (v.show === 'live' ? p.published : v.show === 'drafts' ? !p.published : asking(p) > 0)) && p.title.toLowerCase().includes(q.toLowerCase())), v.sort) : sortPages(own ? own.pages : pages.filter((p) => !p.group_id), v.sort);
  const found = filtered && q && v.show === 'all' ? sortShelves(shelves.filter((s) => s.g.name.toLowerCase().includes(q.toLowerCase())), v.sort) : [];
  const said = v.emails ? undefined : (outcome(v.done, undefined, v.n)?.text ?? groupSaid(v));
  const lone = !own && !groups.length && pages.length === 1 && !pages[0].published; // the whole screen, with no tick boxes
  // A filter or search that shows nothing says so. A filter says it in its chip's word (Asking is about people, so its sentence is different); after a delete it adds "left", so a delete never reads as a failed search. The strip above already says what was deleted, so on All a search says only that nothing else matches; under a chip the sentence is the chip's, with the word typed, with or without a delete, because the chip hides matches too. "Try another word" follows only a word that was typed.
  const deleted = v.done === 'deleted' || v.done === 'deleted-many';
  const about = q && ` matching “${e(q)}”`;
  const none = v.show === 'asking' ? `Nobody is asking to open a page${about} right now.` : `No ${SHOWS[v.show].toLowerCase()} pages${deleted ? ' left' : ''}${about}.`;
  const tryAgain = q && !deleted ? ' Try another word, or look at everything.' : '';
  const nothing = !q || v.show !== 'all'
    ? `<b>${none}</b>${tryAgain}`
    : deleted
      ? `<b>Nothing else matches “${e(q)}”.</b>`
      : `<b>No pages${groups.length ? ' or groups' : ''} match.</b>${tryAgain}`;
  const ticked = new Set(v.refused?.ticked);
  const base = here(v);
  const tools = `<div class="tools"><nav class="seg" aria-label="Show pages">${(Object.keys(SHOWS) as Show[]).map((show) => `<a href="${e(listHref(base, show, v.q, v.sort))}"${show === v.show ? ' aria-current="true"' : ''}>${SHOWS[show]}</a>`).join('')}</nav>
<div class="sortby"><button class="sbtn" id="sort" type="button" popovertarget="sort-menu"><span class="sk">Sort</span>${SORTS[v.sort]}${icon('down')}</button>
<div class="smenu" id="sort-menu" popover role="group" aria-label="Sort by">${(Object.keys(SORTS) as Sort[]).map((sort) => `<a href="${e(listHref(base, v.show, v.q, sort))}#sort"${sort === v.sort ? ' aria-current="true"' : ''}>${icon('check')}${SORTS[sort]}</a>`).join('')}</div></div>
<form class="find" role="search" method="get" action="${base}"><label class="sr" for="q">Search pages and groups by name</label><button type="submit" aria-label="Search">${icon('search')}</button><input class="input" id="q" name="q" type="search" placeholder="Search pages and groups" autocomplete="off" value="${e(v.q)}">${v.show === 'all' ? '' : `<input type="hidden" name="show" value="${v.show}">`}${v.sort === 'changed' ? '' : `<input type="hidden" name="sort" value="${v.sort}">`}</form></div>
${filtered ? `<p class="found num">${[found.length ? plural(found.length, 'group', 'groups') : '', `${shown.length} of ${plural(pages.length, 'page', 'pages')}`].filter(Boolean).join(' and ')} shown${groups.length ? ', from every group' : ''}</p>` : ''}`;
  const tiles = [...(filtered ? found : own ? [] : sortShelves(shelves, v.sort)).map((s) => groupTile(s, t)), ...shown.map((p) => tile(p, t, ticked.has(p.id)))];
  const stage = filtered
    ? tiles.length
      ? picker(tiles.join('\n'), v, shelves, true)
      : `<div class="empty"><p>${nothing}</p><a class="btn ghost" href="${e(listHref(base, 'all', '', v.sort))}">Show all</a></div>`
    : own
      ? tiles.length
        ? picker(tiles.join('\n'), v, shelves, false)
        : `<div class="empty"><p><b>No pages in this group yet.</b> On Your pages, tick pages and choose Move to, or drag a page onto this group’s tile.</p><a class="btn ghost" href="${e(listHref('/my', 'all', '', v.sort))}">Back to Your pages</a></div>`
      : !tiles.length
        ? `<section class="first"><h2>Put your first page on Campfile</h2>
<p class="muted">First time? <a href="${SETUP_PATH}">Add Campfile to your AI</a> (about 3 minutes). Then, in the chat where you made your page, tell your AI:</p>
<div class="paste"><code id="ask">${SAY}</code><button type="button" class="btn primary" data-copy="${SAY}" hidden>${icon('copy')} Copy</button></div>
<ol class="steps"><li>Your AI puts it on Campfile and gives you a link to your page, which only you can open until you publish it.</li><li>${OPEN.step}<p class="hint">${OPEN.hint}</p></li><li>${publish(v.viewer).step}<p class="hint">${publish(v.viewer).hint}</p></li></ol>
<p class="hint">Your pages show up here as soon as the first one exists.</p></section>`
        : lone
          ? hero(v, pages[0], now)
          : picker(tiles.join('\n'), v, shelves, false);
  // A group's own wall: "Your pages › its name", the way back up and a drop target to take pages out (public/manage.js), with Rename and Delete group.
  const head = own
    ? `<div class="top"><div><h1 class="trail" id="h1"><a class="up" href="${e(listHref('/my', 'all', '', v.sort))}" data-drop="none">Your pages</a>${icon('right')}<span>${e(own.g.name)}</span></h1><p class="sum num">${summary}</p></div>
<div class="gacts"><button class="btn ghost" type="button" commandfor="rename-group" command="show-modal">${icon('pencil')} Rename</button><button class="btn quiet link-danger" type="button" commandfor="delete-group" command="show-modal">${icon('trash')} Delete group</button></div>
${groupDialogs(own, t.k)}</div>`
    : `<div class="top"><div><h1 id="h1">Your pages</h1><p class="sum num">${summary}</p></div>
<div class="gacts">${pages.length || groups.length ? `<button class="btn ghost" type="button" commandfor="new-group" command="show-modal">${icon('folderPlus')} New group</button>` : ''}${pages.length || v.book.length ? `<a class="btn ghost" href="/my/emails${keep(v)}">${icon('people')} Remembered emails</a>` : ''}</div>
${pages.length || groups.length ? newGroupDialog(t.k) : ''}</div>`;
  return `<main class="wrap" data-at="${base}">
${head}
${v.refused ? `<p class="status bad" role="alert"${AUTOFOCUS}>${e(refusal(v.refused, lone ? 0 : shown.filter((p) => ticked.has(p.id)).length))}</p>` : said ? statusLine(said, undefined, true) : ''}
${!lone && pages.length + groups.length > 1 ? tools : ''}
${stage}
</main>`;
}

// --- The panel: one page ------------------------------------------------------------------------------------

function visits(p: WallPage, now: number): string {
  if (!p.published) return '<p class="hint">Visits start when you publish it.</p>';
  const labels = p.days.map((_, i) => (i === 6 ? 'Today' : weekday.format(now - (6 - i) * DAY)));
  const max = Math.max(1, ...p.days);
  return `<p class="vs num"><b>${nf.format(p.week)}</b> ${p.week === 1 ? 'visitor' : 'visitors'} this week. ${plural(p.total, 'visitor', 'visitors')} since you published it.</p>
<ol class="bars" aria-label="Visitors on each of the last 7 days">${p.days
    .map(
      (n, i) =>
        `<li><span class="n num" aria-hidden="true">${nf.format(n)}</span><span class="b" aria-hidden="true" style="height:${Math.max(2, Math.round((n / max) * 52))}px"></span><span class="d" aria-hidden="true">${labels[i]}</span><span class="sr">${labels[i]}: ${plural(n, 'visitor', 'visitors')}</span></li>`,
    )
    .join('')}</ol>`;
}

/** How it spread (docs/SPEC.md): what the tree adds up to, the owner's view of it on the viewer, and, for a published link page, the switch that lets anyone with the link see it with no names. One hint line while there is nothing to show. */
function spread(v: SheetView, s: PageSheet, k: string): string {
  const { page: p, spread: c } = s;
  const link = p.published && p.access === 'link';
  if (!c?.entries && p.sharing === 'off')
    return `<section class="sec" id="spread"><h3>How it spread</h3><p class="hint">${p.published && p.access === 'approval' ? 'Pages anyone with the link can open show how they spread.' : 'Turn on “See how it’s shared” to see who passes it on.'}</p></section>`;
  const shown = link && p.spread_public;
  const url = `${v.viewer}/${p.id}/spread`;
  return `<section class="sec" id="spread"><h3>How it spread</h3>
<p class="vs num">${c?.entries ? `<b>${nf.format(c.entries)}${c.capped ? '+' : ''}</b> ${c.entries === 1 && !c.capped ? 'person' : 'people'} · ${plural(c.levels, 'level', 'levels')} · ${plural(c.sparks, 'spark', 'sparks')}` : 'Nobody has opened it through a shared link yet.'}</p>
${shown ? `<p class="url">${e(url)}</p>` : ''}<div class="acts">${shown ? `<button type="button" class="btn primary" data-copy="${e(url)}" hidden>${icon('copy')} Copy link</button>` : ''}<a class="btn ghost" href="${e(`${v.viewer}/${p.id}/login?then=spread#from-sheet`)}" data-takeover="spread">See how it spread ${icon('right')}</a></div>${
    link
      ? `
<form class="shf spf" method="post" action="/p/${p.id}/spread${k}"><input type="hidden" name="public" value="0"><label class="ck"><input type="checkbox" name="public" value="1"${p.spread_public ? ' checked' : ''}><span class="ct"><b>Let anyone with the link see it</b><small>Shows how it spread with no names or emails. Good for posting.</small></span></label><button class="btn ghost small" type="submit">Save</button></form>`
      : ''
  }</section>`;
}

function people(v: SheetView, s: PageSheet, now: number): string {
  const { page: p } = s;
  const k = keep(v);
  const act = (x: Person, decision: string, label: string, style: string, mark = '') =>
    `<form method="post" action="/p/${p.id}/people/${x.id}${k}"><button class="btn ${style} small" type="submit" name="decision" value="${decision}" aria-label="${label} ${e(x.email)}">${mark}${label}</button></form>`;
  const group = (title: string, status: Person['status'], sub: string, buttons: (x: Person) => string) => {
    const list = s.people.filter((x) => x.status === status);
    return list.length
      ? `<div class="grp"><h4 class="gh">${title} · <span class="num">${list.length}</span></h4><ul>${list
          .map((x) => `<li class="pr"><div class="pi"><span class="em">${e(x.email)}</span><span class="sub">${sub} ${when(x.decided_at ?? x.created_at, now)}</span></div><div class="pa">${buttons(x)}</div></li>`)
          .join('')}</ul></div>`
      : '';
  };
  const skip = new Set(s.people.filter((x) => x.status === 'approved').map((x) => x.email));
  return `<section class="sec"><h3>People</h3>
${group('Waiting for you', 'waiting', 'Asked', (x) => act(x, 'approve', 'Approve', 'ghost', `${icon('check')} `) + act(x, 'deny', 'Say no', 'quiet'))}
${group('Can open it', 'approved', 'Let in', (x) => act(x, 'remove', 'Remove', 'quiet'))}
${group('Told no', 'denied', 'Told no', (x) => act(x, 'approve', 'Approve', 'ghost', `${icon('check')} `))}
${s.people.length ? '' : '<p class="hint">Nobody has asked yet. When someone does, they show up here first.</p>'}
<form class="more" method="post" action="/p/${p.id}/people${k}"><label class="label" for="more">Let more people in</label>${emailBox('more', '', v.book, s.typed?.emails, skip)}<div class="acts"><button class="btn ghost small" type="submit">${icon('mail')} Let them in</button></div></form></section>`;
}

/** Everything about one page, to go over the page itself (src/page-view.ts): its title and rename, state, who can open it, People, visits, how it spread, Unpublish and Delete. */
export function pageSheet(v: SheetView, s: PageSheet, now: number, ticket: string): string {
  const { page: p } = s;
  const url = `${v.viewer}/${p.id}`;
  const k = keep(v);
  const back = `/p/${p.id}${k}`;
  const renaming = s.typed?.title !== undefined;
  const said = s.error ? undefined : outcome(v.done, p);
  // One thing takes the keyboard on arrival: the message, the title being renamed, or the sheet's title.
  const status = s.error
    ? `<p class="status bad" role="alert" id="err"${renaming ? '' : AUTOFOCUS}>${e(s.error)}</p>`
    : said
      ? statusLine(said.text, said.undo && { id: p.id, ...said.undo }, true, k)
      : '';
  const titleFocus = s.error || said ? ' tabindex="-1"' : AUTOFOCUS;
  const other: Access = p.access === 'link' ? 'approval' : 'link';
  return `<div class="scrim"><a href="${back}" tabindex="-1" aria-hidden="true" data-close></a></div>
<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh">
<a class="btn icon x" href="${back}" aria-label="Close" data-close>${icon('x')}</a>
<div class="sbody"><div class="sb">
<div class="ttl"><h2 class="nm" id="sh"${titleFocus}>${e(p.title)}</h2>
<details class="rn"${renaming ? ' open' : ''}><summary class="btn quiet icon small" aria-label="Rename “${e(p.title)}”">${icon('pencil')}</summary>
<form class="rnf" method="post" action="/p/${p.id}/rename${k}"><label class="sr" for="title">Page title</label><input class="input" id="title" name="title" value="${e(s.typed?.title ?? p.title)}" maxlength="200" required autocomplete="off"${renaming ? ' autofocus aria-invalid="true" aria-describedby="err"' : ''}><div class="acts"><button class="btn primary small" type="submit">Save</button><a class="btn ghost small" href="/p/${p.id}/manage${k ? `${k}&` : '?'}done=cancel">Cancel</a></div></form></details></div>
${status}
<section class="sec"><div class="st">${lamp(p)}<span>${who(p)}</span></div>
<p class="hint">${p.published ? `Published ${when(p.published_at!, now)}. Changed ${when(p.updated_at, now)}.` : `Changed ${when(p.updated_at, now)}. Nobody else can see it until you publish.`}</p>
<p class="url" id="url">${e(url)}</p>
${p.published ? `<div class="acts"><button type="button" class="btn primary" data-copy="${e(url)}" hidden>${icon('copy')} Copy link</button></div>` : ''}</section>
${
  p.published
    ? `<section class="sec"><h3 id="who">Who can open it</h3>
<div class="opts" role="group" aria-labelledby="who">
<div class="choice on"><span class="ct"><b>${ACCESS[p.access].label}</b><small>${ACCESS[p.access].text}</small></span><span class="tag">Now</span>${
      p.access === 'link'
        ? `<form class="shf" method="post" action="/p/${p.id}/publish${k}"><input type="hidden" name="access" value="link">${shareBoxes(s.typed?.sharing ?? p.sharing)}${nameField('sheet', v.name, s.typed?.name)}<button class="btn ghost small" type="submit">Save</button></form>`
        : ''
    }</div>
<form method="post" action="/p/${p.id}/publish${k}"><button class="choice" type="submit" name="access" value="${other}"><span class="ct"><b>${ACCESS[other].label}</b><small>${ACCESS[other].text}</small></span><span class="tag">Switch to this</span></button></form>
</div></section>`
    : `<section class="sec">${publishForm(p, 'sheet', v.book, v.name, s.typed, k)}</section>`
}
${p.published && p.access === 'approval' ? people(v, s, now) : ''}
<section class="sec"><h3>Visits</h3>${visits(p, now)}</section>
${spread(v, s, k)}
</div></div>
<div class="sfoot">${p.published ? `<form method="post" action="/p/${p.id}/unpublish${k}"><button class="btn ghost" type="submit">${icon('unpublish')} Unpublish</button></form>` : ''}<button class="btn quiet link-danger" type="button" commandfor="delete" command="show-modal">${icon('trash')} Delete page</button></div>
${deleteDialog(p, k, ticket)}
</div>`;
}

// --- The sheet: remembered emails ---------------------------------------------------------------------------

function emailsSheet(v: WallView, now: number): string {
  const said = outcome(v.done);
  const k = keep(v);
  const rows = v.book
    .map(
      (r) => `<li class="bk"><div class="pi"><span class="em">${e(r.email)}</span><span class="sub">Last used ${when(r.used_at, now)}</span><span class="sub">${r.pages ? `Can open ${plural(r.pages, 'page', 'pages')}` : 'Can’t open any page right now'}</span></div>
<details class="fg"><summary class="btn ghost small" aria-label="Forget ${e(r.email)}">${icon('forget')} Forget</summary>
<form class="fgf" method="post" action="/my/emails/forget${k}"><input type="hidden" name="email" value="${e(r.email)}"><p>They won’t be suggested any more when you let people in.</p>${r.pages ? `<label class="check"><input type="checkbox" name="revoke" value="1" checked><span>Also take away their access to ${plural(r.pages, 'page', 'pages')}</span></label>` : ''}<div class="acts"><button class="btn danger small" type="submit" aria-label="Forget ${e(r.email)}">Forget</button></div></form></details></li>`,
    )
    .join('\n');
  return `<div class="scrim"><a href="${e(listHref('/my', v.show, v.q, v.sort))}" tabindex="-1" aria-hidden="true" data-close></a></div>
<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh">
<a class="btn icon x" href="${e(listHref('/my', v.show, v.q, v.sort))}" aria-label="Close" data-close>${icon('x')}</a>
<div class="sbody"><div class="sb">
<h2 class="nm" id="sh"${said ? ' tabindex="-1"' : AUTOFOCUS}>Remembered emails</h2>
<p class="muted">Emails you let in are remembered so you can pick them next time. Only you see this list.</p>
${said ? statusLine(said.text, undefined, true) : ''}
${v.book.length ? `<p class="hint bkn num">${plural(v.book.length, 'remembered email', 'remembered emails')}</p><ul>${rows}</ul>` : '<p class="hint bkn">Nobody is remembered yet. People you let in show up here.</p>'}
</div></div></div>`;
}

/** The whole screen: the wall, and over it the remembered emails' sheet if it is open. */
export function wallScreen(v: WallView): Response {
  const now = Date.now();
  const sheet = v.emails ? emailsSheet(v, now) : '';
  // The sheet slides in when it is opened from the wall, not when it reloads after an action.
  const enter = v.emails && !v.done;
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#16130f" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f7f5f2" media="(prefers-color-scheme: light)">
<meta name="robots" content="noindex">
${FAVICON_LINKS}
<title>${v.emails ? 'Remembered emails' : v.group ? `${e(v.group.name)} · Your pages` : 'Your pages'} · Campfile</title>
<style>${WALL_CSS}${v.scan ? SCAN_CSS : ''}</style>
<script src="/takeover.js"></script>
<script src="/manage.js" defer></script>
</head>
<body${enter ? ' class="enter"' : ''}${v.scan ? ' data-scan' : ''}>
<div id="wall"${sheet ? ' inert' : ''}>
<header class="appbar">
<a class="brand" href="/my"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#16130F"/>${LOGO_MARK}</svg>Campfile</a>
<div class="who"><span class="avatar" role="img" aria-label="Signed in as ${e(v.email)}">${e(Array.from(v.email)[0]?.toUpperCase() ?? '?')}</span><span class="mail">${e(v.email)}</span><a class="btn icon quiet" href="/signout" aria-label="Log out" title="Log out">${icon('logout')}</a></div>
</header>
${wallMain(v, now)}
</div>
${sheet}
</body>
</html>`;
  return new Response(body, { status: v.refused?.status ?? 200, headers: screenHeaders(WALL_CSP, new Headers({ 'Content-Type': 'text/html; charset=utf-8' })) });
}
