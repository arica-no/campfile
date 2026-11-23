// Coming back from the viewer to the panel you left from (public/manage.js data-takeover, the panel open over a page's view): the screen starts in the viewer's ember and shrinks back into the panel (src/wall-style.ts .returning).
// Loaded in <head> without defer, so the class is set before the first paint and the panel never flashes first. Back on that panel, its scroll and the link you pressed come back too.
const root = document.documentElement;

function back(left) {
  root.classList.remove('leaving');
  root.classList.add('returning');
  setTimeout(() => root.classList.remove('returning'), 600);
  const restore = () => {
    const body = document.querySelector('.sbody');
    if (body) body.scrollTop = left.top;
    document.querySelector(`[data-takeover="${left.link}"]`)?.focus({ preventScroll: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(restore), { once: true });
  else restore();
}

function left() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem('cf-left'));
    sessionStorage.removeItem('cf-left');
  } catch {} // storage off or garbled: no return transition
  return saved?.path === location.pathname ? saved : null;
}

const saved = left();
if (saved) back(saved);
// Restored from the back-forward cache: the page is still covered as it was left.
addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  const again = left();
  if (again) back(again);
  else root.classList.remove('leaving');
});
