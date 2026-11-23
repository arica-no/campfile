// How it spread, Ember design: every person a dot, levels as columns (rows on phones), sparks glow, Replay runs day by day.
// Reads SHARE (data.js) and renders everything into #spread. CSP: no inline styles in markup; sizes are set through el.style.
(() => {
  const root = document.getElementById('spread');
  const $ = (id) => root.querySelector(`#${id}`);
  const fmt = (n) => n.toLocaleString('en-US');
  const noun = (n) => `${fmt(n)} ${n === 1 ? 'person' : 'people'}`;
  const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const OWNER = SHARE.mode === 'owner';
  const ROOT = OWNER ? 'You' : SHARE.page.author || 'The author'; // strangers read it: "You" would be them
  const SENT = OWNER ? 'you sent it to' : `${SHARE.page.author ? esc(SHARE.page.author) : 'the author'} sent it to`;
  const chipName = (p) => (OWNER ? SHARE.name(p.e) : `Level ${p.level}`); // public: three "A reader" chips read as broken
  const SHOT = document.body.dataset.shot === '1'; // the social card (1200×630): headline, quiet line, finished picture

  if (!SHARE.flat.length) {
    root.innerHTML = `<header>${OWNER
      ? '<h1 class="head">Nobody has opened it through a shared link yet.</h1><p class="quiet">When readers allow it, each one shows up here.</p>'
      : '<h1 class="head">Nobody yet.</h1><p class="quiet">When readers pass it on, it shows up here.</p>'}</header>
    <section class="viz-card empty-card" aria-hidden="true"><i class="dot-you"></i></section>`;
    return;
  }

  root.innerHTML = `
  <header>
    <h1 class="head" id="head"></h1>
    <p class="quiet" id="quiet"></p>
  </header>
  <section class="transport" aria-label="Replay">
    <button type="button" class="play-btn" id="play-btn">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path id="play-icon" d="M4 2.5l10 5.5-10 5.5z"/></svg>
      <span id="play-label">Replay</span>
    </button>
    <div class="scrubber-wrap">
      <div class="scrubber-top">
        <span id="clock-readout"></span>
        <span class="scrub-hint">Drag to choose a day</span>
      </div>
      <div class="scrubber-track" id="scrubber-track" role="slider" tabindex="0" aria-label="Day" aria-valuemin="1" aria-valuenow="1">
        <canvas class="spark-canvas" id="spark-canvas" aria-hidden="true"></canvas>
      </div>
    </div>
    <div class="key-legend">
      <span class="key-item"><i class="dot-you"></i><span class="who">${esc(ROOT)}</span></span>
      <span class="key-item" id="lg-sparks-item"><i class="dot-spark"></i><span>Passed it on (<span id="lg-sparks"></span>)</span></span>
      <span class="key-item"><i class="dot-reader"></i><span>Only read it (<span id="lg-readers"></span>)</span></span>
      <span class="key-item" id="lg-ai-item"><i class="dot-ai"></i><span>AI (<span id="lg-ai"></span>)</span></span>
    </div>
  </section>
  <section class="sparks-bar" id="sparks-bar" aria-label="Sparks">
    <p class="sb-lead" id="sb-lead"></p>
    <div class="sb-row" id="sb-row"><span class="sb-label" id="sb-label">Biggest sparks:</span><ul class="chips" id="chips" aria-labelledby="sb-label"></ul></div>
    <div class="sb-foot" id="sb-foot"><p class="sb-hint" id="sb-hint"></p><button type="button" class="reset-pill off" id="reset-btn">Show all</button></div>
  </section>
  <section class="viz-card" aria-label="How it spread, level by level">
    <div class="viz-canvas-wrap" id="canvas-wrap">
      <canvas class="main-stage" id="stage-canvas" tabindex="0" role="application" aria-label="Spread picture. Arrow keys move between sparks and AIs, Escape shows all."></canvas>
      <div class="spark-card" id="spark-card" role="status" hidden>
        <p class="sc-name" id="sc-name"></p>
        <p class="sc-meta" id="sc-meta"></p>
        <p class="sc-line" id="sc-sent"></p>
        <p class="sc-line" id="sc-through"></p>
        <button type="button" class="sc-x" id="sc-x" aria-label="Show all"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg></button>
      </div>
    </div>
    <div class="level-strip" id="level-strip"></div>
  </section>`;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const TAU = Math.PI * 2;
  const style = getComputedStyle(document.documentElement), tok = (n) => style.getPropertyValue(n).trim();
  const rgba = (hex, a) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))},${a})`;
  let FLAME, COAL, CREAM, DIM, WELL, SELECTED;
  const theme = () => { FLAME = tok('--flame'); COAL = tok('--coal'); CREAM = tok('--cream'); DIM = tok('--dim'); WELL = tok('--well'); SELECTED = tok('--selected-core'); }; // tokens.css: ember dark or paper light
  theme();
  const SANS = tok('--sans');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const phone = matchMedia('(max-width: 699.98px)'); // same breakpoint as the CSS: levels become rows

  // ---- People: one object per person, in the order they opened it ----
  const byEntry = new Map(SHARE.flat.map((e) => [e, {
    e, level: e.depth, ai: !!e.ai, parent: null, kids: [],
    t: SHARE.day(e) + (Date.parse(e.first_opened) % 864e5) / 864e5, // days since day 1 began
  }]));
  for (const p of byEntry.values()) {
    p.parent = byEntry.get(p.e.parent) ?? null;
    p.kids = p.e.children.map((c) => byEntry.get(c));
  }
  const roots = SHARE.tree.children.map((e) => byEntry.get(e));
  const settle = (p, t) => { p.t = Math.max(p.t, t); p.kids.forEach((k) => settle(k, p.t)); }; // nobody before the one who sent it
  roots.forEach((p) => settle(p, 0));
  // The API's brought/reached count AIs too; AIs are not people, so a spark and its numbers count people only.
  const count = (p) => { p.sent = p.kids.filter((k) => !k.ai).length; p.reached = p.kids.reduce((n, k) => n + count(k) + (k.ai ? 0 : 1), 0); return p.reached; };
  roots.forEach(count);
  for (const p of byEntry.values()) p.spark = !p.ai && p.sent > 0;
  const people = [...byEntry.values()].sort((a, b) => a.t - b.t || a.level - b.level || a.e.id - b.e.id);
  people.forEach((p, i) => { p.i = i; });
  const levels = []; // people per level, in tree order: a branch is one run in every level
  const walk = (p) => { (levels[p.level - 1] ??= []).push(p); p.kids.forEach(walk); };
  roots.forEach(walk);

  const TOTAL = people.length, NL = levels.length;
  const DAYS = Math.floor(people[TOTAL - 1].t) + 1;
  const perDay = Array(DAYS).fill(0); // people per day: AIs are not people
  for (const p of people) if (!p.ai) perDay[SHARE.day(p.e)]++;
  const sparks = people.filter((p) => p.spark);
  const ais = people.filter((p) => p.ai), HUMANS = TOTAL - ais.length;
  const hum = new Int32Array(TOTAL + 1); // hum[k]: people (not AIs) among the first k to open it
  people.forEach((p, i) => { hum[i + 1] = hum[i] + (p.ai ? 0 : 1); });
  const picks = people.filter((p) => p.spark || p.ai); // what a tap can pick: sparks, and AIs so their name can be seen
  const maxReached = Math.max(1, ...sparks.map((p) => p.reached));
  const top = [...sparks].sort((a, b) => b.reached - a.reached || a.i - b.i).slice(0, 3);
  const sparkLists = levels.map((a) => a.filter((p) => p.spark));
  // What the arrow keys step through: what a tap can pick, and anyone who sent it only to AIs, the way to those AIs. Spark counts stay as they are.
  const keyed = (p) => p.spark || p.ai || p.kids.some((k) => k.ai);
  const pickLists = levels.map((a) => a.filter(keyed));
  pickLists.forEach((a) => a.forEach((p, i) => { p.pi = i; }));
  const dateOf = (day) => SHARE.dayDate(day - 1); // day 1 = day index 0

  // ---- Words that come from the data ----
  const week = [];
  perDay.forEach((n, d) => { week[Math.floor(d / 7)] = (week[Math.floor(d / 7)] ?? 0) + n; });
  const bigWeek = week.indexOf(Math.max(...week));
  let acc = 0;
  const halfDay = perDay.findIndex((n) => (acc += n) >= HUMANS / 2) + 1;
  const n1 = levels[0].filter((p) => !p.ai).length, level1Passed = sparkLists[0].length;
  const many = !HUMANS ? '' : SHARE.tree.capped ? `${fmt(HUMANS)}+ people` : noun(HUMANS);
  const aiWords = ais.length ? plural(ais.length, 'AI') : ''; // "2 AIs", "1 AI"
  const reached = `${OWNER ? 'Your link' : 'This page'} reached `;
  $('head').innerHTML = HUMANS <= 1
    ? `${reached}<em>${many || aiWords}</em>${many && aiWords ? ` and ${aiWords}` : ''} so far.`
    : `${reached}<em>${many}</em>${aiWords ? ` and ${aiWords}` : ''}, ${plural(NL, 'level')} deep, in ${plural(DAYS, 'day')}.`;
  // Each sentence is its own inline-block span, so a phone never breaks inside one.
  $('quiet').innerHTML = HUMANS === 1
    ? `<span>They opened it on <b>${SHARE.date(people.find((p) => !p.ai).e.first_opened)}</b>.</span>`
    : (halfDay === 1 ? '<span>Half of them came on the <b>first day</b>.</span>' : `<span>Half of them came in the first <b>${halfDay} days</b>.</span>`) +
      (DAYS > 7 ? ` <span>It took off in <b>week ${bigWeek + 1}</b>.</span>` : '');
  $('quiet').hidden = !HUMANS || (SHOT && HUMANS === 1); // the 1-person social card is headline + picture only
  root.querySelector('.transport').hidden = HUMANS === 1 || SHARE.days === 1; // one person or one day: nothing to replay
  $('sb-lead').innerHTML = !sparks.length
    ? (n1 > 1 ? `None of the ${fmt(n1)} people ${SENT} has passed it on yet.` : 'Nobody has passed it on yet.')
    : (n1 === 1 ? `<b>The one person</b> ${SENT} passed it on.` : `<b>${fmt(level1Passed)} of the ${fmt(n1)}</b> people ${SENT} passed it on.`);
  $('sb-hint').textContent = sparks.length ? `Tap a spark in the picture to see ${OWNER ? 'who it is' : 'how far it went'}.` : ais.length ? 'Tap a hollow dot to see which AI read it.' : '';
  $('lg-sparks').textContent = plural(sparks.length, 'spark');
  $('lg-readers').textContent = fmt(HUMANS - sparks.length);
  $('lg-ai').textContent = fmt(ais.length);
  $('lg-ai-item').hidden = !ais.length;
  root.querySelector('.key-legend').classList.toggle('quad', !!ais.length && !!sparks.length); // four items: two even rows on phones
  if (!sparks.length) { $('sb-row').hidden = $('lg-sparks-item').hidden = true; }
  $('sb-foot').hidden = !$('sb-hint').textContent; // no sparks, no AIs: nothing to tap, so no hint

  // ---- Elements and state ----
  const stage = $('stage-canvas'), ctx = stage.getContext('2d'), wrap = $('canvas-wrap');
  const sparkCv = $('spark-canvas'), sctx = sparkCv.getContext('2d'), track = $('scrubber-track');
  const strip = $('level-strip'), card = $('spark-card'), reset = $('reset-btn'), bar = $('sparks-bar');
  const playBtn = $('play-btn'), playLabel = $('play-label'), playIcon = $('play-icon');
  let t = DAYS, playing = false, raf = 0, timer = 0, drag = false;
  let sel = null, selLevel = 0, lit = null;
  const SWELL = (0.5 * DAYS) / 8; // new people swell for half a second of replay
  track.setAttribute('aria-valuemax', DAYS);

  const chipEls = top.map((p) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.setAttribute('aria-pressed', 'false');
    b.title = `${noun(p.reached)} came through them`;
    b.innerHTML = '<i class="dot" aria-hidden="true"></i><span class="nm"></span><span class="sep" aria-hidden="true">·</span><span class="ct" aria-hidden="true"></span><span class="vh"></span>';
    b.querySelector('.nm').textContent = chipName(p);
    b.querySelector('.ct').textContent = fmt(p.reached);
    b.querySelector('.vh').textContent = `, ${noun(p.reached)} came through them`;
    b.addEventListener('click', () => select(sel === p ? null : p));
    li.append(b);
    $('chips').append(li);
    return b;
  });

  strip.innerHTML = `<div class="lvl-cell you"><span class="lvl-tag">${esc(ROOT)}</span><span class="lvl-count"><b>1</b><span>link</span></span><span class="lvl-pass"><b>${fmt(n1)}</b> opened it</span></div>` +
    levels.map((a, i) => { const n = a.filter((p) => !p.ai).length; return `<button type="button" class="lvl-cell" data-level="${i + 1}" aria-pressed="false"><span class="lvl-tag">Level ${i + 1}</span><span class="lvl-count"><b>${fmt(n)}</b><span>${n === 1 ? 'person' : 'people'}</span></span><span class="lvl-pass"><b>${fmt(sparkLists[i].length)}</b> passed it on</span></button>`; }).join('');
  const cellEls = [...strip.querySelectorAll('button')];
  cellEls.forEach((b, i) => b.addEventListener('click', () => selectLevel(selLevel === i + 1 ? 0 : i + 1)));

  // Soft glow for sparks, drawn as a sprite so 236 of them stay cheap; painted again when the scheme changes.
  const glow = document.createElement('canvas');
  glow.width = glow.height = 96;
  function paintGlow() {
    const g = glow.getContext('2d'), grad = g.createRadialGradient(48, 48, 0, 48, 48, 48);
    grad.addColorStop(0, rgba(FLAME, '.6'));
    grad.addColorStop(0.3, rgba(FLAME, '.26'));
    grad.addColorStop(1, rgba(FLAME, 0));
    g.clearRect(0, 0, 96, 96); g.fillStyle = grad; g.fillRect(0, 0, 96, 96);
  }
  paintGlow();

  // ---- Layout: levels are columns (rows on phones). Each level is spread over the full length of its column
  // in tree order, in as many lanes as it needs, so a branch is one run in every level and lines stay flowing. ----
  let W = 0, H = 0, dpr = 1, vert = false, ls = 1, rg = 3, you = { x: 0, y: 0, r: 8 }, bands = [], names = [], rootLabel = ROOT;
  const PAD_TOP = 38, PAD_BOTTOM = 16;
  const clip = (text, max) => { // ctx.font must be set; a long author name ends in "…"
    if (ctx.measureText(text).width <= max) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
    return `${s.trimEnd()}…`;
  };

  function layout(room) {
    const counts = levels.map((a) => a.length);
    const lanesFor = (S) => counts.map((n) => Math.ceil(n / S));
    let p, m, s, q, lane, crossStart, crossLen, nameMin = 4; // nameMin: a name beside a spark starts right of this
    const center = [];
    if (!vert) {
      const cw = W / (NL + 1), bw = cw - 2 * Math.max(12, cw * 0.12), hb = Math.max(160, room - PAD_TOP - PAD_BOTTOM);
      for (p = 40; p > 5; p -= 0.5) if (lanesFor(Math.floor(hb / p)).every((l) => l <= Math.floor(bw / p))) break;
      m = lanesFor(Math.floor(hb / p));
      s = counts.map((n, i) => Math.ceil(n / m[i]));
      crossStart = PAD_TOP; crossLen = Math.max(...s) * p;
      q = s.map((n) => crossLen / n);
      lane = q.map((x, i) => Math.min(x, bw / m[i]));
      counts.forEach((_, i) => { center[i] = (i + 1.5) * cw; });
      H = PAD_TOP + crossLen + PAD_BOTTOM;
      you = { x: cw / 2, y: PAD_TOP + crossLen / 2 };
      ctx.font = `600 11px ${SANS}`;
      rootLabel = clip(ROOT, cw - 12);
    } else {
      ctx.font = `600 11px ${SANS}`;
      const G = Math.ceil(Math.max(ctx.measureText(`Level ${NL}`).width, Math.min(ctx.measureText(ROOT).width, 90))) + 22, GAP = 14, YOUH = 30, EDGE = 10, wSpan = W - G - 14;
      rootLabel = clip(ROOT, G - 22);
      nameMin = G - 6; // clear of the "Level N" labels in the gutter
      const build = (p) => {
        const m = lanesFor(Math.floor(wSpan / p)), s = counts.map((n, i) => Math.ceil(n / m[i]));
        const q = s.map((n) => wSpan / n), lane = q.map((x) => Math.min(x, 1.6 * p));
        return { m, s, q, lane, h: 2 * EDGE + YOUH + counts.reduce((a, _, i) => a + GAP + m[i] * lane[i], 0) };
      };
      for (p = 34; p > 6; p -= 0.5) if (build(p).h <= 640) break;
      ({ m, s, q, lane } = build(p));
      crossStart = G; crossLen = wSpan;
      let y = EDGE;
      bands = [{ y0: y, y1: y + YOUH, ly: y + YOUH / 2 }];
      you = { x: G + wSpan / 2, y: y + YOUH / 2 };
      y += YOUH + GAP;
      counts.forEach((_, i) => {
        const th = m[i] * lane[i];
        bands.push({ y0: y, y1: y + th, ly: y + lane[i] / 2 });
        center[i] = y + th / 2;
        y += th + GAP;
      });
      H = y - GAP + EDGE;
    }
    levels.forEach((arr, li) => arr.forEach((pp, i) => {
      const slice = Math.floor(i / m[li]), inSlice = Math.min(m[li], arr.length - slice * m[li]);
      const cross = crossStart + (slice + 0.5) * q[li];
      const along = center[li] + ((i % m[li]) - (inSlice - 1) / 2) * lane[li];
      pp.x = vert ? cross : along; pp.y = vert ? along : cross;
    }));
    ls = clamp(p / 9.5, 1, 2.2);
    rg = clamp(p * 0.1, 2.5, 4); // gap between a spark and its ring
    // when dots are far apart (20 people) a ring must not reach the next dot, so big sparks shrink a little; with hundreds they stay as they were
    const sparse = clamp((p - 14) / 10, 0, 1), cap = p / 2 - rg - 1.5;
    for (const pp of people) {
      const v = p * (0.3 + 0.17 * Math.sqrt(pp.reached / maxReached));
      pp.r = pp.spark ? v - sparse * Math.max(0, v - cap) : 0.22 * p;
    }
    you.r = clamp(0.62 * p, 7.5, vert ? 15 : 21); // on phones it stays inside its 30px row, clear of the card's edge

    // shortcut: with only a few sparks the top three get their name beside them where it fits; with hundreds it never would, so skipped
    names = [];
    if (sparks.length <= 12 && !SHOT) {
      ctx.font = `600 12px ${SANS}`;
      const boxes = [];
      const free = (b) => boxes.every((o) => b[2] < o[0] || b[0] > o[2] || b[3] < o[1] || b[1] > o[3]) &&
        people.every((d) => { const dx = Math.max(b[0] - d.x, 0, d.x - b[2]), dy = Math.max(b[1] - d.y, 0, d.y - b[3]); return dx * dx + dy * dy > (d.r + 3) ** 2; }) &&
        Math.hypot(Math.max(b[0] - you.x, 0, you.x - b[2]), Math.max(b[1] - you.y, 0, you.y - b[3])) > you.r + 3;
      for (const c of top) {
        const text = `${chipName(c)} · ${fmt(c.reached)}`, w = ctx.measureText(text).width;
        for (const side of [1, -1]) {
          const x = side > 0 ? c.x + c.r + rg + 9 : c.x - c.r - rg - 9 - w, b = [x - 4, c.y - 10, x + w + 4, c.y + 10];
          if (b[0] < nameMin || b[2] > W - 4 || !free(b)) continue;
          boxes.push(b); names.push({ c, text, x, b });
          break;
        }
      }
    }
  }

  // ---- Drawing ----
  function drawGrid() {
    ctx.font = `600 11px ${SANS}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgba(CREAM, '.06');
    if (!vert) {
      const cw = W / (NL + 1);
      if (selLevel) { ctx.fillStyle = rgba(FLAME, '.07'); ctx.fillRect(selLevel * cw, 0, cw, H); ctx.fillStyle = rgba(CREAM, '.06'); }
      for (let k = 1; k <= NL; k++) ctx.fillRect(Math.round(k * cw) - 1, 0, 1, H);
      ctx.textAlign = 'center';
      for (let k = 0; k <= NL; k++) {
        ctx.fillStyle = k === selLevel ? CREAM : DIM;
        ctx.fillText(k ? `Level ${k}` : rootLabel, (k + 0.5) * cw, 20);
      }
    } else {
      ctx.textAlign = 'left';
      bands.forEach((b, k) => {
        if (k && k === selLevel) { ctx.fillStyle = rgba(FLAME, '.07'); ctx.fillRect(0, b.y0 - 7, W, b.y1 - b.y0 + 14); }
        if (k > 0) { ctx.fillStyle = rgba(CREAM, '.06'); ctx.fillRect(0, Math.round(b.y0 - 7), W, 1); }
        ctx.fillStyle = k === selLevel ? CREAM : DIM;
        ctx.fillText(k ? `Level ${k}` : rootLabel, 12, b.ly);
      });
    }
  }

  function countAt(x) { // people with t <= x; people are sorted by t
    let lo = 0, hi = TOTAL;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (people[mid].t <= x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function draw() {
    if (!W) return;
    const vis = countAt(t), hl = lit, swell = playing && !reduce.matches ? SWELL : 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawGrid();

    // One path and one stroke per style, never one stroke per line.
    const lines = (test, color, width) => {
      ctx.beginPath();
      for (let i = 0; i < vis; i++) {
        const c = people[i];
        if (!test(c, i)) continue;
        const a = c.parent ?? you;
        ctx.moveTo(a.x, a.y);
        if (vert) { const my = (a.y + c.y) / 2; ctx.bezierCurveTo(a.x, my, c.x, my, c.x, c.y); }
        else { const mx = (a.x + c.x) / 2; ctx.bezierCurveTo(mx, a.y, mx, c.y, c.x, c.y); }
      }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    };
    if (!hl) {
      lines((c) => !c.spark, rgba(CREAM, '.065'), 0.65 * ls);
      lines((c) => c.spark, rgba(FLAME, '.28'), 1.1 * ls);
    } else {
      lines((c, i) => !hl[i], rgba(CREAM, '.025'), 0.6 * ls);
      lines((c, i) => hl[i] === 1 && !c.spark, rgba(COAL, '.55'), ls);
      lines((c, i) => hl[i] === 1 && c.spark, rgba(FLAME, '.7'), 1.6 * ls);
      lines((c, i) => hl[i] > 1, rgba(FLAME, '.95'), 2.2 * ls);
    }

    const dim = new Path2D(), sparkDim = new Path2D(), readers = new Path2D(), readersLit = new Path2D(), cores = new Path2D(), lights = [];
    const aiRing = new Path2D(), aiDim = new Path2D();
    for (let i = 0; i < vis; i++) {
      const c = people[i], on = !hl || hl[i] > 0, age = (t - c.t) / swell;
      const r = c.r * (swell && age < 1 ? 1 + 1.2 * (1 - age) ** 2 : 1);
      const path = c.ai ? (on ? aiRing : aiDim) : c.spark ? (on ? cores : sparkDim) : on ? (hl ? readersLit : readers) : dim;
      path.moveTo(c.x + r, c.y);
      path.arc(c.x, c.y, r, 0, TAU);
      if (c.spark && on) lights.push([c, r]);
    }
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = COAL; ctx.fill(dim);
    ctx.fillStyle = FLAME; ctx.fill(sparkDim);
    ctx.strokeStyle = DIM; ctx.lineWidth = ls; ctx.stroke(aiDim);
    ctx.globalAlpha = 0.85; ctx.fillStyle = COAL; ctx.fill(readers);
    ctx.globalAlpha = 0.9; ctx.fillStyle = FLAME; ctx.fill(readersLit);
    // An AI is quiet: an open ring, never a glow.
    ctx.globalAlpha = 0.7; ctx.strokeStyle = DIM; ctx.lineWidth = 1.25 * ls; ctx.stroke(aiRing);
    for (const [c, r] of lights) {
      const k = c === sel ? 4.2 : 3;
      ctx.globalAlpha = c === sel ? 1 : 0.8;
      ctx.drawImage(glow, c.x - r * k, c.y - r * k, r * k * 2, r * k * 2);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = FLAME; ctx.fill(cores);
    if (sel && sel.t <= t) {
      ctx.fillStyle = sel.ai ? DIM : SELECTED;
      ctx.beginPath(); ctx.arc(sel.x, sel.y, sel.r, 0, TAU); ctx.fill();
      ctx.strokeStyle = CREAM; ctx.lineWidth = 1.75 * ls;
      ctx.beginPath(); ctx.arc(sel.x, sel.y, sel.r + rg + 1.5, 0, TAU); ctx.stroke();
    }
    // The three chips' sparks wear a ring so a chip can be found in the picture.
    ctx.strokeStyle = FLAME; ctx.lineWidth = 1.25 * ls;
    for (const c of top) {
      if (c.t > t || c === sel) continue;
      ctx.globalAlpha = !hl || hl[c.i] ? 0.9 : 0.15;
      ctx.beginPath(); ctx.arc(c.x, c.y, c.r + rg, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.beginPath(); ctx.arc(you.x, you.y, you.r, 0, TAU);
    ctx.fillStyle = CREAM; ctx.fill();
    ctx.lineWidth = 3 * Math.min(ls, 1.6); ctx.strokeStyle = FLAME; ctx.stroke();

    ctx.font = `600 12px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const n of names) {
      if (n.c.t > t || (hl && !hl[n.c.i])) continue; // a dimmed name would fail contrast, so it goes away
      ctx.fillStyle = WELL; ctx.beginPath(); ctx.roundRect(n.b[0], n.b[1], n.b[2] - n.b[0], n.b[3] - n.b[1], 5); ctx.fill();
      ctx.fillStyle = CREAM; ctx.fillText(n.text, n.x, n.c.y);
    }
    ctx.globalAlpha = 1;
  }

  // ---- Time: a day is t = 1; the page opens on the last day ----
  const dayNo = () => clamp(Math.ceil(t - 1e-9), 1, DAYS);
  let clockHtml = '';
  function clock() {
    const d = dayNo(), n = hum[countAt(t)], date = dateOf(d);
    const html = `<b>Day ${d}</b> · ${date} · ${SHARE.tree.capped && d === DAYS ? `${fmt(n)}+ people` : noun(n)}`; // capped: it stopped counting at 1,000
    if (html === clockHtml) return;
    clockHtml = html;
    $('clock-readout').innerHTML = html;
    track.setAttribute('aria-valuenow', d);
    track.setAttribute('aria-valuetext', `Day ${d}, ${date}, ${noun(n)}`);
  }
  const maxDay = Math.max(...perDay, 1);
  function drawSpark() {
    const w = sparkCv.clientWidth, h = sparkCv.clientHeight;
    if (!w) return;
    if (sparkCv.width !== Math.round(w * dpr)) { sparkCv.width = Math.round(w * dpr); sparkCv.height = Math.round(h * dpr); }
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, w, h);
    const bw = w / DAYS, now = Math.ceil(t - 1e-9);
    for (let d = 0; d < DAYS; d++) {
      const bh = Math.max(2, (perDay[d] / maxDay) * (h - 6));
      sctx.fillStyle = d < now ? FLAME : rgba(CREAM, '.16');
      sctx.fillRect(d * bw + 1, h - bh - 2, Math.max(1.5, bw - 2), bh);
    }
    sctx.fillStyle = CREAM;
    sctx.fillRect(clamp((t / DAYS) * w - 1, 0, w - 2), 0, 2, h);
  }
  function render() { clock(); drawSpark(); draw(); placeCard(); playUi(); } // the label follows t: scrubbing to the end means "Replay"
  function setT(v) { t = clamp(v, 0, DAYS); render(); }

  const PLAY = 'M4 2.5l10 5.5-10 5.5z', PAUSE = 'M3.5 2.5h3v11h-3zm6 0h3v11h-3z';
  function playUi() {
    playLabel.textContent = playing ? 'Pause' : t >= DAYS ? 'Replay' : 'Resume';
    playIcon.setAttribute('d', playing ? PAUSE : PLAY);
  }
  function stop() {
    playing = false;
    cancelAnimationFrame(raf); clearInterval(timer);
    render();
  }
  function play() {
    if (t >= DAYS) t = 0;
    playing = true; playUi();
    if (reduce.matches) { // no animation: one day per step
      setT(Math.floor(t) + 1);
      timer = setInterval(() => { setT(Math.floor(t) + 1); if (t >= DAYS) stop(); }, clamp(8000 / DAYS, 300, 600));
      return;
    }
    let last = performance.now();
    const tick = (now) => {
      t = Math.min(DAYS, t + Math.min(0.1, (now - last) / 1000) * (DAYS / 8)); // about 8 seconds, day 1 to the last day
      last = now;
      render();
      if (t >= DAYS) stop(); else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  playBtn.addEventListener('click', () => (playing ? stop() : play()));

  const seek = (e) => { const r = track.getBoundingClientRect(); setT(Math.max(1, Math.ceil(clamp((e.clientX - r.left) / r.width, 0, 1) * DAYS))); };
  track.addEventListener('pointerdown', (e) => { stop(); drag = true; track.setPointerCapture(e.pointerId); seek(e); });
  track.addEventListener('pointermove', (e) => { if (drag) seek(e); });
  track.addEventListener('pointerup', () => { drag = false; });
  track.addEventListener('pointercancel', () => { drag = false; });
  track.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -7, PageUp: 7 }[e.key];
    const to = step ? dayNo() + step : e.key === 'Home' ? 1 : e.key === 'End' ? DAYS : 0;
    if (!to) return;
    e.preventDefault();
    stop(); setT(clamp(to, 1, DAYS));
  });

  // ---- Picking a spark (or an AI), a level, or nothing ----
  function setLit() {
    lit = null;
    if (sel) {
      lit = new Uint8Array(TOTAL);
      const down = (p) => { lit[p.i] = 1; p.kids.forEach(down); };
      down(sel);
      for (let a = sel.parent; a; a = a.parent) lit[a.i] = 2;
      lit[sel.i] = 3;
    } else if (selLevel) {
      lit = new Uint8Array(TOTAL);
      levels[selLevel - 1].forEach((p) => { lit[p.i] = 1; });
    }
  }
  function sync() {
    chipEls.forEach((b, i) => b.setAttribute('aria-pressed', String(sel === top[i])));
    cellEls.forEach((b, i) => { b.setAttribute('aria-pressed', String(selLevel === i + 1)); b.classList.toggle('active', selLevel === i + 1); });
    reset.classList.toggle('off', !sel && !selLevel);
    bar.classList.toggle('pick', !!sel);
    $('sb-foot').hidden = !$('sb-hint').textContent && !sel && !selLevel; // no sparks, no AIs: the foot only shows to undo a picked level
    setLit();
    if (sel) {
      const e = sel.e;
      card.hidden = false;
      $('sc-name').textContent = SHARE.name(e);
      $('sc-meta').textContent = `Level ${sel.level} · Opened ${SHARE.date(e.first_opened)}`;
      if (sel.ai) $('sc-sent').textContent = "An AI read it. AIs don't pass it on.";
      else $('sc-sent').innerHTML = `Sent it to <b>${noun(sel.sent)}</b>`;
      $('sc-through').innerHTML = `<b>${noun(sel.reached)}</b> came through them`;
      $('sc-through').hidden = sel.ai;
    } else card.hidden = true;
    render();
  }
  function select(p) {
    if (p && p.t > t) { stop(); t = DAYS; } // a chip can name someone the picture has not reached yet
    sel = p; selLevel = 0;
    sync();
  }
  function selectLevel(k) { sel = null; selLevel = k; sync(); }
  const clear = () => {
    if (!sel && !selLevel) return;
    const back = vert && sel && document.activeElement === reset ? Math.max(top.indexOf(sel), 0) : -1; // the chips come back: hand the focus to one
    sel = null; selLevel = 0; sync();
    if (back >= 0 && chipEls[back]) chipEls[back].focus();
  };
  reset.addEventListener('click', clear);
  $('sc-x').addEventListener('click', clear);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') clear(); });

  function placeCard() {
    if (!sel || card.hidden) return;
    if (vert) { card.style.cssText = ''; return; } // on a phone the card sits in the sparks bar, not on the picture
    if (sel.t > t) { card.style.visibility = 'hidden'; return; }
    card.style.visibility = '';
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = sel.r * 1.6 + 10;
    let y = sel.y - gap - ch;
    if (y < 6) y = sel.y + gap;
    card.style.transform = `translate(${Math.round(clamp(sel.x - cw / 2, 6, W - cw - 6))}px, ${Math.round(clamp(y, 6, H - ch - 6))}px)`;
  }

  // A tap picks the nearest spark (or AI) within reach: at least 14px each way, so the hit area stays 28px even for tiny dots.
  function sparkAt(e) {
    const r = stage.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = Infinity;
    for (const p of picks) {
      if (p.t > t) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    return best && bd <= Math.max(14, best.r + 6) ? best : null;
  }
  stage.addEventListener('click', (e) => {
    const p = sparkAt(e);
    if (!p) return clear();
    select(sel === p ? null : p);
    if (sel && vert) bar.scrollIntoView({ block: 'nearest', behavior: reduce.matches ? 'auto' : 'smooth' }); // a tap far down the picture: show the card up in the bar
  });
  stage.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') stage.style.cursor = sparkAt(e) ? 'pointer' : ''; });
  stage.addEventListener('focus', () => { const first = top[0] ?? picks[0]; if (!sel && first && stage.matches(':focus-visible')) select(first); });
  stage.addEventListener('keydown', (e) => {
    // Along a level, or between levels (up to who sent it, down to the first one they sent it to that the keys step through); the keys follow the picture.
    const [vk, hk] = vert ? ['level', 'along'] : ['along', 'level'];
    const [kind, dir] = { ArrowUp: [vk, -1], ArrowDown: [vk, 1], ArrowLeft: [hk, -1], ArrowRight: [hk, 1] }[e.key] ?? [];
    if (!kind || !sel) return;
    e.preventDefault();
    const next = kind === 'along' ? pickLists[sel.level - 1][sel.pi + dir] : dir < 0 ? sel.parent : sel.kids.find(keyed);
    if (next) select(next);
  });

  // ---- Fit to the window ----
  let fitKey = '';
  function fit() {
    const w = wrap.clientWidth;
    if (!w) return;
    const rowsNow = phone.matches, key = `${w}|${innerHeight}|${rowsNow}|${devicePixelRatio}`;
    if (key === fitKey) return;
    fitKey = key;
    W = w; vert = rowsNow; dpr = Math.min(devicePixelRatio || 1, 2); // 3x phones: 2x is plenty for dots and half the pixels to paint
    if (vert) $('sb-foot').prepend(card); else wrap.append(card); // on a phone the picked spark's card takes the hint's place
    const aligned = !vert && W >= 100 * (NL + 1);
    strip.classList.toggle('stack', !aligned);
    const cols = aligned ? NL + 1 : vert ? Math.min(2, NL) : NL <= 5 ? NL : Math.ceil(NL / 2), rest = NL % cols;
    strip.style.setProperty('--cols', cols);
    cellEls[NL - 1].style.gridColumn = !aligned && rest ? `span ${cols - rest + 1}` : ''; // stacked: the last cell fills its row, no hole
    // The picture gets what is left of the screen under the controls, minus the level strip and the page's bottom padding.
    if (SHOT) { // the picture fills the card below the words; the dots sit in the middle of what layout() needs
      const room = wrap.parentElement.clientHeight;
      layout(room);
      const dy = (room - H) / 2;
      for (const p of people) p.y += dy;
      you.y += dy; H = room;
    } else layout(clamp(innerHeight - (wrap.getBoundingClientRect().top + scrollY) - strip.offsetHeight - 32, 360, 600));
    wrap.style.height = `${H}px`;
    stage.width = Math.round(W * dpr); stage.height = Math.round(H * dpr);
    render();
  }
  new ResizeObserver(fit).observe(wrap);
  addEventListener('resize', fit);
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { theme(); paintGlow(); render(); });
  fit();
})();
