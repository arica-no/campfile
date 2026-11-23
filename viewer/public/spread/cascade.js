// How it spread, Cascade: the round 6 "river" picture (k-cascade.html), driven by SHARE (data.js). Renders everything inside #spread.
// One bar per level, as tall as its people; each person is a slice; ribbons run from every spark to the people they sent it to.
(() => {
  const root = document.getElementById('spread');
  const $ = (id) => document.getElementById(`sc-${id}`);
  const fmt = (n) => n.toLocaleString('en-US');
  const people = (n) => `${fmt(n)} ${n === 1 ? 'person' : 'people'}`;
  const sharedIt = (n) => `${fmt(n)} of those shared it`; // the bare count under a round: drawn and measured by the picture's labels; the strip's cell has its number in <b>
  const reachName = (k) => (k === 1 ? 'Direct reach' : k === 2 ? 'Indirect reach' : 'Extended reach'); // every level from 3 on is one "Extended"
  const reachTag = (k) => (k === 1 ? 'Direct' : k === 2 ? 'Indirect' : 'Extended'); // short forms: the strip cells and the picture's gutter have room for little more than a word
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const style = getComputedStyle(document.documentElement);
  const tok = (n) => style.getPropertyValue(n).trim();
  let FLAME, COAL, CREAM, DIM, FILL;
  const theme = () => { FLAME = tok('--flame'); COAL = tok('--coal'); CREAM = tok('--cream'); DIM = tok('--dim'); FILL = [COAL, FLAME, DIM]; }; // tokens.css: ember dark or paper light
  theme();
  const rgba = (hex, a) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))},${a})`;

  // Public mode is read by strangers: no "you", the author's name instead.
  const pub = SHARE.mode === 'public', author = SHARE.page.author || null;
  const youName = pub ? author ?? 'The author' : 'You';
  const whoSent = pub ? (author ? esc(author) : 'the author') : 'you';
  // The social card (1200×630 screenshot): headline, quiet line and the finished picture only, down to 20px above the bottom.
  const shot = document.body.dataset.shot === '1';
  root.classList.toggle('shot', shot);
  const shotRoom = (el) => innerHeight - 20 - (el.getBoundingClientRect().top + scrollY); // fractional, so the card ends exactly 20px above the bottom

  // ---- The data, read once. Nothing below is typed in by hand. ----
  const flat = SHARE.flat, N = flat.length;
  if (!N) {
    root.innerHTML = `<h1 class="head">${pub ? 'Nobody yet.' : 'Nobody has opened it through a shared link yet.'}</h1><p class="quiet">${pub ? 'When readers share it on, it shows up here.' : 'When readers allow it, each one shows up here.'}</p><div class="viz-card empty-card" aria-hidden="true"><i class="you-block"></i></div>`;
    if (shot) { const card = root.querySelector('.empty-card'); card.style.height = `${shotRoom(card)}px`; }
    return;
  }
  const L = Math.max(...flat.map((p) => p.depth));                  // levels (AIs included)
  const dayOf = Int16Array.from(flat, (p) => SHARE.day(p));          // 0 = day 1
  const last = Math.max(...dayOf);                                   // days (AIs included)
  const byLevel = [[]];                                              // tree order: a branch is one block on every level
  for (let k = 1, row = SHARE.tree.children; k <= L; k++, row = row.flatMap((p) => p.children)) byLevel[k] = row;
  const kidAll0 = Int16Array.from(flat, (p) => p.children.reduce((m, c) => Math.min(m, dayOf[c.id]), 9999)); // day of anyone's first child (ribbons)
  const kid0 = Int16Array.from(flat, (p) => p.children.reduce((m, c) => (c.ai ? m : Math.min(m, dayOf[c.id])), 9999)); // day of a spark's first child who is a person
  // AIs are not people: the tree's brought/reached count every entry, so count people only here. hb: people they sent it to; hr: people below them.
  const hb = new Int32Array(N), hr = new Int32Array(N);
  (function count(list) {
    let s = 0;
    for (const p of list) { hr[p.id] = count(p.children); hb[p.id] = p.children.filter((c) => !c.ai).length; s += hr[p.id] + (p.ai ? 0 : 1); }
    return s;
  })(SHARE.tree.children);
  const isSpark = (p) => !p.ai && hb[p.id] > 0;
  const sparkList = flat.filter(isSpark);
  const aiList = flat.filter((p) => p.ai), nAI = aiList.length, P = N - nAI; // every "people" count leaves AIs out
  const lvAll = byLevel.map((r) => r.length);                        // bar sizes: every entry
  const lvPeople = byLevel.map((r) => r.filter((p) => !p.ai).length), lvSparks = byLevel.map((r) => r.filter(isSpark).length);
  const top = [...sparkList].sort((a, b) => hr[b.id] - hr[a.id] || a.first_opened.localeCompare(b.first_opened)).slice(0, 3);
  const perDay = Array(last + 1).fill(0);
  flat.forEach((p, i) => { if (!p.ai) perDay[dayOf[i]]++; });
  let run = 0;
  const cum = perDay.map((n) => (run += n));
  const dateOf = SHARE.dayDate;
  const total = (n) => (n === P && SHARE.tree.capped ? `${fmt(n)}+ people` : people(n)); // capped: the page stopped counting at 1,000 entries

  // ---- Markup ----
  const half = cum.findIndex((c) => c >= P / 2) + 1;
  const weeks = [];
  perDay.forEach((n, d) => { weeks[Math.floor(d / 7)] = (weeks[Math.floor(d / 7)] ?? 0) + n; });
  const wk = weeks.indexOf(Math.max(...weeks));
  const nb = (s) => s.replaceAll(' ', '\u00a0'); // the headline breaks only between its phrases: a phone never splits "10 rounds / deep"
  const reached = `${pub ? 'This page' : 'Your Campfile'} reached <em>${nb(total(P))}</em>${nAI ? ` ${nb(`and ${nAI} ${nAI === 1 ? 'AI' : 'AIs'}`)}` : ''}`;
  const head = P === 1 ? `${reached} so far.` : `${reached}, ${nb(`${L} ${L === 1 ? 'round' : 'rounds'} deep`)}, ${nb(`in ${last + 1} ${last ? 'days' : 'day'}`)}.`;
  // Each sentence wraps on its own, so a phone never breaks "in the / first 13 days". One person: just when they opened it (not on the social card: headline and picture only).
  const quiet = P === 1 ? (shot ? '' : `They opened it on ${SHARE.date(flat.find((p) => !p.ai).first_opened)}.`)
    : !P ? ''
    : `<span class="qs">Half of them came ${half === 1 ? 'on the <b>first day</b>' : `in the first <b>${half} days</b>`}.</span>${last + 1 > 7 ? ` <span class="qs">It took off in <b>week ${wk + 1}</b>.</span>` : ''}`;
  const s1 = lvSparks[1], p1 = lvPeople[1];
  const sparksText = P === 1 ? 'Nobody has shared it on yet.'
    : p1 === 1 ? `The person ${whoSent} sent it to ${s1 ? '<b>shared it on</b>.' : 'has not shared it on yet.'}`
    : s1 ? `<b>${s1} of the ${fmt(p1)}</b> people ${whoSent} sent it to shared it on.`
    : `None of the <b>${fmt(p1)}</b> people ${whoSent} sent it to has shared it on yet.`;
  const legend = `<span class="key-item"><i class="dot-you"></i>${esc(youName)}</span>`
    + (sparkList.length ? `<span class="key-item"><i class="dot-spark"></i>Shared it on (${fmt(sparkList.length)})</span>` : '')
    + `<span class="key-item"><i class="dot-reader"></i>Only read it (${fmt(P - sparkList.length)})</span>`
    + (nAI ? `<span class="key-item"><i class="dot-ai"></i>AI (${fmt(nAI)})</span>` : '')
    + (sparkList.length ? '<span class="key-item key-mult"><i class="mult">×N</i>people each one reached</span>' : '');
  const canTab = top.length > 0 || nAI > 0; // sparks and AIs can be picked

  root.innerHTML = `
  <div class="intro">
    <h1 class="head">${head}</h1>
    ${quiet ? `<p class="quiet">${quiet}</p>` : ''}
  </div>
  <div class="transport"${P === 1 || SHARE.days === 1 ? ' hidden' : ''}>
    <button type="button" class="play-btn" id="sc-play">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path id="sc-play-icon" d="M4 2.5l10 5.5-10 5.5z"/></svg>
      <span id="sc-play-label">Replay</span>
    </button>
    <div class="scrubber-wrap">
      <div class="scrubber-top">
        <span class="clock" id="sc-clock"></span>
        <span class="hint-drag">Drag to choose a day</span>
      </div>
      <div class="scrubber-track" id="sc-track" role="slider" aria-label="Day" aria-valuemin="1" tabindex="0">
        <canvas class="spark-canvas" id="sc-spark" aria-hidden="true"></canvas>
      </div>
    </div>
    <div class="key-legend">${legend}</div>
  </div>
  <section class="sparks-bar" id="sc-sparks-bar" aria-label="Who shared it on">
    <i class="edge" aria-hidden="true"></i>
    <div class="sparks-main">
      <p class="sparks-text">${sparksText}</p>
      ${top.length ? '<div class="chips" id="sc-chips" role="group" aria-label="Reached the most"><span class="chips-lbl" aria-hidden="true">Reached the most:</span></div>' : ''}
    </div>
    ${canTab ? `<div class="sparks-sub">
      <p class="hint">${!top.length ? 'Tap a grey slice in the picture to see which AI read it.' : pub ? 'Tap a glowing dot in the picture to see how far it went.' : 'Tap a glowing dot in the picture to see who it is.'}</p>
      <div class="card" id="sc-card">
        <b class="c-name" id="sc-c-name"></b>
        <span class="c-fact c-level" id="sc-c-level"></span>
        <span class="c-facts"><span class="c-fact" id="sc-c-sent"></span><span class="c-fact" id="sc-c-came"></span></span>
        <span class="c-fact c-open" id="sc-c-open"></span>
        <button type="button" class="reset-pill" id="sc-reset">Show all</button>
      </div>
    </div>` : ''}
    <p class="sr" id="sc-live" aria-live="polite"></p>
  </section>
  <section class="viz-card" aria-label="How it spread, round by round">
    <div class="viz-canvas-wrap" id="sc-wrap">
      <canvas class="main-stage" id="sc-stage"${canTab ? ' tabindex="0"' : ''} role="img" aria-label="Picture of how ${pub ? 'this page' : 'your link'} spread: one bar for each round of sharing, as tall as the number of people in it, with the people who shared it on marked in flame.${canTab ? ' Use the arrow keys to move between them, and Escape to show all.' : ''}"></canvas>
    </div>
    <ol class="level-strip" id="sc-strip" aria-label="People in each round of sharing"></ol>
  </section>
  ${sparkList.length ? '<p class="key-item key-note"><i class="mult">×N</i>people each one reached</p>' : ''}`;

  const x1 = (v) => Number(v.toFixed(1)).toString();
  const strip = $('strip');
  strip.style.setProperty('--n', L + 1);
  strip.innerHTML = (L >= 3 ? '<li class="ext-legend" aria-hidden="true"><span>Extended</span></li>' : '') + Array.from({ length: L + 1 }, (_, k) => {
    const next = k === 0 ? lvPeople[1] : lvPeople[k + 1], from = k === 0 ? 1 : lvSparks[k];
    const badge = from > 0 && next ? `<span class="mult" title="${k === 0 ? `${people(next)} opened ${pub ? 'the' : 'your'} link` : `${people(next)} in ${reachName(k + 1)}, from ${fmt(from)} who shared it on`}">×${x1(next / from)}</span>` : '';
    const ext = k >= 3; // a screen reader hears "Extended reach" on every cell from level 3 on (hidden span), so the visible tag (the list's first Extended row only) is aria-hidden
    return k === 0
      ? `<li class="lvl-cell lvl-you"><span class="lvl-tag">${esc(youName)}</span>${badge}<span class="lvl-count"><b>1</b> link</span><span class="lvl-pass"><b>${fmt(lvPeople[1])}</b> opened it</span></li>`
      : `<li class="lvl-cell${ext ? ' ext' : ''}${k === 3 ? ' ext-first' : ''}">${ext ? `<span class="sr">${reachName(k)}</span>` : ''}<span class="lvl-tag"${ext ? ' aria-hidden="true"' : ''}>${k <= 3 ? reachTag(k) : '&nbsp;'}</span>${badge}<span class="lvl-count"><b>${fmt(lvPeople[k])}</b> ${lvPeople[k] === 1 ? 'person' : 'people'}</span><span class="lvl-pass"><b>${fmt(lvSparks[k])}</b> of those shared it</span></li>`;
  }).join('');

  // ---- State ----
  const A = new Float32Array(N), S0 = new Float32Array(N), S1 = new Float32Array(N); // how far in (0..1) and where each person sits on their level's bar
  const cnt = new Int32Array(L + 1), spk = new Int32Array(L + 1), C = new Float32Array(L + 1);
  let T = last, di = last;                       // the day cursor (fractional while playing) and its whole day
  let sel = null, branch = null, cur = null, hov = null;
  let playing = false, raf = 0, timer = 0, prev = 0;
  const ign = (p) => isSpark(p) && di >= kid0[p.id]; // a person turns into a spark once the first person gets it from them
  const can = (p) => ign(p) || (p.ai && A[p.id] >= 1); // what a tap or the arrow keys can pick: a lit spark, or an AI that has opened it

  // ---- Geometry. "c" runs across the levels, "s" runs along a level's bar; the picture is turned on phones. ----
  const canvas = $('stage'), wrap = $('wrap'), ctx = canvas.getContext('2d');
  const UMAX = 34, MINBAR = 6, NEAR = 16;
  let W = 0, H = 0, dpr = 1, vert = false, u = 1, gap = 0, bw = 16, sMin = 0, sMax = 0, align = 0.5, youLen = 16, youS0 = 0, gutter = 0, tagsFit = true, pitchW = 0;
  const maxP = Math.max(...lvAll);

  function fit() {
    const w = wrap.clientWidth;
    if (!w) return;
    W = w; vert = W < 640; dpr = devicePixelRatio || 1;
    root.classList.toggle('vert', vert);
    ctx.font = '600 12px system-ui, sans-serif'; // one row only when each cell holds "of those shared it" (the widest line) with its 20px of padding and 1px divider
    strip.dataset.layout = !vert && W / (L + 1) >= Math.max(100, ctx.measureText(sharedIt(Math.max(...lvSparks))).width + 21) ? 'row' : 'list';
    if (vert) {
      ctx.font = '700 13px system-ui, sans-serif';
      const w1 = ctx.measureText(`${fmt(maxP)} people`).width;
      ctx.font = '600 11px system-ui, sans-serif';
      gutter = Math.ceil(Math.max(w1, ctx.measureText(sharedIt(Math.max(...lvSparks))).width)) + 24;
      sMin = gutter; sMax = W - 14; align = 0;
      u = Math.min(UMAX, (sMax - sMin) / maxP);
      const pitch = clamp(440 / (L + 1), 56, 92);
      bw = clamp(u * 0.9, 14, 28);
      H = Math.round(14 + (L + 1) * pitch + 6);
      for (let k = 0; k <= L; k++) C[k] = 14 + pitch * (k + 0.5);
      pitchW = gutter - 20;
    } else {
      const pitch = W / (L + 1), pad = 38;
      const wb = wrap.getBoundingClientRect(), end = Math.max(...Array.from(document.body.children, (e) => e.getBoundingClientRect().bottom)); // the lowest thing on the page, the header's 1px live region after #spread included
      const below = end - wb.bottom - (strip.dataset.layout === 'row' ? 0 : strip.offsetHeight); // the strip (when one row), card border and page padding under the picture
      const room = innerHeight - Math.ceil(wb.top + scrollY + below); // the whole page fits the first screen
      H = shot ? shotRoom(wrap) - (wrap.parentElement.getBoundingClientRect().bottom - wb.bottom) // the card's bottom border
        : Math.round(Math.min(clamp(room, 300, 560), maxP * UMAX + pad * 2));
      sMin = pad; sMax = H - pad; align = 0.5;
      u = (sMax - sMin) / maxP;
      bw = clamp(pitch * 0.16, 14, 30);
      for (let k = 0; k <= L; k++) C[k] = pitch * (k + 0.5);
      ctx.font = '600 11.5px system-ui, sans-serif'; // the "of those shared it" labels go under every bar or none, so the row never looks half done
      tagsFit = lvSparks.every((n, k) => !k || ctx.measureText(sharedIt(n)).width <= pitch - 8);
      pitchW = pitch - 8;
    }
    u = Math.min(u, UMAX);
    gap = u >= 10 ? 3 : u >= 5 ? 1.5 : 0;
    youLen = clamp(u, 16, 28);
    wrap.style.height = `${H}px`;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    drawSpark(); draw();
  }

  // Where every person sits, for the day cursor. People grow in, so a level's bar grows with them.
  function layout() {
    for (let i = 0; i < N; i++) A[i] = clamp(T - dayOf[i] + 1, 0, 1);
    for (let k = 1; k <= L; k++) {
      let sum = 0, n = 0, sp = 0;
      for (const p of byLevel[k]) { const a = A[p.id]; sum += a; if (a > 0 && !p.ai) { n++; if (ign(p)) sp++; } }
      cnt[k] = n; spk[k] = sp;
      const un = sum * u > 0 && sum * u < MINBAR ? MINBAR / sum : u; // a tiny level keeps a bar you can see
      let off = sMin + (sMax - sMin - sum * un) * align;
      for (const p of byLevel[k]) { const a = A[p.id]; S0[p.id] = off; off += a * un; S1[p.id] = off - gap * a; }
    }
    youS0 = sMin + (sMax - sMin - youLen) * align;
  }

  // A person's slice as [x0, y0, x1, y1] in canvas pixels, never thinner than 2px.
  function box(p, e = 0) {
    const c = C[p.depth], s0 = S0[p.id], s1 = S1[p.id], t = Math.max(0, 2 - (s1 - s0)) / 2, h = bw / 2;
    return vert ? [s0 - t - e, c - h - e, s1 + t + e, c + h + e] : [c - h - e, s0 - t - e, c + h + e, s1 + t + e];
  }
  const youBox = () => { const c = C[0], h = bw / 2; return vert ? [youS0, c - h, youS0 + youLen, c + h] : [c - h, youS0, c + h, youS0 + youLen]; };

  const mv = (c, s) => (vert ? ctx.moveTo(s, c) : ctx.moveTo(c, s));
  const ln = (c, s) => (vert ? ctx.lineTo(s, c) : ctx.lineTo(c, s));
  const bez = (c1, s1, c2, s2, c, s) => (vert ? ctx.bezierCurveTo(s1, c1, s2, c2, s, c) : ctx.bezierCurveTo(c1, s1, c2, s2, c, s));
  function ribbon(fill, ca, a0, a1, cb, b0, b1) {
    if (b1 - b0 < 0.05 || a1 - a0 < 0.05) return;
    const d = (cb - ca) * 0.45;
    ctx.fillStyle = fill;
    ctx.beginPath();
    mv(ca, a0); bez(ca + d, a0, cb - d, b0, cb, b0); ln(cb, b1); bez(cb - d, b1, ca + d, a1, ca, a1);
    ctx.closePath(); ctx.fill();
  }
  const MODES = [[0.52, 0.25, 0.32], [0.85, 0.55, 0.6], [0.1, 0.05, 0.07]]; // plain, lit, dimmed: Gemini's flame to coal fade
  function drawRibbons() {
    for (let k = 0; k < L; k++) {
      const ca = C[k] + bw / 2, cb = C[k + 1] - bw / 2;
      const g = MODES.map(([f0, f1, c1]) => {
        const gr = vert ? ctx.createLinearGradient(0, ca, 0, cb) : ctx.createLinearGradient(ca, 0, cb, 0);
        gr.addColorStop(0, rgba(FLAME, f0)); gr.addColorStop(0.45, rgba(FLAME, f1)); gr.addColorStop(1, rgba(COAL, c1));
        return gr;
      });
      if (k === 0) {
        const row = byLevel[1];
        ribbon(g[branch ? 2 : 0], ca, youS0, youS0 + youLen, cb, S0[row[0].id], S1[row[row.length - 1].id]);
        continue;
      }
      for (const p of byLevel[k]) {
        if (!p.children.length || di < kidAll0[p.id]) continue; // a ribbon to everyone they sent it to, AIs included
        const kids = p.children;
        ribbon(g[branch ? (branch.has(p) ? 1 : 2) : 0], ca, S0[p.id], S1[p.id], cb, S0[kids[0].id], S1[kids[kids.length - 1].id]);
      }
    }
  }

  function shape(p, e = 0) {
    const [x0, y0, x1, y1] = box(p, e);
    if (gap) ctx.roundRect(x0, y0, x1 - x0, y1 - y0, Math.min(5, (x1 - x0) / 2, (y1 - y0) / 2));
    else ctx.rect(x0, y0, x1 - x0, y1 - y0);
  }
  // 0 only read it (coal), 1 spark (flame), 2 an AI (quiet: it never passes anything on)
  const kind = (p) => (ign(p) ? 1 : p.ai ? 2 : 0);
  const LIT = [1, 1, 0.45]; // fill by kind: FILL (theme)
  function drawBars() {
    const each = (test, e = 0) => { ctx.beginPath(); for (let k = 1; k <= L; k++) for (const p of byLevel[k]) if (test(p)) shape(p, e); };
    const inBranch = (p) => !branch || branch.has(p);
    // dimmed people first, then the lit ones; sparks on top with a soft glow
    for (const lit of branch ? [0, 1] : [1]) for (const kd of [2, 0, 1]) {
      const test = (p) => A[p.id] >= 1 && kind(p) === kd && inBranch(p) === !!lit;
      if (kd === 1 && lit) { ctx.globalAlpha = 0.2; ctx.fillStyle = FLAME; each(test, 3); ctx.fill(); }
      ctx.globalAlpha = lit ? LIT[kd] : 0.16 * LIT[kd]; ctx.fillStyle = FILL[kd];
      each(test); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.fillStyle = FLAME; // people who are just arriving flash in flame
    each((p) => A[p.id] > 0 && A[p.id] < 1 && inBranch(p)); ctx.fill();
    const [x0, y0, x1, y1] = youBox();
    ctx.beginPath(); ctx.roundRect(x0, y0, x1 - x0, y1 - y0, Math.min(5, bw / 2, youLen / 2));
    ctx.fillStyle = CREAM; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = FLAME; ctx.stroke();
  }
  function ring(p, e, color, lw) {
    const [x0, y0, x1, y1] = box(p, e);
    ctx.lineWidth = lw; ctx.strokeStyle = color; ctx.beginPath();
    ctx.roundRect(x0, y0, x1 - x0, y1 - y0, gap ? 7 : 2); ctx.stroke();
  }
  // The author's name can be long: cut it with an ellipsis to the room it has.
  function clip(text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  }
  function drawLabels() {
    ctx.textBaseline = 'alphabetic';
    if (vert) {
      ctx.textAlign = 'left';
      ctx.font = '700 13px system-ui, sans-serif'; ctx.fillStyle = CREAM;
      ctx.fillText(clip(youName, pitchW), 12, C[0] + 5);
      if (L >= 4 && cnt[3]) { ctx.fillStyle = rgba(DIM, 0.45); ctx.fillRect(4, C[3] - 21, 1.5, C[L] - C[3] + 25); } // one "Extended" label, a line joins its levels; both wait for level 3's people
      for (let k = 1; k <= L; k++) {
        if (!cnt[k]) continue;
        const cy = C[k];
        ctx.font = '600 11px system-ui, sans-serif'; ctx.fillStyle = DIM; if (k <= 3) ctx.fillText(reachTag(k), 12, cy - 12);
        ctx.font = '700 13px system-ui, sans-serif'; ctx.fillStyle = CREAM; ctx.fillText(people(cnt[k]), 12, cy + 2);
        if (spk[k]) { ctx.font = '600 11px system-ui, sans-serif'; ctx.fillStyle = FLAME; ctx.fillText(sharedIt(spk[k]), 12, cy + 16); }
      }
      return;
    }
    ctx.textAlign = 'center';
    ctx.font = '700 13px system-ui, sans-serif'; ctx.fillStyle = CREAM;
    ctx.fillText(clip(youName, pitchW), C[0], 22);
    for (let k = 1; k <= L; k++) if (cnt[k]) ctx.fillText(fmt(cnt[k]), C[k], 22);
    ctx.font = '600 11.5px system-ui, sans-serif'; ctx.fillStyle = FLAME;
    if (tagsFit) for (let k = 1; k <= L; k++) if (spk[k]) ctx.fillText(sharedIt(spk[k]), C[k], H - 14);
  }
  function draw() {
    if (!W) return;
    layout();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawRibbons(); drawBars();
    if (hov && can(hov)) ring(hov, 3, rgba(FLAME, 0.9), 1.5);
    if (sel && can(sel)) ring(sel, 3, CREAM, 2);
    if (cur && can(cur) && canvas.matches(':focus-visible')) { ring(cur, 6, FLAME, 2); ring(cur, 3, CREAM, 1.5); }
    drawLabels();
  }

  // ---- The scrubber's per-day bars ----
  const spark = $('spark'), track = $('track');
  function drawSpark() {
    const r = spark.getBoundingClientRect();
    if (!r.width) return;
    const w = r.width, h = r.height, d = devicePixelRatio || 1, c = spark.getContext('2d');
    if (spark.width !== Math.round(w * d)) { spark.width = Math.round(w * d); spark.height = Math.round(h * d); }
    c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, w, h);
    const n = last + 1, slot = w / n, bar = Math.min(slot - 2, 28), max = Math.max(...perDay);
    perDay.forEach((v, i) => {
      const bh = Math.max(2, (v / max) * (h - 6));
      c.fillStyle = i <= di ? FLAME : rgba(CREAM, 0.16);
      c.fillRect(i * slot + (slot - bar) / 2, h - bh - 2, bar, bh);
    });
    c.fillStyle = CREAM; c.fillRect(clamp(((T + 1) / n) * w - 1, 0, w - 2), 0, 2, h);
  }

  // ---- Time: scrub, keys, play ----
  let shownDay = -1;
  function setT(v) {
    T = clamp(v, 0, last); di = Math.ceil(T - 1e-6);
    if (di !== shownDay) {
      shownDay = di;
      const who = di === last ? total(P) : people(cum[di]); // "+" only on the last day, where the count stopped
      const text = `Day ${di + 1} · ${dateOf(di)} · ${who}`;
      $('clock').innerHTML = `<span><b>Day ${di + 1}</b> · ${dateOf(di)}</span> · <span>${who}</span>`;
      track.setAttribute('aria-valuenow', di + 1); track.setAttribute('aria-valuemax', last + 1); track.setAttribute('aria-valuetext', text);
    }
    drawSpark(); draw();
  }
  const PLAY = 'M4 2.5l10 5.5-10 5.5z', PAUSE = 'M3.5 2.5h3v11h-3zm6 0h3v11h-3z';
  function ui() { $('play-label').textContent = playing ? 'Pause' : T >= last ? 'Replay' : 'Resume'; $('play-icon').setAttribute('d', playing ? PAUSE : PLAY); }
  function pause() { playing = false; cancelAnimationFrame(raf); clearInterval(timer); ui(); }
  function play() {
    if (T >= last) setT(0);
    if (!last) return ui(); // one day only: nothing to play
    playing = true; ui();
    const rate = last / 8; // day 1 to the last day in about 8 seconds
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      timer = setInterval(() => { setT(Math.floor(T) + 1); if (T >= last) pause(); }, 1000 / rate);
    } else {
      prev = performance.now();
      raf = requestAnimationFrame(function tick(now) {
        setT(T + ((now - prev) / 1000) * rate); prev = now;
        if (T >= last) pause(); else raf = requestAnimationFrame(tick);
      });
    }
  }
  $('play').addEventListener('click', () => (playing ? pause() : play()));
  const dayAt = (e) => { const r = track.getBoundingClientRect(); return clamp(Math.floor(((e.clientX - r.left) / r.width) * (last + 1)), 0, last); };
  let dragging = false;
  track.addEventListener('pointerdown', (e) => { pause(); dragging = true; track.setPointerCapture(e.pointerId); setT(dayAt(e)); ui(); });
  track.addEventListener('pointermove', (e) => { if (dragging) setT(dayAt(e)); });
  track.addEventListener('pointerup', () => { dragging = false; ui(); });
  track.addEventListener('pointercancel', () => { dragging = false; });
  track.addEventListener('keydown', (e) => {
    const to = { ArrowLeft: Math.ceil(T) - 1, ArrowDown: Math.ceil(T) - 1, ArrowRight: Math.floor(T) + 1, ArrowUp: Math.floor(T) + 1, PageDown: Math.round(T) - 7, PageUp: Math.round(T) + 7, Home: 0, End: last }[e.key];
    if (to === undefined) return;
    e.preventDefault(); pause(); setT(to); ui();
  });

  new ResizeObserver(() => { if (wrap.clientWidth !== W) fit(); }).observe(wrap);
  addEventListener('resize', fit);
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { theme(); drawSpark(); draw(); });
  setT(last); ui(); fit();
  addEventListener('DOMContentLoaded', fit, { once: true }); // again once the chips below and the header's live region (deferred shell.js) are in, so the page fits the first screen
  if (!canTab) return; // no sparks and no AIs: nothing to pick

  // ---- Sparks: the top three chips, the card, tapping and keys in the picture ----
  const chipEls = top.map((p) => {
    const b = document.createElement('button');
    const label = pub ? reachName(p.depth) : SHARE.name(p); // public names are all "A reader", which reads as broken three times over
    b.type = 'button'; b.className = 'chip'; b.dataset.id = p.id; b.title = label;
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `${label}, ${people(hr[p.id])} came through them`);
    b.innerHTML = '<i class="chip-dot"></i><span class="chip-name"></span><span class="chip-sep" aria-hidden="true">·</span><span class="chip-n"></span>';
    b.querySelector('.chip-name').textContent = label; b.lastChild.textContent = fmt(hr[p.id]);
    $('chips').append(b);
    return b;
  });
  function select(p) {
    sel = p; branch = null;
    if (p) {
      cur = p; branch = new Set();
      (function walk(x) { branch.add(x); x.children.forEach(walk); })(p);
      if (!can(p)) { pause(); T = last; } // not opened yet on this day: show the whole spread
    }
    chipEls.forEach((b) => b.setAttribute('aria-pressed', String(!!p && +b.dataset.id === p.id)));
    $('sparks-bar').classList.toggle('has-card', !!p);
    root.classList.toggle('picked', !!p);
    if (p) {
      const opened = `Opened ${SHARE.date(p.first_opened)}`, ai = 'An AI read it. AIs don\u2019t share it on.';
      $('card').classList.toggle('is-ai', !!p.ai);
      $('c-came').hidden = !!p.ai;
      $('c-name').textContent = SHARE.name(p);
      $('c-level').textContent = reachName(p.depth);
      if (p.ai) { $('c-sent').textContent = opened; $('c-open').textContent = ai; } // an AI's card: name, level, opened, then why it is grey
      else {
        $('c-sent').innerHTML = `Sent it to <b>${people(hb[p.id])}</b>`;
        $('c-came').innerHTML = `<b>${people(hr[p.id])}</b> came through them`;
        $('c-open').textContent = opened;
      }
      $('live').textContent = p.ai ? `${SHARE.name(p)}, ${reachName(p.depth)}. ${opened}. ${ai}` : `${SHARE.name(p)}, ${reachName(p.depth)}. Sent it to ${people(hb[p.id])}. ${people(hr[p.id])} came through them. ${opened}.`;
    } else $('live').textContent = '';
    setT(T); ui();
    if (p && vert) { // the sheet covers the bottom of the screen: keep the spark and its branch above it (and below a sticky header)
      const cr = canvas.getBoundingClientRect(), floor = innerHeight - $('card').offsetHeight - 24, [, y0, , y1] = box(p), a = cr.top + (y0 + y1) / 2;
      const ceil = Math.max(0, document.querySelector('.sp-bar')?.getBoundingClientRect().bottom ?? 0) + 16;
      let deep = p.depth;
      for (const q of branch) deep = Math.max(deep, q.depth);
      const b = cr.top + C[deep] + bw / 2, by = b > floor ? Math.min(b - floor, a - ceil) : a < ceil ? a - ceil : 0;
      if (by) scrollBy({ top: by, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
  $('chips')?.addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) { const p = flat[+b.dataset.id]; select(p === sel ? null : p); } });
  $('reset').addEventListener('click', () => { canvas.focus({ preventScroll: true }); select(null); }); // focus first: while cur is still sel, the focus handler doesn't pick it again
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && sel) select(null); });

  // The nearest spark or AI within a radius of a point. The slice itself can be thinner than a pixel, so the radius is what you aim with.
  const pickList = [...sparkList, ...aiList], first = top[0] ?? aiList[0];
  function pick(mx, my, radius) {
    let best = null, bd = Infinity, bc = Infinity;
    for (const p of pickList) {
      if (!can(p) || A[p.id] < 0.5) continue;
      const [x0, y0, x1, y1] = box(p);
      const d = Math.hypot(Math.max(x0 - mx, 0, mx - x1), Math.max(y0 - my, 0, my - y1));
      if (d > radius) continue;
      const dc = Math.hypot((x0 + x1) / 2 - mx, (y0 + y1) / 2 - my);
      if (d < bd || (d === bd && dc < bc)) { best = p; bd = d; bc = dc; }
    }
    return best;
  }
  const at = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('click', (e) => {
    const p = pick(...at(e), e.pointerType === 'touch' ? NEAR + 6 : NEAR);
    if (p) select(p === sel ? null : p); else if (sel) select(null);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const p = pick(...at(e), 10);
    canvas.style.cursor = p ? 'pointer' : '';
    if (p !== hov) { hov = p; if (!playing) draw(); }
  });
  canvas.addEventListener('pointerleave', () => { if (hov) { hov = null; if (!playing) draw(); } });
  canvas.addEventListener('focus', () => { cur ??= first; if (canvas.matches(':focus-visible') && can(cur) && cur !== sel) select(cur); else draw(); }); // reaching the picture by keyboard lights the spark with the ring
  canvas.addEventListener('blur', () => draw());
  canvas.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && cur) { e.preventDefault(); select(cur); return; }
    let [across, within] = ({ ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] })[e.key] ?? [];
    if (across === undefined) return;
    e.preventDefault();
    if (vert) [across, within] = [within, across];
    const from = can(cur ?? first) ? (cur ?? first) : first;
    const row = (k) => byLevel[k].filter(can);
    let target = from;
    if (within) { const r = row(from.depth); target = r[clamp(r.indexOf(from) + within, 0, r.length - 1)]; }
    else for (let k = from.depth + across; k >= 1 && k <= L; k += across) {
      const r = row(k);
      if (!r.length) continue;
      const mid = (S0[from.id] + S1[from.id]) / 2;
      target = r.reduce((a, b) => (Math.abs((S0[b.id] + S1[b.id]) / 2 - mid) < Math.abs((S0[a.id] + S1[a.id]) / 2 - mid) ? b : a));
      break;
    }
    select(target);
  });
})();
