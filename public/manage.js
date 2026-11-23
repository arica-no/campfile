// The owner screens' optional script (src/wall-view.ts, src/page-view.ts). Every action there is a plain link or form, so nothing here is needed to use them. This makes them smoother:
// on a page's view, Manage slides the panel over the page and Close slides it away, and nothing the panel does reloads the page in its frame: each action runs in the background and redraws only the panel and the bar;
// on both screens, Copy buttons, Esc to close, the keyboard back on the tile you came from, the panel's way out to the viewer, and the delete dialog in older browsers.

// Copy buttons are hidden until now: with no script there is nothing to press. The live region tells a screen reader what happened.
// One listener on the document, so the buttons a redraw brings in (below) work too.
const said = Object.assign(document.createElement('p'), { id: 'said', className: 'sr' });
said.setAttribute('role', 'status');
document.body.append(said);
const panel = document.getElementById('panel'); // a page's view has one (src/page-view.ts), the wall does not
const page = document.getElementById('page');
// "delete" as the server reads it (saysDelete in src/pages.ts): in any case, with spaces and punctuation around it ("Delete.") but not inside ("yes, delete", "d e l e t e", "delete 2") or asked or trailing off ("delete?", "delete…"). Without this the browser's own bubble would say "Please match the requested format".
const checkWord = (box) => box.setCustomValidity(!/[?\u00BF\u037E\u055E\u061F\u1367\u203D\u2047-\u2049\u2753\u2754\u2E2E\uFE16\uFE56\uFF1F\u2026\u2025\u22EF\uFE19\u22EE\u1801\u205D\u205E]|\uD83E\uDD14|[.,\u3002\uFF0E\uFF61\uFE52\u2024\u00B7\u30FB\uFF0C\u3001\u060C\u2022\uFF65\u2219\u2027\u22C5\uFF64\u06D4\u0964\u0965\u104A\u104B\u0589\u1803\u1362\u17D4\u2E31\u2236]\s*[.,\u3002\uFF0E\uFF61\uFE52\u2024\u00B7\u30FB\uFF0C\u3001\u060C\u2022\uFF65\u2219\u2027\u22C5\uFF64\u06D4\u0964\u0965\u104A\u104B\u0589\u1803\u1362\u17D4\u2E31\u2236]/.test(box.value) && box.value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === 'delete' ? '' : 'Type the word delete to confirm');
// The sharing boxes save as they change (below), so their Save buttons are for no script. New content gets the same, and the delete dialogs' word box its check.
const enhance = (root) => {
  for (const button of root.querySelectorAll('[data-copy]')) button.hidden = false;
  for (const form of root.querySelectorAll('form.shf')) form.querySelector('button[type="submit"]')?.remove();
  for (const box of root.querySelectorAll('input[name="confirm"]')) checkWord(box);
};
enhance(document);
document.addEventListener('input', (e) => e.target.matches('input[name="confirm"]') && checkWord(e.target));
// The typed word is for one opening of its dialog: Cancel or Esc, on the wall or in the panel, takes it back (`close` does not bubble, so this listens on the way down).
document.addEventListener('close', (e) => {
  const box = e.target.querySelector?.('input[name="confirm"]');
  if (box) { box.value = ''; checkWord(box); }
}, true);
document.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-copy]');
  if (!button || button.classList.contains('copied')) return; // already says Copied: the clipboard has it
  // The bar's Copy link has a .label, a tip and an aria-label; the panel's Copy link is an icon and a text node.
  const label = button.querySelector('.label') ?? [...button.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).pop();
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
  } catch {
    window.prompt('Copy this', button.dataset.copy); // clipboard refused (permissions, old browser)
    return;
  }
  const text = label.textContent;
  const { tip } = button.dataset;
  const name = button.getAttribute('aria-label');
  label.textContent = text.replace(/\S.*/, 'Copied'); // the space after the icon stays
  if (tip) button.dataset.tip = 'Copied'; // the tooltip says it where the label is hidden (phones)
  if (name) button.setAttribute('aria-label', 'Copied');
  button.classList.add('copied');
  said.textContent = 'Copied';
  setTimeout(() => {
    label.textContent = text;
    if (tip) button.dataset.tip = tip;
    if (name) button.setAttribute('aria-label', name);
    button.classList.remove('copied');
    said.textContent = '';
  }, 2000);
});

// --- The panel over a page ----------------------------------------------------------------------------------------
// Manage (or Publish) slides the panel in over the page; Close, Esc, a tap outside and the browser's Back slide it away. The page in its frame is never reloaded for it.
// The address follows (/p/ID/manage while it is open), so Back and Forward work and a reload comes back the same.
let opened = !!panel && !panel.hidden; // meant to be on screen: false from the moment it starts to slide away
let turn = 0; // counts opens and closes, so a slide-out that was overtaken stands down
let closing = Promise.resolve(); // the slide-out under way
// Marks the history entry this page pushed: Close goes back over it. After a reload the entry is another page's, and going back over it would load the page again: Close replaces the address instead.
const DOC = Math.random().toString(36).slice(2);
// An old message ("Now only people you approve can open it") does not greet the next opening.
const forget = () => panel.querySelector('.sb > .status')?.remove();
// Classic scrollbars (Windows, Linux) narrow the panel's body but not the sheet: --sbar, their width, keeps the pencil under Close (src/wall-style.ts).
const gutter = new ResizeObserver(([{ target }]) => panel.style.setProperty('--sbar', `${target.parentElement.offsetWidth - target.parentElement.clientWidth}px`));
const watchGutter = () => { gutter.disconnect(); gutter.observe(panel.querySelector('.sb')); };
if (panel) watchGutter();

// `href`, the panel's address, is pushed; from Back or Forward the address is already right.
function openPanel(href) {
  turn++;
  opened = true;
  panel.classList.remove('out');
  panel.classList.add('enter'); // slides in, as it does on arrival
  panel.hidden = false;
  page.inert = true;
  panel.querySelector('.sbody').scrollTop = 0;
  document.getElementById('sh').focus({ preventScroll: true });
  if (href) history.pushState({ panel: DOC }, '', href);
}
// `href`, the page's own address, replaces the panel's, unless this page pushed it: then it is gone back over.
function closePanel(href) {
  const mine = ++turn;
  for (const dialog of panel.querySelectorAll('dialog[open]')) dialog.close(); // Back over an open dialog: a modal left open would keep the page inert
  opened = false;
  panel.classList.add('out');
  if (href) {
    if (history.state?.panel === DOC) history.back();
    else history.replaceState(null, '', href);
  }
  // Nothing animates with reduced motion: it is gone at once. Only the slide-out itself is waited for: a transition inside it (a button's colour in a <details> just closed) may never settle.
  const sliding = [...panel.querySelectorAll(':scope > .scrim, :scope > .sheet')].flatMap((el) => el.getAnimations());
  closing = Promise.allSettled(sliding.map((animation) => animation.finished)).then(() => {
    if (turn !== mine) return; // opened again meanwhile
    panel.hidden = true;
    forget();
    page.inert = false;
    document.querySelector('[data-manage]')?.focus();
  });
}
addEventListener('popstate', () => {
  if (!panel) return;
  if (posting || queued) return drop(); // Back while a delete is on its way, or waits to be: show what the server has, not a dialog that no longer says it
  const want = location.pathname.endsWith('/manage');
  if (want && !opened) openPanel();
  else if (!want && opened) closePanel();
});
// The panel's own links lead to its address: they redraw it in place, as its forms do.
const toPanel = (a) => a.origin === location.origin && /^\/p\/[A-Za-z0-9]{8}\/manage$/.test(a.pathname);
// A form of the panel that is sent in the background; Delete's is not (it leaves the page, so it goes the plain way).
const background = (form) => panel?.contains(form) && form.method === 'post' && !form.hasAttribute('data-plain');
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (!panel || !link || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // a click that asks for a new tab goes as the browser wants
  if (link.matches('[data-manage]')) {
    e.preventDefault();
    if (!opened) openPanel(link.href);
  } else if (link.matches('[data-close]')) {
    e.preventDefault(); // also for the panel's links while it is shut: Esc clicks the first
    if (opened) closePanel(link.href);
  } else if (panel.contains(link) && toPanel(link)) {
    e.preventDefault(); // Cancel in Rename
    queue(() => send(link.href));
  }
});

// --- Background requests ------------------------------------------------------------------------------------------
// Every form of the panel (publish, switch, rename, approve, deny, remove, let in, spread, unpublish, undo) and its links to itself go in the background, one after another, in the order they were made,
// so a later one never lands under an earlier one's redraw. The sharing boxes (See how it's shared, Ask for their email, the name beside them, Let anyone with the link see it) also send as they change, and redraw
// nothing but how it spread: no jump, the box in use stays under the finger, and a note at the panel's foot says what happened. Their Save buttons are for no script.
const note = Object.assign(document.createElement('p'), { className: 'saved', ariaHidden: 'true' }); // the live region speaks it
let noteTimer;
let saves = Promise.resolve();
let pending = 0; // requests made and not answered yet
let unsent = 0; // of those, not sent yet: their turn has not come
let queued = false; // a delete pressed while they are on their way, waiting for them
// Loads the page again, to show what the server has: a delete still waiting is not sent, and saves on their way land anyway (keepalive). Only a save not sent yet would be lost, so only then does the browser ask first.
const drop = () => {
  queued = false;
  free(); // no late note and no hold over a screen on its way out
  pending = unsent;
  location.reload();
};
const queue = (job) => {
  pending++;
  unsent++;
  saves = saves
    .then(() => {
      unsent--;
      return job();
    })
    .catch(() => {}) // one failed redraw must not stop the requests after it
    .then(() => (pending = Math.max(0, pending - 1))); // plain() zeroed it
};
function submitForm(form, submitter) {
  const body = new URLSearchParams(new FormData(form, submitter)); // as it is now, and with the button pressed (Switch to this, Approve): the request may wait its turn
  submitter?.setAttribute('aria-busy', 'true'); // the click shows, and a second one does nothing
  queue(() => send(form.action, form, body).finally(() => submitter?.removeAttribute('aria-busy')));
}
document.addEventListener('submit', (e) => {
  if (!background(e.target)) return;
  e.preventDefault(); // also Enter in a box
  if (e.submitter?.ariaBusy !== 'true') submitForm(e.target, e.submitter);
});
document.addEventListener('change', (e) => {
  const form = e.target.closest('form.shf');
  if (form && background(form)) submitForm(form);
});
// Leaving while requests are still on their way would drop them: a link (Back, Log out, See how it spread, …) or another form waits for them, then goes. The panel's own links and forms only join the queue.
// Anything else that leaves (Back, a typed address) gets the browser's own "Leave site?".
document.addEventListener(
  'click',
  (e) => {
    const link = e.target.closest('a[href]');
    if (!pending || !link || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (panel && (link.matches('[data-manage],[data-close]') || (panel.contains(link) && toPanel(link)))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    saves.then(() => link.click());
  },
  true,
);
document.addEventListener(
  'submit',
  (e) => {
    if (!pending || background(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (queued) return; // pressed again: it is already waiting
    // Pressed, it is on its way: its dialog holds still from now, as while it posts (hold, below), and after 10 s the owner may close it, which stops it (drop).
    const dialog = e.submitter?.closest('dialog');
    if (dialog) {
      queued = true;
      e.submitter.setAttribute('aria-busy', 'true');
      timer = setTimeout(hold(dialog, e.submitter), 10_000);
    }
    saves.then(() => {
      if (dialog && !(queued && dialog.open)) return; // dropped meanwhile (Back, or closed after the note: its close event, and drop, may come after this)
      queued = false;
      free(); // the post holds it again, in the same task
      e.target.requestSubmit(e.submitter);
    });
  },
  true,
);
addEventListener('beforeunload', (e) => {
  if (pending) e.preventDefault();
});
// A plain post leaves the page: a second click would post again and answer for nothing (Delete twice says the page is gone), so it waits for the first, and its button shows it is on its way.
// A delete's dialog holds still meanwhile (hold): Cancel, Esc and a tap outside would close it, and the owner would think they had backed out of a delete that goes on.
// Coming back (Back) frees all of it, and so do 10 s with no answer (the browser's Stop sends no event), except a delete's dialog: its delete may still go through, so its button stays as it is, a line under the buttons says so, and only the ways to close it come back (late). Cancel reads Close then, and closing loads the page again, which shows what the server has by then.
let posting = false;
let posted = false; // a post left this screen, answered or not: Back must load it again
let timer;
let release = () => {}; // puts the held dialog back as it was
const free = () => {
  clearTimeout(timer);
  posting = false;
  document.querySelector('[aria-busy]')?.removeAttribute('aria-busy');
  release();
  release = () => {};
};
const stay = (e) => e.preventDefault();
// closedby="none" does it in Chrome, where a page can stop Esc only once (the second press closes the dialog anyway); the cancel event does it where closedby is missing, and the backdrop fallback at the foot of this file goes with the attribute.
function hold(dialog, button) {
  const cancel = dialog.querySelector('[command=close]');
  const note = Object.assign(document.createElement('p'), { className: 'dlg-note' }); // there from the start, so that a screen reader reads what it says later; empty, it takes no room
  note.setAttribute('role', 'status');
  const label = button.textContent;
  const word = dialog.querySelector('[name=confirm]');
  if (word) word.readOnly = true; // what was pressed is what goes: an edit now would only stop it, with the screen behind it no longer drawn
  const cancelLabel = cancel.textContent;
  button.style.width = `${button.offsetWidth}px`; // the row keeps its shape under the other word
  button.textContent = 'Deleting…';
  button.parentElement.after(note); // under the buttons: the line coming in moves nothing above it
  if (document.activeElement === cancel) button.focus(); // a disabled button cannot keep the keyboard
  const lock = (on) => {
    cancel.disabled = on;
    dialog.setAttribute('closedby', on ? 'none' : 'any');
    if (on) dialog.addEventListener('cancel', stay);
    else dialog.removeEventListener('cancel', stay);
  };
  lock(true);
  release = () => {
    lock(false);
    dialog.style.translate = '';
    delete dialog.dataset.lift;
    note.remove();
    cancel.textContent = cancelLabel;
    cancel.style.width = '';
    button.textContent = label;
    button.style.width = '';
    if (word) word.readOnly = false;
    dialog.removeEventListener('close', drop);
  };
  return () => {
    lock(false);
    // The browser keeps a dialog centred, so a line that grows it would lift it by half and drop the buttons from under the pointer: it goes back down to where its top was, as far as the screen has room, which stops 8px short of the screen's bottom, the gutter its cap keeps (src/wall-style.ts).
    // A dialog that already fills a short screen does not grow: its body (src/wall-style.ts .dlg-body, the list of titles first) gives up the room, in whole rows (fitList), and the buttons rise by the line's height.
    const was = dialog.getBoundingClientRect();
    note.textContent = queued ? 'Your last change is still on its way, and the delete waits for it: close this to stop the delete.' : 'No answer yet. The delete may still go through: close this to check.';
    fitList(dialog);
    const now = dialog.getBoundingClientRect();
    dialog.dataset.lift = String(Math.round(was.top) - Math.round(now.top)); // what it would take, in whole px as the layout paints its top (a fractional one lands a px off); the screen may allow less, now or after a turn (below)
    dialog.style.translate = `0 ${Math.max(0, Math.min(Number(dialog.dataset.lift), Math.floor(innerHeight - 8 - now.bottom)))}px`;
    cancel.style.width = `${cancel.offsetWidth}px`; // the row keeps its shape under the shorter word, as the delete button's does
    cancel.textContent = 'Close'; // not backing out: loading the page again drops the browser's request, but the server may already have the delete and may still do it
    dialog.addEventListener('close', drop, { once: true }); // the ticks, a typed word and this dialog no longer say what the server has
  };
}
document.addEventListener('submit', (e) => {
  if (e.defaultPrevented || (e.submitter?.formMethod || e.target.method) !== 'post') return;
  if (posting) return e.preventDefault();
  e.submitter?.setAttribute('aria-busy', 'true');
  posting = posted = true;
  // Only a delete's dialog holds still: a Move or a name that does not answer is only freed.
  const dialog = e.submitter?.matches('.danger') && e.submitter.closest('dialog');
  timer = setTimeout(dialog ? hold(dialog, e.submitter) : free, 10_000);
});
// Back or Forward can bring a screen back from the browser's memory as it was. After a post from it (a delete), pages may be gone: it loads again.
// A page's view or panel is as it was left unless the page is gone since (deleted on the wall, or through the connector) or the login is (signed out, here or in another tab): the server is asked, and a 404, or a redirect to the sign-in, loads it again, to show that, not a drawn page whose Publish leads to an error. Loading it again every time would take the owner back to the top of the page they were reading.
// Else ticks and an open dialog with a typed word start over, and the rest stays.
addEventListener('pageshow', (e) => {
  free();
  if (!e.persisted) return;
  if (posted) return location.reload();
  if (panel) fetch(location.pathname, { method: 'HEAD', cache: 'no-store', redirect: 'manual' }).then((res) => (res.status === 404 || res.type === 'opaqueredirect') && location.reload(), () => {}); // the redirect is not followed (the sign-in it leads to answers 200); offline: it stays as it was
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  if (!pick?.querySelector('.sel input:checked')) return;
  for (const box of pick.querySelectorAll('.sel input')) box.checked = false;
  pick.dispatchEvent(new Event('change'));
});
// The plain way: the browser goes there, or posts what was sent once more, and shows what comes of it. That is meant, so no "Leave site?".
function plain(url, body) {
  pending = 0;
  if (!body) return location.assign(url);
  const form = Object.assign(document.createElement('form'), { method: 'post', action: url });
  for (const [name, value] of body) form.append(Object.assign(document.createElement('input'), { type: 'hidden', name, value }));
  document.body.append(form);
  form.submit();
}
// `body` is a form's fields (a link has none), `form` the form they came from. The panel's own page comes back (/p/ID/manage…, or a 400 with the refused form's message), and redraws the panel and the bar;
// anything else (the login lapsed, the server failed) is the plain way, to be seen.
async function send(url, form, body) {
  let res;
  try {
    res = await fetch(url, { method: body ? 'POST' : 'GET', body, keepalive: true }); // keepalive: one on its way still lands if the page goes anyway
  } catch {
    return plain(url, body); // offline: the browser's own error shows
  }
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const refused = res.status === 400;
  if (!(refused || (res.ok && toPanel(new URL(res.url)))) || !doc.getElementById('panel')) return res.redirected ? plain(res.url) : plain(url, body);
  if (queued) return; // a delete waits for this answer, and its dialog stays up: the page goes anyway, and what comes of it is drawn from the server
  if (form?.matches('.shf') && !refused) keepInPlace(doc, form);
  else await redraw(doc, res.url, refused);
}

// The panel and the bar come back drawn from the answer. Nothing else on the page is touched, so its frame plays on.
async function redraw(doc, url, refused) {
  await closing; // not under a panel that is sliding away
  panel.classList.remove('enter');
  document.body.classList.remove('enter'); // the new sheet is already in place: it does not slide in again
  panel.replaceChildren(...doc.getElementById('panel').childNodes);
  watchGutter();
  const inBar = document.querySelector('header.bar').contains(document.activeElement);
  document.querySelector('header.bar').replaceWith(doc.querySelector('header.bar'));
  document.title = doc.title;
  document.querySelector('iframe.page').title = doc.querySelector('iframe.page').title; // a rename
  enhance(document);
  if (refused && !opened) openPanel(document.querySelector('[data-manage]').href); // closed while it was on its way: the message is for them
  if (!opened) {
    forget(); // the bar shows what changed; the message would only greet the next opening
    if (inBar) document.querySelector('[data-manage]')?.focus(); // the button the keyboard was on went with the old bar
    return;
  }
  if (!refused) history.replaceState(history.state, '', url); // a refusal stays at the form's own address
  const focus = panel.querySelector('[autofocus]'); // the message, or the title, as on arrival
  focus?.focus({ preventScroll: true });
  focus?.scrollIntoView({ block: 'nearest' }); // only as far as it takes: a focused message below a tall title would otherwise be scrolled to the middle
}

// How it spread follows the boxes (its address and Copy link, or one hint line). The box in use stays where it is under the finger: its own element is kept, and the panel scrolls by what moved above it.
function keepInPlace(doc, form) {
  const old = document.getElementById('spread');
  const next = doc.getElementById('spread');
  if (old && next) {
    const body = document.querySelector('.sbody');
    const top = form.getBoundingClientRect().top;
    const mine = old.querySelector(':scope > form.spf');
    const theirs = next.querySelector(':scope > form.spf');
    if (mine && theirs) {
      for (const node of [...old.childNodes]) if (node !== mine) node.remove();
      let after = false;
      for (const node of [...next.childNodes]) {
        if (node === theirs) after = true;
        else if (after) old.append(node);
        else mine.before(node);
      }
    } else {
      old.replaceWith(next);
    }
    enhance(document.getElementById('spread'));
    if (form.isConnected && body) body.scrollTop += form.getBoundingClientRect().top - top;
  }
  const text = doc.querySelector('.status > span')?.textContent || 'Saved.';
  said.textContent = text;
  note.textContent = text;
  if (!note.isConnected) {
    document.querySelector('.sfoot')?.append(note); // it floats just above the foot of the sheet
    note.getBoundingClientRect(); // laid out before .on, so it fades in
  }
  note.classList.add('on');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    note.classList.remove('on');
    said.textContent = '';
  }, 4000);
}

// The wall's tick boxes (src/wall-view.ts picker): the bar counts them, Select all ticks every page shown, and the dialog names what goes. A published page among them makes "delete" required.
// With no script the bar and the dialog work in general words, and the server checks the word.
const pick = document.getElementById('pick');
if (pick) {
  const boxes = [...pick.querySelectorAll('.sel input')];
  const all = document.getElementById('all');
  const word = document.getElementById('dm-confirm');
  const list = document.getElementById('dm-list');
  const title = (box) => box.closest('li').querySelector('.ti').textContent;
  const live = (box) => box.hasAttribute('data-live');
  // The product's own phrase stays on one line, as in the markup (HOW in src/wall-view.ts): a hyphen is a place to break.
  const nowrap = (text) => text.split(/(how-it-spread)/).map((part, i) => (i % 2 ? Object.assign(document.createElement('span'), { className: 'nw', textContent: part }) : part));
  const count = () => {
    const ticked = boxes.filter((box) => box.checked);
    const published = ticked.filter(live).length;
    document.getElementById('picked').textContent = `${ticked.length} selected`;
    document.getElementById('dm-h').textContent = ticked.length === 1 ? `Delete “${title(ticked[0])}”?` : `Delete ${ticked.length} pages?`;
    // From two on, the dialog names the first five (all six when there are six: "and 1 more" saves nothing), the published ones first and marked, so the owner can check them against what they meant and the word is about pages they can see.
    const named = [...ticked.filter(live), ...ticked.filter((box) => !live(box))].slice(0, ticked.length === 6 ? 6 : 5);
    list.replaceChildren(
      ...named.map((box) => {
        const item = document.createElement('li');
        if (live(box)) item.append(Object.assign(document.createElement('span'), { className: 'pb', textContent: 'Published' }), '\u2007'); // first, so it is on the row's first line, the one a short window always shows; a figure space (a digit wide), not a margin, so a screen reader hears two words, and one that does not break, so a long first word (a URL) wraps after the tag instead of leaving it alone on the line
        item.append(title(box));
        return item;
      }),
    );
    // Past five, published pages can be behind "and N more" too: it says how many, so the tags above and this line add up to the count below.
    const more = ticked.length - named.length;
    const moreLive = published - named.filter(live).length;
    if (more) list.append(Object.assign(document.createElement('li'), { className: 'dm-more', textContent: `and ${more} more${moreLive ? `, ${moreLive === more ? (more === 2 ? 'both' : 'all') : `${moreLive} of them`} published` : ''}` }));
    list.hidden = ticked.length < 2;
    const goes = ticked.length === 1 ? 'Its how-it-spread tree and people list go too.' : 'Their how-it-spread trees and people lists go too.';
    const which =
      ticked.length === 1 ? 'It is published: its link stops'
      : published === ticked.length ? `${published === 2 ? 'Both are' : `All ${published} are`} published: their links stop`
      : `${published} of them ${published === 1 ? 'is published: its link stops' : 'are published: their links stop'}`;
    document.getElementById('dm-drafts').replaceChildren(...nowrap(`Are you sure? ${goes} This can’t be undone.`));
    document.getElementById('dm-live').replaceChildren(...nowrap(`${which} working for everyone. ${goes} This can’t be undone.`));
    word.required = published > 0;
    word.disabled = published === 0; // a hidden box half-typed would block Yes, delete
    all.checked = ticked.length === boxes.length;
    all.indeterminate = ticked.length > 0 && !all.checked;
  };
  document.getElementById('all-l').hidden = boxes.length < 2;
  // Clear and Select all unticked leave every box unticked, also those the server ticked again after a refused delete (a reset would bring them back). The bar goes with the last tick, so the keyboard moves to the first one.
  const untick = () => {
    const keyboard = document.activeElement?.matches(':focus-visible'); // a click must not scroll the wall to the top
    for (const box of boxes) box.checked = false;
    count();
    boxes[0].focus({ preventScroll: !keyboard });
  };
  all.addEventListener('change', () => (all.checked ? boxes.forEach((box) => (box.checked = true)) : untick()));
  pick.addEventListener('reset', (e) => (e.preventDefault(), untick()));
  // Enter anywhere in the form submits through its first button (src/wall-view.ts picker): ask instead. On a box that is not ticked, Enter ticks it first, as Space does, so the dialog is about the page in hand, with other pages ticked or none.
  // In the word box it means Yes, delete.
  const dialog = document.getElementById('delete-many');
  const stop = pick.querySelector('[formmethod=get]');
  pick.addEventListener('submit', (e) => {
    if (e.submitter !== stop) return;
    e.preventDefault();
    const focused = document.activeElement;
    if (boxes.includes(focused) && !focused.checked) focused.click();
    if (boxes.some((box) => box.checked)) dialog.showModal(); // Enter on Select all, with nothing ticked, has nothing to delete
  });
  word.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), pick.requestSubmit(dialog.querySelector('[type=submit]'))));
  pick.addEventListener('change', count);
  // Enter on a tick is the quick way to Delete, which comes before the grid: a keyboard user's tick says so (with no script it only reloads the wall, so no hint there).
  const hint = Object.assign(document.createElement('span'), { id: 'pick-hint', className: 'sr', textContent: 'Press Enter to delete this page and any other ticked pages.' });
  pick.append(hint);
  for (const box of boxes) box.setAttribute('aria-describedby', hint.id);
  // With a page ticked, a tap on a tile ticks or unticks it, as opening it would lose the ticks. A click that asks for a new tab or window goes as the browser wants.
  pick.addEventListener('click', (e) => {
    const tile = e.target.closest('a.tile:not(.gtile)'); // a group's tile opens it, ticks or not
    if (!tile || e.detail === 0 || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !boxes.some((box) => box.checked)) return; // Enter (detail 0) opens the page as a link does
    e.preventDefault();
    tile.closest('li').querySelector('.sel input').click();
  });
  count();

  // Move to… (src/wall-view.ts moveDialog): the ticks decide what it offers. The group they are all in is not offered, No group only when one of them is in a group; past five groups, Find a group.
  const move = document.getElementById('move');
  const choices = [...move.querySelectorAll('.choice[data-name]')];
  const fresh = move.querySelector('input[value=new]');
  const none = move.querySelector('[data-none]');
  const find = move.querySelector('.gfind');
  const search = document.getElementById('gq');
  const nothing = move.querySelector('.mvn');
  const named = document.getElementById('mv-name');
  let only;
  // Shows the groups whose name has `q`, and picks the first, so Enter moves there; with no match "A new group" is picked, the word as its name.
  const narrow = (q) => {
    const shown = choices.filter((c) => !(c.hidden = c.querySelector('input').value === only || !c.dataset.name.includes(q.toLowerCase())));
    // Read out too (aria-live), so Enter never makes a group nobody heard about.
    nothing.replaceChildren(...(q && !shown.length ? [`No group called “${q}”.`, Object.assign(document.createElement('span'), { className: 'sr', textContent: ` Move makes a new group “${q}”.` })] : []));
    (shown[0]?.querySelector('input') ?? fresh).checked = true;
    if (q && !shown.length) named.value = q;
    return shown.length;
  };
  // The list's scrollbar sits outside the column, so the cards line up with the search box and the Name box (src/wall-style.ts .mvl).
  const mvl = move.querySelector('.mvl');
  move.addEventListener('toggle', (e) => e.newState === 'open' && move.style.setProperty('--sb', `${mvl.offsetWidth - mvl.clientWidth}px`));
  pick.querySelector('[commandfor=move]').addEventListener('click', () => {
    const ticked = boxes.filter((box) => box.checked);
    const from = new Set(ticked.map((box) => box.dataset.group ?? ''));
    only = from.size === 1 ? [...from][0] : undefined;
    none.hidden = !ticked.some((box) => box.dataset.group);
    document.getElementById('mv-h').textContent = ticked.length === 1 ? `Move “${title(ticked[0])}” to…` : `Move ${ticked.length} pages to…`;
    search.value = named.value = move.querySelector('.dlg-note').textContent = '';
    named.removeAttribute('aria-invalid');
    find.hidden = narrow('') <= 5;
  });
  search.addEventListener('input', () => narrow(search.value.trim()));
  // Enter in the dialog (its search, the new group's name, a choice) means Move, not the form's first button: a submit inside a submit event would be ignored.
  move.addEventListener('keydown', (e) => e.key === 'Enter' && e.target.matches('input') && (e.preventDefault(), pick.requestSubmit(move.querySelector('[type=submit]'))));
  pick.addEventListener('submit', (e) => {
    if (e.submitter?.closest('dialog') === move && fresh.checked && !nameOk(move, named)) e.preventDefault();
  });
}

// A group's name, checked as the server will (src/groups.ts): none, or one of the owner's other groups' (the Move dialog lists them all). `own` is its name now, for Rename.
function nameOk(dialog, box, own = '') {
  const name = box.value.trim().toLowerCase();
  const taken = [...document.querySelectorAll('#move [data-name]')].find((c) => c.dataset.name === name && name !== own);
  const bad = !name ? 'Give the group a name.' : taken ? `You already have a group called “${taken.querySelector('.ct b').textContent}”. Choose another name, or use that group.` : ''; // the server's sentence (src/groups.ts)
  box.setAttribute('aria-invalid', String(!!bad));
  dialog.querySelector('.dlg-note').textContent = bad;
  if (bad) box.focus();
  return !bad;
}
// New group and Rename say what is wrong with a name in their own words, not the browser's, and open fresh every time: Rename with the current name, selected so typing replaces it.
for (const [id, box] of [['new-group', 'ng-name'], ['rename-group', 'rg-name']]) {
  const dialog = document.getElementById(id);
  if (!dialog) continue;
  const form = dialog.querySelector('form');
  const input = document.getElementById(box);
  form.noValidate = true;
  form.addEventListener('submit', (e) => {
    if (id === 'rename-group' && input.value.trim() === input.defaultValue) {
      e.preventDefault(); // saved as it was: nothing to post
      dialog.close();
    } else if (!nameOk(dialog, input, id === 'rename-group' ? input.defaultValue.toLowerCase() : '')) e.preventDefault();
  });
  dialog.addEventListener('close', () => {
    form.reset();
    input.removeAttribute('aria-invalid');
    dialog.querySelector('.dlg-note').textContent = '';
  });
  if (id === 'rename-group') dialog.addEventListener('toggle', (e) => e.newState === 'open' && input.select());
}
// New group with pages ticked: they go into it.
document.querySelector('[commandfor=new-group]')?.addEventListener('click', () => {
  const dialog = document.getElementById('new-group');
  const form = dialog.querySelector('form');
  const ticked = pick ? [...pick.querySelectorAll('.sel input:checked')] : [];
  form.querySelectorAll('input[name=id]').forEach((input) => input.remove());
  form.append(...ticked.map((box) => Object.assign(document.createElement('input'), { type: 'hidden', name: 'id', value: box.value })));
  document.getElementById('ng-p').textContent = ticked.length ? `The ${ticked.length === 1 ? 'page' : `${ticked.length} pages`} you ticked go${ticked.length === 1 ? 'es' : ''} into it.` : 'Put review rounds or the prototypes of one thing together.';
  form.querySelector('[type=submit]').textContent = ticked.length ? 'Make and move' : 'Make group';
});
// Delete group: the word is asked only with "Delete its pages too", and the button says what goes.
const dropGroup = document.getElementById('delete-group');
if (dropGroup) {
  const form = dropGroup.querySelector('form');
  const word = document.getElementById('dg-confirm');
  const follow = () => {
    const all = form.querySelector('input[name=how]:checked')?.value === 'delete';
    if (word) word.disabled = !(word.required = all);
    form.querySelector('[type=submit]').textContent = all ? `Delete group and ${form.dataset.pages}` : 'Delete group';
  };
  form.addEventListener('change', follow);
  dropGroup.addEventListener('close', () => { form.reset(); follow(); });
  follow();
}

// Drag a page (or every ticked page, when it is one of them) onto a group's tile to move it there, or onto "Your pages" above a group's wall to take it out (data-drop: a group's id, or "none").
let dragged = [];
document.addEventListener('dragstart', (e) => {
  const tile = e.target.closest?.('#pick a.tile:not(.gtile)');
  if (!tile) return;
  const own = tile.closest('li').querySelector('.sel input');
  const ticked = [...pick.querySelectorAll('.sel input:checked')];
  dragged = ticked.includes(own) ? ticked : [own];
  e.dataTransfer.effectAllowed = 'move';
  document.body.classList.add('dragging');
});
const over = (target) => document.querySelectorAll('.over').forEach((x) => x !== target && x.classList.remove('over'));
document.addEventListener('dragend', () => {
  dragged = [];
  document.body.classList.remove('dragging');
  over();
});
document.addEventListener('dragover', (e) => {
  const target = dragged.length ? e.target.closest?.('[data-drop]') : null;
  over(target);
  if (!target) return;
  e.preventDefault();
  target.classList.add('over');
});
document.addEventListener('drop', (e) => {
  const target = dragged.length ? e.target.closest?.('[data-drop]') : null;
  if (!target) return;
  e.preventDefault();
  const to = target.dataset.drop;
  const ids = dragged.filter((box) => (box.dataset.group ?? 'none') !== to).map((box) => box.value);
  if (!ids.length || posting) return; // a delete or move on its way: one post at a time, as the submit guard above does
  posting = posted = true;
  const from = pick.querySelector('[name=from]')?.value;
  plain(`/my/move${location.search}`, [['to', to], ...ids.map((id) => ['id', id]), ...(from ? [['from', from]] : [])]);
});

// After an action a reload must not say it again, nor post it again (a refused one is the answer to the POST at its own address, /my/delete, /my/move, /p/ID/delete…): the address becomes the wall's (main data-at) or the panel's own, and the page stays as it is.
const refusedPanel = location.pathname.match(/^\/p\/([^/]+)\/delete$/);
const wallAt = document.querySelector('main[data-at]')?.dataset.at;
if (refusedPanel) {
  history.replaceState(history.state, '', `/p/${refusedPanel[1]}/manage${location.search}`);
} else if (wallAt && !document.querySelector('.sheet') && (location.pathname !== wallAt || location.search.includes('done='))) {
  const query = new URLSearchParams(location.search);
  for (const key of ['done', 'n', 'g', 'p', 'was']) query.delete(key);
  const rest = query.toString();
  history.replaceState(history.state, '', `${wallAt}${rest && `?${rest}`}`);
}

// Esc closes the panel, or the wall's sheet. An open delete dialog takes the key first (it is still open while the key is handled).
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('dialog[open]')) document.querySelector('a[data-close]')?.click();
});

// Back from a page's view to /my#tile-ID: the browser scrolls to the tile, the keyboard goes there too.
if (location.hash.startsWith('#tile-') && !document.querySelector('.sheet')) document.getElementById(location.hash.slice(1))?.focus();

// The panel's link to the viewer (See how it spread) opens in this tab: the panel grows over the screen in the viewer's ember (src/wall-style.ts .leaving), then the browser goes.
// public/takeover.js plays it backwards when you come back, to the panel open. A click that asks for a new tab or window goes as the browser wants. One listener, so links a redraw brings in work too.
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-takeover]');
  if (!link || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  try {
    sessionStorage.setItem('cf-left', JSON.stringify({ path: location.pathname, top: document.querySelector('.sbody')?.scrollTop ?? 0, link: link.dataset.takeover }));
  } catch {} // storage off: no return transition, the rest still works
  document.documentElement.classList.add('leaving');
  setTimeout(() => location.assign(link.href), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300);
});

// Older browsers, before invoker commands (Chrome 135, Firefox 144, Safari 26.2), open and close the delete dialog here. One listener, as the dialog comes back with every redraw.
if (!('command' in HTMLButtonElement.prototype)) {
  document.addEventListener('click', (e) => {
    const button = e.target.closest('button[commandfor]');
    if (!button) return;
    const dialog = document.getElementById(button.getAttribute('commandfor'));
    if (button.getAttribute('command') === 'show-modal') dialog.showModal();
    else dialog.close();
  });
}
// closedby="any" (a tap outside closes the dialog) is missing there too: a tap on the backdrop lands on the dialog itself, outside its box.
if (window.HTMLDialogElement && !('closedBy' in HTMLDialogElement.prototype)) {
  document.addEventListener('click', (e) => {
    const dialog = e.target;
    if (!dialog.matches('dialog[closedby="any"]')) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
}
// A dialog taller than the screen (a long list of long titles on a phone) opens scrolled to its focus, Cancel, past the heading that says what it is for: whichever way it was opened, it starts at the top, its list of titles too, and the list is fitted to the room (fitList).
// The open attribute is set before the dialog takes focus and the observer runs after, and it also sees the dialogs a redraw brings in.
new MutationObserver((records) => {
  for (const { target } of records) {
    if (!target.open || !target.matches('dialog')) continue;
    target.scrollTop = 0;
    target.querySelector('.dm-list')?.scrollTo(0, 0); // a refit keeps the list's place (fitList), so only an opening starts it over
    fitList(target);
  }
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
addEventListener('resize', () =>
  document.querySelectorAll('dialog[open]').forEach((dialog) => {
    fitList(dialog);
    // The late note's offset (hold) keeps the buttons where they were: on each new screen it is the first one again, as far as the 8px gutter at the bottom allows, so a turn there and back puts them back.
    const lift = Number(dialog.dataset.lift);
    if (!lift) return;
    const bottom = dialog.getBoundingClientRect().bottom - (parseFloat(dialog.style.translate.split(' ')[1]) || 0);
    dialog.style.translate = `0 ${Math.max(0, Math.min(lift, Math.floor(innerHeight - 8 - bottom)))}px`;
  }),
); // a phone turned over
// The list of titles in the delete dialog gets the room the dialog has left (src/wall-style.ts .dlg-body), and on a short screen (a phone held sideways) that room can end in the middle of a row: a sliver of letter tops, or a hairline with nothing under it.
// Its window is cut down to the rows that fit whole. A few px short is not worth a scroll: the gap under the list gives them up (down to 4px) and the list shows whole. A first row taller than the room (a title of three lines) shows as many whole lines as fit, down to one.
function fitList(dialog) {
  const list = dialog.querySelector('.dm-list');
  if (!list || list.hidden || !dialog.open) return;
  const was = list.scrollTop; // a refit keeps the owner's place in the list
  list.style.minHeight = list.style.maxHeight = list.style.marginBottom = list.style.overflow = ''; // from what the CSS gives it
  list.scrollTop = 0;
  const over = list.scrollHeight - list.clientHeight;
  if (over <= 0) return;
  const style = getComputedStyle(list);
  const gap = parseFloat(style.marginBottom);
  if (over < gap - 4) {
    list.style.marginBottom = `${gap - over - 1}px`; // 1 more, for the rounding of the two heights
    list.style.overflow = 'hidden'; // and what the rounding still leaves is no scrollbar
    return;
  }
  const top = list.getBoundingClientRect().top;
  const room = list.getBoundingClientRect().height;
  let fit = 0;
  for (const row of list.children) {
    const end = row.getBoundingClientRect().bottom - top;
    if (end > room) break;
    fit = end;
  }
  const line = parseFloat(style.lineHeight);
  const shown = fit || Math.max(1, Math.floor(room / line)) * line;
  list.style.minHeight = list.style.maxHeight = `${shown}px`; // the CSS's one-row floor would show the next row's hairline, or a line's top
  list.scrollTop = was;
}
