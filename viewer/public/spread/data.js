// How it spread: turns the page's share tree (the JSON in #spread-data, written by the viewer's GET /:id/spread) into SHARE,
// the one object both designs (ember.js, cascade.js) read. Same shape as the round 6 prototypes' data.js.
// #spread-data: {mode: 'owner'|'public', design, title, author, published, now, tree: {entries, capped, brought, children}};
// each entry {label, ai, first_opened, brought, reached, children}. In public mode the viewer has already set every label to null.
const SHARE = (() => {
  const data = JSON.parse(document.getElementById('spread-data').textContent);
  const DAY = 864e5;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const utcDay = (iso) => Math.floor(Date.parse(iso) / DAY);

  const flat = [];
  const walk = (list, parent, depth) => {
    for (const e of list) {
      Object.assign(e, { parent, depth });
      flat.push(e);
      walk(e.children, e, depth + 1);
    }
  };
  walk(data.tree.children, null, 1);
  flat.sort((a, b) => a.first_opened.localeCompare(b.first_opened));
  flat.forEach((e, i) => (e.id = i));

  // Day 0 is the publish day, or the first entry's day when entries predate a later publish (a page published again).
  const start = Math.min(utcDay(data.published), ...flat.map((e) => utcDay(e.first_opened)));
  const day = (e) => utcDay(e.first_opened) - start;
  const days = Math.max(utcDay(data.now) - start + 1, ...flat.map((e) => day(e) + 1));
  const fmt = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

  return {
    mode: data.mode, // 'owner' sees emails; 'public' never has any
    design: data.design,
    page: { title: data.title, author: data.author, published: data.published },
    tree: data.tree, // {entries, capped, brought, children}; capped: the page hit 1,000 entries and stopped counting
    flat, // every person once, oldest first: id, depth (1 = opened your link), parent (null = your link), children, brought (> 0 = passed it on), reached, first_opened, label, ai
    days, // from day 0 to today, inclusive
    day, // person -> day index (0 = day 1)
    date: (iso) => fmt(Date.parse(iso)), // "3 Oct"
    dayDate: (d) => fmt((start + d) * DAY), // day index -> "3 Oct"
    path: (e) => { const p = []; for (let x = e; x; x = x.parent) p.unshift(x); return p; },
    name: (e) => e.label ?? (e.ai ? `${e.ai} (AI)` : 'A reader'), // "maria.lund@gmail.com", "ChatGPT (AI)" or "A reader"
  };
})();
