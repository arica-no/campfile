// The spread page's header (src/spread-view.ts): Copy link, hidden until now since with no script there is nothing to press. The live region tells a screen reader what happened.
const said = Object.assign(document.createElement('p'), { className: 'sp-sr' });
said.setAttribute('role', 'status');
document.body.append(said);
for (const button of document.querySelectorAll('.sp-bar [data-copy]')) {
  button.hidden = false;
  const label = button.querySelector('.sp-label');
  const text = label.textContent;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
    } catch {
      window.prompt('Copy this', button.dataset.copy); // clipboard refused (permissions, old browser)
      return;
    }
    label.textContent = 'Copied';
    said.textContent = 'Copied';
    button.classList.add('done');
    setTimeout(() => {
      label.textContent = text;
      said.textContent = '';
      button.classList.remove('done');
    }, 2000);
  });
}

// A long title is cut by whole characters with "…" right against the closing quote: CSS text-overflow leaves up to a character's gap there.
// The shown title is then hidden from screen readers, which get the whole title instead. Without this script the CSS ellipsis still keeps the header one line.
const name = document.querySelector('.sp-name');
const whole = name.textContent;
const parts = Array.from(new Intl.Segmenter().segment(whole), (s) => s.segment);
const full = Object.assign(document.createElement('span'), { className: 'sp-sr', textContent: whole });
name.style.flexShrink = '0';
function fit() {
  const box = name.parentElement;
  full.remove();
  name.textContent = whole;
  const cut = box.scrollWidth > box.clientWidth;
  if (cut) {
    // The longest start of the title that fits with its "…".
    let lo = 0;
    let hi = parts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      name.textContent = `${parts.slice(0, mid).join('').trimEnd()}…`;
      if (box.scrollWidth > box.clientWidth) hi = mid - 1;
      else lo = mid;
    }
    name.textContent = `${parts.slice(0, lo).join('').trimEnd()}…`;
  }
  name.setAttribute('aria-hidden', String(cut)); // toggleAttribute would write aria-hidden="", which hides nothing
  if (cut) name.after(full);
}
fit();
addEventListener('resize', fit);
document.fonts.ready.then(fit);

// The owner's Back, shown when they came from the app's sheet (#from-sheet, shell.css): the page fades out and the browser goes back to that sheet, which shrinks its cover away (the app's public/takeover.js).
// Its href, the sheet's How it spread, is for when there is no page to go back to. Switching designs replaces this page in history and keeps #from-sheet, so Back still lands on the sheet.
if (location.hash === '#from-sheet') {
  document.querySelector('[data-back]').addEventListener('click', (e) => {
    if (history.length < 2) return;
    e.preventDefault();
    document.body.classList.add('leave');
    setTimeout(() => history.back(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160);
  });
  for (const link of document.querySelectorAll('.sp-seg a')) {
    link.addEventListener('click', (e) => {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      location.replace(`${link.href}#from-sheet`);
    });
  }
}
addEventListener('pageshow', (e) => {
  if (e.persisted) document.body.classList.remove('leave');
});
