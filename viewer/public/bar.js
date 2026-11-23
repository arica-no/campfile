// Every frame page loads this (src/viewer.ts).
// A visitor's bar is a title card at the top of the page and slims down once they scroll or touch it; only the page's own frame reports that (BAR_REPORTER).
const frame = document.querySelector('iframe');
const bar = document.querySelector('.bar');
addEventListener('message', (e) => {
  if (e.source === frame.contentWindow && (e.data === 'campfile:slim' || e.data === 'campfile:tall')) bar.classList.toggle('slim', e.data === 'campfile:slim');
});

// Full page hides the bar; the exit button brings it back. Focus follows, so a keyboard user is never left on a hidden button.
const enter = document.querySelector('[data-full]');
const exit = document.getElementById('full');
enter.addEventListener('click', () => {
  document.body.classList.add('full');
  exit.focus();
});
exit.addEventListener('click', () => {
  document.body.classList.remove('full');
  enter.focus();
});

// Older browsers, before invoker commands (Chrome 135, Firefox 144, Safari 26.2), open and close the signature's dialog here.
if (!('command' in HTMLButtonElement.prototype)) {
  for (const button of document.querySelectorAll('button[commandfor]')) {
    button.addEventListener('click', () => {
      const dialog = document.getElementById(button.getAttribute('commandfor'));
      if (button.getAttribute('command') === 'show-modal') dialog.showModal();
      else dialog.close();
    });
  }
}
// closedby="any" (a tap outside closes the dialog) is missing there too: a tap on the backdrop lands on the dialog itself, outside its box.
if (window.HTMLDialogElement && !('closedBy' in HTMLDialogElement.prototype)) {
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    dialog.addEventListener('click', (e) => {
      const r = dialog.getBoundingClientRect();
      if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close();
    });
  }
}

// Copy buttons (a reader's Copy your own link) copy their data-copy text, or the address as it is now when it's empty, instead of opening anything.
for (const button of document.querySelectorAll('[data-copy]')) {
  const label = button.querySelector('.label') ?? button;
  const text = label.textContent;
  const name = button.getAttribute('aria-label');
  const tip = button.dataset.tip;
  button.addEventListener('click', async () => {
    const url = button.dataset.copy || location.href;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this', url); // clipboard refused (permissions, old browser)
      return;
    }
    // The tooltip shows "Copied" on narrow screens too, where the label is hidden.
    label.textContent = 'Copied';
    if (tip) button.dataset.tip = 'Copied';
    button.setAttribute('aria-label', 'Copied');
    button.classList.add('copied');
    setTimeout(() => {
      label.textContent = text;
      if (tip) button.dataset.tip = tip;
      button.setAttribute('aria-label', name);
      button.classList.remove('copied');
    }, 2000);
  });
}

// A page that sees how it's shared (data-share, src/consent-banner.ts): the reader chooses. Allow makes a secret key for this page only; the server keeps its hash and answers with the reader's own link, which goes into the address bar so the link they copy is theirs.
const path = document.body.dataset.share && location.pathname.match(/^\/([A-Za-z0-9]{8})(?:-([A-Za-z0-9]{4}))?$/);
if (path) {
  const [, id, via = null] = path;
  const item = `campfile:share:${id}`;
  const SIX_MONTHS = 183 * 24 * 60 * 60 * 1000;
  const dialog = document.querySelector('.consent');
  const tool = document.querySelector('.consent-tool');
  const save = (value) => {
    try {
      localStorage.setItem(item, JSON.stringify({ ...value, at: Date.now() }));
      return true;
    } catch {
      return false;
    }
  };
  const choose = () => {
    dialog.returnValue = ''; // Esc keeps the last one
    dialog.showModal(); // focus lands on Allow (autofocus)
  };
  const forget = () => {
    try {
      localStorage.removeItem(item);
    } catch {}
  };
  const post = (action, body) =>
    fetch(`/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((response) => {
      if (!response.ok) throw new Error(`${action}: ${response.status}`);
      return response.json();
    });
  const own = (url) => {
    history.replaceState(history.state, '', url + location.hash);
    tool.hidden = false;
  };
  // Every arrive runs under one lock per page, shared by this browser's tabs, and reads the stored key inside it, so two tabs allowing at once keep one key
  // and an arrive never sends a key another tab has just forgotten. Without Web Locks, the same steps run unlocked.
  const locked = (f) => (navigator.locks ? navigator.locks.request(item, f) : f()).catch(() => {}); // offline or refused: the address stays as it was
  // Under the lock: only with the key stored right now; none (forgotten meanwhile) sends nothing.
  const arrive = async (email) => {
    const key = keyOf(read());
    if (!key) return;
    const { url, ask } = await post('arrive', email ? { via, key, email } : { via, key });
    if (url) own(url);
    else if (ask) {
      forget(); // an email page needs an email for a new entry
      choose();
    }
    // null at the cap: the key stays, so a later load tries again
  };
  // 22 base62 characters; bytes from 248 up are skipped so every character is equally likely.
  const newKey = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let key = '';
    while (key.length < 22) for (const byte of crypto.getRandomValues(new Uint8Array(32))) if (byte < 248 && key.length < 22) key += chars[byte % 62];
    return key;
  };

  // This page's item as stored now (undefined: storage blocked), and the key in it. Another tab of this page may have chosen since this one loaded.
  const read = () => {
    let stored;
    try {
      stored = localStorage.getItem(item);
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(stored);
    } catch {
      return null;
    }
  };
  const keyOf = (state) => (typeof state?.key === 'string' && /^[A-Za-z0-9]{22}$/.test(state.key) ? state.key : null);

  const state = read();
  if (state !== undefined) {
    if (keyOf(state)) locked(() => arrive());
    else if (!(state?.no && Date.now() - state.at < SIX_MONTHS)) choose();
  } // storage blocked: as No thanks, nothing shown or sent

  dialog.querySelector('.consent-no').addEventListener('click', () => dialog.close('no'));

  // A stored key is never replaced: it is the only way to that entry.
  // Allow closes the dialog with "allow"; No thanks, Esc and any other close are No thanks. Either way the reader is back on the page, ready to scroll it.
  dialog.addEventListener('close', () => {
    frame.focus();
    if (dialog.returnValue !== 'allow') {
      if (!keyOf(read())) save({ no: true }); // else another tab allowed, and that stands
      return;
    }
    const email = dialog.querySelector('[name=email]')?.value.trim();
    locked(async () => {
      // Another tab allowed first: its key, its entry. A key the browser can't keep would make a new entry on every load.
      if (!keyOf(read()) && !save({ key: newKey() })) return;
      await arrive(email);
    });
  });
}
