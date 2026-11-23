import { CARD_TIERS } from './preview.ts';

// The look of the owner wall (src/wall-view.ts): docs/DESIGN.md's ember world, dark by default and paper in a light browser.
// Amber marks the logo and keyboard focus and nothing else; green and yellow are the page-state lamps only. Text is at least 4.5:1 on its ground in both themes.
export const WALL_CSS = `
:root{color-scheme:dark;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--display:ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--ease:cubic-bezier(.22,1,.36,1);--live:#3ddc6e;--live-ink:#08210f;--bg:#16130f;--surface:#1f1a14;--surface-2:#2a241c;--well:#0f0c09;--ink:#f4eee6;--muted:#d9cdbb;--dim:#b5a894;--line:rgba(244,238,230,.12);--line-strong:rgba(244,238,230,.28);--control:rgba(244,238,230,.42);--wash:rgba(244,238,230,.08);--primary:#f4eee6;--primary-ink:#16130f;--primary-hover:#fff;--danger:#ff8a70;--danger-fill:#c63e27;--danger-ink:#fff;--focus:#f2a541;--draft:#f5c542;--draft-bg:rgba(245,197,66,.1);--draft-ring:rgba(245,197,66,.45);--scrim:rgba(10,8,6,.55);--lift:0 2px 6px rgba(0,0,0,.2),0 24px 48px -16px rgba(0,0,0,.6);--lift-sm:0 2px 6px rgba(0,0,0,.2),0 8px 16px -8px rgba(0,0,0,.5)}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f7f5f2;--surface:#fff;--surface-2:#efebe5;--well:#ece7e0;--ink:#16130f;--muted:#3f362e;--dim:#6b6055;--line:rgba(22,19,15,.1);--line-strong:rgba(22,19,15,.24);--control:rgba(22,19,15,.55);--wash:rgba(22,19,15,.05);--primary:#16130f;--primary-ink:#f4eee6;--primary-hover:#2a241c;--danger:#b42318;--danger-fill:#b42318;--danger-ink:#fff;--focus:#c8611f;--draft:#7a5800;--draft-bg:#fff3c4;--draft-ring:rgba(176,128,0,.45);--scrim:rgba(22,19,15,.35);--lift:0 2px 6px rgba(22,19,15,.08),0 24px 48px -16px rgba(22,19,15,.28);--lift-sm:0 2px 6px rgba(22,19,15,.08),0 8px 16px -8px rgba(22,19,15,.28)}}
*{box-sizing:border-box}
html{background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans);-webkit-text-size-adjust:100%;scrollbar-color:var(--surface-2) var(--bg);scrollbar-gutter:stable;-webkit-tap-highlight-color:transparent}
html:has(.sheet){overflow:hidden}
body{margin:0;min-height:100vh}
h1,h2,h3,h4,p,ol,ul,dl,dd,figure{margin:0}
ol,ul{padding:0;list-style:none}
h1,h2,h3{text-wrap:balance}
[hidden]{display:none!important}
::selection{background:var(--ink);color:var(--bg)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
[tabindex="-1"]:focus{outline:0}
button,input,select,textarea{font:inherit;color:inherit}
a{color:inherit;text-underline-offset:3px}
fieldset,legend{margin:0;padding:0;border:0}
.num{font-variant-numeric:tabular-nums}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.ic{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}

/* App bar: logo, product, account. */
.appbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:10px;height:56px;padding:0 12px 0 16px;background:var(--bg);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font:700 16px/1 var(--display);letter-spacing:-.01em;text-decoration:none}
.brand svg{width:26px;height:26px}
.who{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--dim);font-size:13px}
.avatar{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--surface-2);color:var(--ink);font:700 13px/1 var(--sans)}

/* Lamps: page state, as on the viewer's bar. */
.lamp{display:inline-flex;align-items:center;flex:none;height:24px;padding:0 9px;border-radius:4px;font:800 10.5px/1 var(--sans);letter-spacing:.12em;text-transform:uppercase;white-space:nowrap}
.lamp.live{background:var(--live);color:var(--live-ink)}
.lamp.draft{background:var(--draft-bg);color:var(--draft);box-shadow:inset 0 0 0 1.5px var(--draft-ring)}

/* Buttons: <button>, <a> and <summary> alike. */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;height:36px;padding:0 14px;border:0;border-radius:8px;background:transparent;color:inherit;font:600 14px/1 var(--sans);white-space:nowrap;text-decoration:none;list-style:none;cursor:pointer;transition:background-color .15s,box-shadow .15s,color .15s}
summary.btn::-webkit-details-marker{display:none}
.btn.primary{background:var(--primary);color:var(--primary-ink)}
.btn.primary:hover{background:var(--primary-hover)}
.btn.ghost{box-shadow:inset 0 0 0 1px var(--line-strong)}
.btn.ghost:hover,.btn.quiet:hover{background:var(--wash)}
.btn.danger{background:var(--danger-fill);color:var(--danger-ink)}
.btn.danger:hover{filter:brightness(1.08)}
.btn.small{height:30px;padding:0 10px;font-size:13px}
.btn.icon{width:36px;padding:0}
.btn.small.icon{width:30px}
.btn:disabled{opacity:.5;pointer-events:none}
.link-danger{color:var(--danger)}

/* Inputs. */
.label{display:block;font-weight:600;font-size:14px}
.hint{color:var(--dim);font-size:13px;line-height:1.45}
.input{display:block;width:100%;height:40px;padding:0 12px;border:0;border-radius:8px;background:var(--well);box-shadow:inset 0 0 0 1px var(--control);caret-color:var(--focus)}
textarea.input{height:auto;min-height:72px;padding:10px 12px;line-height:1.45;resize:vertical}
.input::placeholder{color:var(--dim)}
.input:focus-visible{outline:0;box-shadow:inset 0 0 0 2px var(--focus)}
.input[aria-invalid=true]{box-shadow:inset 0 0 0 1.5px var(--danger)}

/* Choice cards: who can open it. */
.opts{display:grid;gap:8px}
.hero .opts{margin-top:10px}
.choice{display:flex;align-items:flex-start;gap:10px;width:100%;padding:12px;border:0;border-radius:10px;background:none;color:inherit;text-align:left;box-shadow:inset 0 0 0 1px var(--line-strong);cursor:pointer}
.choice:has(input[name=access]:checked),.choice.on{box-shadow:inset 0 0 0 2px var(--ink);background:var(--wash)}
.choice.on{cursor:default}
button.choice:hover{background:var(--wash)}
.choice input{margin:3px 0 0;accent-color:var(--ink)}
.ct{display:block;min-width:0}
.ct b{display:block;font-weight:600}
.ct small{display:block;color:var(--dim);font-size:13px;line-height:1.45}
.tag{flex:none;margin:1px 0 0 auto;color:var(--dim);font-size:12.5px;font-weight:600}
.choice.on .tag{color:var(--ink)}
/* The link card's sharing boxes: under its text, the second only once the first is ticked; in the publish form only while the card is chosen. 23px = the radio (13px) and the gap (10px), so the boxes line up with the card's text. */
.choice.lk{flex-direction:column;gap:0;cursor:default}
.cl,.ck{display:flex;align-items:flex-start;gap:10px;cursor:pointer}
.shr{display:grid;gap:12px;margin:12px 0 0 23px}
.choice.on{flex-wrap:wrap;row-gap:0}
.choice.on>.ct{flex:1 1 0}
.shf{flex-basis:100%}
.shf .shr{margin-left:0}
.shf .btn{margin-top:12px}
.shf .nf{margin-top:12px}
.spf{margin-top:16px}
.ck.askmail{margin-left:23px}
.shr .askmail{display:none}
.shr:has(input[value=links]:checked) .askmail{display:flex}
.pub .choice:not(:has(input[name=access]:checked)) .shr{display:none}
@supports not selector(:has(*)){.shr .askmail{display:flex}}

/* Remembered emails to tick, beside a box to type more. */
.picks{min-width:0;margin:0 0 10px}
.picks legend{margin-bottom:6px;color:var(--dim);font-size:13px}
.picks div{display:flex;flex-wrap:wrap;gap:6px}
.pick{position:relative;display:inline-flex;min-width:0}
.pick input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.pick span{display:inline-flex;align-items:center;max-width:100%;height:32px;padding:0 12px;border-radius:16px;background:var(--wash);box-shadow:inset 0 0 0 1px var(--control);font-size:13.5px;overflow-wrap:anywhere}
.pick input:checked+span{background:var(--primary);color:var(--primary-ink);box-shadow:none}
.pick .ic{display:none;width:15px;height:15px;margin:0 6px 0 -2px;stroke-width:2.25}
.pick input:checked+span .ic{display:block}
.pick input:focus-visible+span{outline:2px solid var(--focus);outline-offset:2px}

/* The wall. */
.wrap{max-width:1180px;margin:0 auto;padding:32px 20px 40px}
.top{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px 16px;margin-bottom:24px}
h1{font:700 30px/1.15 var(--display);letter-spacing:-.015em}
.sum{margin-top:6px;color:var(--dim)}
.tools{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;margin-bottom:20px}
.seg{display:inline-flex;gap:2px;padding:3px;border-radius:10px;background:var(--surface-2)}
.seg a{display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:7px;color:var(--muted);font:600 13px/1 var(--sans);white-space:nowrap;text-decoration:none}
.seg a:hover{background:var(--wash);color:var(--ink)}
.seg a[aria-current]{background:var(--primary);color:var(--primary-ink)}
.find{position:relative;flex:1 1 220px;max-width:340px;margin-left:auto}
.find button{position:absolute;left:2px;top:0;display:grid;place-items:center;width:38px;height:100%;padding:0;border:0;border-radius:8px;background:none;color:var(--dim);cursor:pointer}
.find .input{padding-left:38px}
.found{margin:-8px 0 16px;color:var(--dim);font-size:13px}
.muted{color:var(--muted)}
.empty{display:grid;justify-items:start;gap:14px;padding:32px 0;color:var(--muted)}
.empty p{overflow-wrap:anywhere}
.empty b{color:var(--ink)}
.status{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin:0 0 16px;padding:9px 10px 9px 12px;border-radius:10px;background:var(--wash);box-shadow:inset 0 0 0 1px var(--line);font-size:14px;line-height:1.4;text-wrap:pretty}
.status>span{flex:1 1 180px;min-width:0;overflow-wrap:anywhere}
.status.bad{color:var(--danger);box-shadow:inset 0 0 0 1.5px var(--danger)}
.status form{display:contents}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.grid>li{display:flex;min-width:0}
.tile{position:relative;display:flex;flex:1;flex-direction:column;min-width:0;border-radius:14px;background:var(--surface);overflow:hidden;color:inherit;text-decoration:none;scroll-margin-top:80px;transition:background-color .15s}
.tile::after,.hero::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--line);pointer-events:none;transition:box-shadow .15s}
.tile:hover{background:var(--surface-2)}
.tile:hover::after{box-shadow:inset 0 0 0 1px var(--line-strong)}
.pv{position:relative;display:block;aspect-ratio:16/10;background:var(--surface-2);overflow:hidden}
.pv img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;object-position:left top}
/* The drawn card, as selfhost/title-card.ts draws the link preview's at 1200 px wide, in cqw of its own box (1cqw = 12 px there): it is on every page's picture, under its screenshot. The ground is the card's, dark in either theme. */
.dc{position:absolute;inset:0;display:block;container-type:inline-size;overflow:hidden}
.dc-i{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;padding:6cqw 6.67cqw;background:#16130f radial-gradient(circle at 100% 100%,rgba(242,165,65,.22),rgba(242,165,65,0) 55%);color:#f4eee6;font-family:var(--sans);font-weight:700}
.dc-t{display:flex;flex:1;align-items:center;min-height:0}
.dc-t>span{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;line-height:1.12;letter-spacing:-.025em;overflow-wrap:anywhere}
${CARD_TIERS.map((tier, i) => `.c${i} .dc-t>span{font-size:${(tier.size / 12).toFixed(2)}cqw;-webkit-line-clamp:${tier.lines};line-clamp:${tier.lines}${tier.balance ? ';text-wrap:balance' : ''}}`).join('\n')}
.dc-m{display:flex;align-items:center;gap:1.33cqw;color:#b5a894;font-size:2.83cqw;letter-spacing:-.01em}
.dc-m svg{width:4.33cqw;height:4.33cqw;margin-left:-.33cqw}
.ask{position:absolute;top:10px;right:10px;z-index:1;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px 0 8px;border-radius:13px;background:var(--ink);color:var(--bg);font:700 12.5px/1 var(--sans)}
.ask .ic{width:14px;height:14px}
.tx{display:flex;flex:1;flex-direction:column;gap:8px;padding:14px 16px 16px}
.ti{font-weight:600;font-size:16px;line-height:1.3;overflow-wrap:anywhere;text-wrap:balance}
.st{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;color:var(--muted);font-size:13.5px}
.mt{display:grid;gap:2px;margin-top:auto;padding-top:2px;color:var(--dim);font-size:13px}

/* Selecting pages to delete: a round tick on the corner of each tile's picture, faint at rest (full on hover, focus, once one is ticked, and on touch screens), and a bar at the foot once one is ticked.
   The tick sits on any picture, so its colours are its own, not the theme's: a white ring that a dark halo and a darker centre keep readable on light pictures, as the ring is on dark ones.
   The bar's words sit 16px from both ends: 16px of padding before the count, and 6px after the quiet Delete, whose word is 10px inside its box. */
.grid>li{position:relative}
#pick{display:flex;flex-direction:column}
.sel{position:absolute;top:6px;left:6px;z-index:2;display:grid;place-items:center;width:34px;height:34px;cursor:pointer;opacity:.7;transition:opacity .15s}
.sel::after{content:"";position:absolute;inset:-5px}
.grid>li:hover .sel,.sel:focus-within,#pick:has(.sel input:checked) .sel{opacity:1}
@media (hover:none){.sel{opacity:1}}
.sel input,.selbar .ck input{appearance:none;display:grid;place-content:center;margin:0;border-radius:50%;cursor:pointer}
.sel input{--ring:#fff;--halo:0 0 0 1px rgba(22,19,15,.6);width:26px;height:26px;background:rgba(22,19,15,.38);box-shadow:inset 0 0 0 2px var(--ring),var(--halo)}
.sel input::after,.selbar .ck input::after{content:"";width:6px;height:11px;border:solid #f4eee6;border-width:0 2.5px 2.5px 0;transform:translate(-.5px,-2.65px) rotate(45deg);opacity:0}
.sel input:checked{--ring:#f4eee6;background:#16130f}
.sel input:checked::after,.selbar .ck input:checked::after,.selbar .ck input:indeterminate::after{opacity:1}
.sel input:focus-visible{--halo:0 0 0 2px #16130f;outline:3px solid var(--focus);outline-offset:2px}
.grid>li:has(.sel input:checked) .tile::after{box-shadow:inset 0 0 0 2px var(--ink)}
.selbar{order:1;position:sticky;bottom:16px;z-index:20;display:none;flex-wrap:wrap;align-items:center;gap:8px;width:fit-content;max-width:100%;margin:20px auto 0;padding:8px 6px 8px 16px;border-radius:12px;background:var(--surface-2);box-shadow:var(--lift-sm);font-size:14px}
#pick:has(.sel input:checked) .selbar{display:flex}
.selbar #picked{min-width:10ch;font-weight:600;white-space:nowrap}
.selbar .acts{margin:0 0 0 auto}
/* Select all: the ticks' round box in the theme's ink, a dash while only some are ticked; its target is 40px tall or more: the label plus its ::after, which goes behind the bar's buttons where the bar wraps. */
.selbar .ck{position:relative;align-items:center;gap:8px;margin-left:8px;white-space:nowrap}
.selbar .ck::after{content:"";position:absolute;inset:-10px -8px;z-index:-1}
.selbar .ck input{width:22px;height:22px;background:none;box-shadow:inset 0 0 0 2px var(--ink)}
.selbar .ck input::after{border-color:var(--bg)}
.selbar .ck input:checked,.selbar .ck input:indeterminate{background:var(--ink)}
.selbar .ck input:indeterminate::after{width:10px;height:0;border-width:0 0 2.5px;transform:none}
.selbar .sp{flex:1 0 8px}
.dm-live{display:none}
#pick:has([data-live]:checked) .dm-live{display:block}
#pick:has([data-live]:checked) .dm-drafts{display:none}
@supports not selector(:has(*)){.selbar{display:flex}.dm-live{display:block}.sel{opacity:1}}

/* One draft: the whole screen. */
.hero{position:relative;display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);border-radius:18px;background:var(--surface)}
.hero-pv{display:block;border-radius:18px 0 0 18px;overflow:hidden;scroll-margin-top:80px}
.hero-pv .pv{aspect-ratio:auto;height:100%;min-height:280px}
.hero-b{display:flex;flex-direction:column;gap:18px;padding:28px}
.hero h2{margin-bottom:10px;font:700 24px/1.2 var(--display);letter-spacing:-.01em;overflow-wrap:anywhere}
.made{color:var(--muted);font-size:15px}
.alt{display:flex;flex-wrap:wrap;gap:8px}
.alt .link-danger{margin:0 -14px 0 auto}

/* First run: pages are made by asking an AI. */
.first{display:grid;gap:18px;max-width:640px;padding:4px 0 24px}
.first h2{font:700 24px/1.25 var(--display);letter-spacing:-.01em}
.paste{display:flex;align-items:center;gap:12px;padding:8px 8px 8px 16px;border-radius:12px;background:var(--well);box-shadow:inset 0 0 0 1px var(--control)}
.paste code{flex:1;min-width:0;padding:6px 0;font:500 14.5px/1.45 ui-monospace,"SF Mono",Menlo,Consolas,monospace;overflow-wrap:anywhere;user-select:all}
.steps{display:grid;gap:8px;padding-left:20px;list-style:decimal;color:var(--muted)}
.steps .hint{margin-top:4px}

/* The side sheet: everything about one page, over the wall. */
.scrim{position:fixed;inset:0;z-index:40;background:var(--scrim)}
.scrim a{position:absolute;inset:0}
.sheet{position:fixed;z-index:50;top:0;right:0;bottom:0;display:flex;flex-direction:column;width:460px;max-width:100%;background:var(--surface);box-shadow:var(--lift)}
.btn.x{position:absolute;top:12px;right:12px;z-index:2;width:40px;height:40px;background:var(--ink);color:var(--bg)}
.btn.x:hover{background:var(--primary-hover)}
.sbody{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.saved{position:absolute;left:16px;right:16px;bottom:calc(100% + 12px);z-index:3;width:fit-content;margin:0 auto;padding:10px 14px;border-radius:12px;background:var(--ink);color:var(--bg);box-shadow:var(--lift);font-size:14px;line-height:1.4;text-align:center;pointer-events:none;opacity:0;transform:translateY(6px);transition:opacity .2s var(--ease),transform .2s var(--ease)}
.saved.on{opacity:1;transform:none}
/* The pencil stands under the Close button's middle, not at the column's edge: --gx is the gutter, and the pencil's right edge is --pr in from the sheet's edge (Close's 12px, and 5px more on each side because its 40px square is wider than the pencil's 30px), and the title stops 12px short of the pencil at every size (--pw, its width). A classic scrollbar (--sbar, set by public/manage.js) narrows the body but not the sheet, so --pin, the pencil's offset from the column, takes it back out; where the scrollbar is wider than --pr the pencil stays clear of it instead. Focus on a title taller than the body would scroll it to its own top: its scroll margin, as tall as the body's top padding or more, keeps the body at its top. */
.sb{--gx:24px;--pr:17px;--pw:30px;--pin:calc(max(var(--pr),var(--sbar,0px)) - var(--sbar,0px) - var(--gx));padding:60px var(--gx) 32px}
.ttl{position:relative;margin:0 0 4px}
.nm{min-width:0;padding-right:calc(var(--pw) + var(--pin) + 12px);scroll-margin-top:70px;font:700 22px/1.25 var(--display);letter-spacing:-.01em;overflow-wrap:anywhere}
.rn>summary{position:absolute;top:-3px;right:var(--pin);scroll-margin-top:64px} /* focus never leaves it under Close */
.rn>summary:focus-visible{outline-offset:clamp(-2px,var(--pin) + var(--gx) - 2px,2px)} /* outside as everywhere, unless a classic scrollbar stands too close: the body clips what reaches under it, so the ring moves in by what is missing */
.rnf{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.rnf .input{flex:1 1 180px;min-width:0}
.rnf .btn{height:40px}
.sb>.status{margin-top:16px;scroll-margin-bottom:12px}
.sec{padding:22px 0;border-top:1px solid var(--line)}
.sb>section:first-of-type{padding-top:12px;border-top:0}
.sec h3{margin-bottom:12px;font:700 15px/1.3 var(--sans)}
.sec .hint{margin-top:8px}
.ef,.nf{margin-top:16px}
.ef .hint,.nf .hint{margin:2px 0 8px}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.fgf .acts,.rnf .acts{margin-top:0}
.url{margin-top:10px;color:var(--dim);font-size:13.5px;overflow-wrap:anywhere;user-select:all}
.pub .ef,.pub .nf{display:none}
.pub:has(input[value=approval]:checked) .ef,.pub:has(input[value=link]:checked) .nf{display:block}
@supports not selector(:has(*)){.pub .ef,.pub .nf{display:block}}
.grp+.grp{margin-top:20px}
.gh{margin-bottom:2px;font:600 14px/1.3 var(--sans);color:var(--muted)}
.pr{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;padding:10px 0;border-top:1px solid var(--line)}
.pi{display:grid;min-width:0;gap:1px}
.em{font-weight:500;overflow-wrap:anywhere}
.sub{color:var(--dim);font-size:13px;overflow-wrap:anywhere}
.pa{display:flex;gap:4px}
.more{margin-top:20px}
.more .label{margin-bottom:8px}
.grp+.more{margin-top:24px}
.vs b{font-weight:700}
.bars{display:flex;gap:6px;align-items:flex-end;height:96px;margin:14px 0 4px}
.bars li{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;min-width:0;height:100%}
.bars .n{font-size:12px;color:var(--muted)}
.bars .b{display:block;width:100%;max-width:34px;border-radius:4px 4px 2px 2px;background:var(--line-strong)}
.bars li:last-child .b{background:var(--ink)}
.bars .d{font-size:11.5px;color:var(--dim);white-space:nowrap}
/* Unpublish and Delete stay at the sheet's foot, in reach however long the sheet is; the note of a background save (.saved) floats just above them. */
.sfoot{position:relative;display:flex;flex:none;flex-wrap:wrap;gap:8px 12px;padding:12px 24px max(12px,env(safe-area-inset-bottom));border-top:1px solid var(--line)}
.sfoot .link-danger{margin:0 -14px 0 auto}
.bkn{margin:16px 0 4px}
.bk{position:relative;padding:10px 0;border-top:1px solid var(--line)}
.bk .pi{padding-right:96px}
.fg>summary{position:absolute;top:6px;right:0}
.fgf{display:grid;gap:12px;margin-top:10px;padding:14px;border-radius:10px;background:var(--wash)}
.check{display:flex;gap:10px;font-size:14px;cursor:pointer}
.check input{margin:3px 0 0;accent-color:var(--danger-fill)}

/* Delete's confirm dialog. */
.dlg{width:min(440px,calc(100% - 32px));max-width:none;padding:22px 22px 18px;border:0;border-radius:16px;background:var(--surface);color:var(--ink);box-shadow:var(--lift)}
.dlg::backdrop{background:var(--scrim)}
/* On a short screen (a phone held sideways) the browser caps the dialog's height: the heading, the sentence, the word box and the buttons keep their place, and the titles scroll, down to one row. Only if even that does not fit does the body between the heading and the word box scroll as a whole. */
.dlg[open],.dlg form{display:flex;flex-direction:column}
.dlg form{flex:1 1 auto;min-height:0}
.dlg-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
.dlg h2{margin-bottom:8px;font:700 18px/1.25 var(--sans);overflow-wrap:anywhere}
.dlg p{color:var(--muted)}
.dlg .nw{white-space:nowrap}
.dlg .row{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}
.dlg-note{margin-top:12px;font-size:14px;line-height:1.4;text-wrap:balance}
.dlg-note:empty{margin:0}
.dlg .label{margin:16px 0 8px}
.dlg .input{font-size:16px}
/* More rows below show as a fade at the window's foot, which a phone has no scrollbar to say: the first layer is the dialog's own colour (local: it rides the last 12px of the list) and hides the second, a dim gradient fixed to the window, once the end is in view. The gradient stands 1px up from the foot, so that where the two round differently (at 3x, say) a hairline of it does not show under the colour. */
.dm-list{margin:0 0 14px;min-height:25px;overflow:auto;overscroll-behavior:contain;font-size:14px;background:linear-gradient(var(--surface),var(--surface)) bottom/100% 12px no-repeat local,linear-gradient(transparent,var(--line-strong)) left bottom 1px/100% 8px no-repeat}
.dm-list li{padding:4px 0;overflow-wrap:anywhere}
.dm-list li+li{border-top:1px solid var(--line)}
.dm-list li:first-child{padding-top:0}
.dm-list li:last-child{padding-bottom:0}
.dm-list .pb{font:800 10.5px/1 var(--sans);letter-spacing:.12em;text-transform:uppercase;white-space:nowrap;color:var(--danger)}
.dm-list .dm-more{color:var(--dim)}
/* A phone held sideways leaves the dialog little height: the gaps close up and the dialog may stand 8px from the edges (the browser's own cap leaves 18px), so the list keeps its room. */
@media (max-height:480px){.dlg{max-height:calc(100% - 16px);padding:14px 20px 12px}.dlg h2{margin-bottom:4px}.dlg .row{margin-top:10px}.dlg .label{margin:8px 0 4px}}

@keyframes slide{from{transform:translateX(100%)}}
@keyframes slide-out{to{transform:translateX(100%)}}
@keyframes fade{from{opacity:0}}
@keyframes fade-out{to{opacity:0}}
.enter .sheet{animation:slide .28s var(--ease)}
.enter .scrim{animation:fade .28s var(--ease)}
/* The panel on a page's view slides away as it slid in (public/manage.js adds .out, then hides it once these end); after .enter so it wins, and it rests off-screen until then. Quicker than it came, and accelerating: it is leaving. */
.out .sheet{animation:slide-out .22s cubic-bezier(.4,0,1,1) forwards}
.out .scrim{animation:fade-out .22s cubic-bezier(.4,0,1,1) forwards}
/* A panel button whose request is on its way (public/manage.js): the click shows. */
button[aria-busy=true]{opacity:.55;cursor:progress}
/* Except a delete dialog's Yes: its new word, "Deleting…", says it is busy, and at .55 the white on its brick would be under 3.3:1 (it is 6.6:1 in the light and 5.1:1 in the dark at full strength). */
.dlg .btn.danger[aria-busy=true]{opacity:1}
/* The sheet's way out to the viewer and back (public/manage.js, public/takeover.js): one cover in the viewer's ember, grown from the sheet over the screen, shrunk back into it on return.
   Each rests in its end state, so with reduced motion (no animations) it is a plain switch. */
.leaving body::after,.returning body::after{content:"";position:fixed;inset:0;z-index:100;clip-path:inset(0);background:#16130f}
.leaving body::after{animation:cover .3s var(--ease)}
.returning body::after{opacity:0;pointer-events:none;animation:uncover .42s var(--ease)}
.returning .sheet,.returning .scrim{animation:none}
@keyframes cover{from{clip-path:inset(0 0 0 calc(100% - 460px));background:var(--surface);opacity:0}35%{opacity:1}}
@keyframes uncover{from{opacity:1}60%{opacity:1}to{clip-path:inset(0 0 0 calc(100% - 460px));background:var(--surface);opacity:0}}

@media (max-width:760px){
  .hero{grid-template-columns:1fr}
  .hero-pv{border-radius:18px 18px 0 0}
  .hero-pv .pv{height:auto;min-height:0;aspect-ratio:16/10}
}
@media (max-width:640px){
  .sheet{left:0;width:auto;max-width:none}
  @keyframes slide{from{transform:translateY(100%)}}
  @keyframes slide-out{to{transform:translateY(100%)}}
  /* The sheet is the whole screen here, so the cover only changes its colour. */
  @keyframes cover{from{background:var(--surface);opacity:0}35%{opacity:1}}
  @keyframes uncover{from{opacity:1}60%{opacity:1}to{background:var(--surface);opacity:0}}
  .sb{--gx:18px;padding:60px var(--gx) 28px}
  .sfoot{padding-left:18px;padding-right:18px}
}
@media (max-width:600px){
  .wrap{padding:22px 16px 32px}
  h1{font-size:26px}
  .mail{display:none}
  .seg{display:flex;width:100%}
  .seg a{flex:1 1 auto;justify-content:center;padding:0 10px}
  .find{flex-basis:100%;max-width:none}
  .paste{flex-direction:column;align-items:stretch;padding:14px}
  .hero-b{padding:20px 18px 22px}
  .pr .pa{flex:1;justify-content:flex-end}
  .pr .pa:has(form+form){flex-basis:100%}
  .pr .pa form:not(:only-child),.pr .pa form:not(:only-child) .btn{flex:1}
  .selbar{width:100%;bottom:max(12px,env(safe-area-inset-bottom))}
  .selbar #picked{min-width:0}
}
/* Thumb sizes (docs/DESIGN.md, The Thumb Rule) go with the phone either way up: under 600px wide, or under 480px tall, a phone held sideways. The two buttons placed by hand, the pencil over the title and Forget over a row, are placed for their new size here too: their middles stay where the text's are, and the pencil's stays under the Close button's (both are 44px, so its right edge is 12px in from the sheet's edge, as Close's is). The pencil's 44px square would reach up under the Close button's, so the sheet's body starts 10px lower (with room for the pencil's focus ring too). Forget keeps its 6px under the row's hairline, as at 30px tall, and the row gets the 5px its middle drops, above and below. Rename's Save and Cancel are the field's 44px, not the small buttons' 40px, so the row is even. */
@media (max-width:600px),(max-height:480px){
  .btn{height:44px}
  .btn.small{height:40px}
  .btn.icon,.btn.small.icon{width:44px}
  .btn.small.icon{height:44px}
  .btn.x{width:44px;height:44px}
  .seg a{height:40px}
  .input{height:44px}
  textarea.input{height:auto}
  .find button{width:44px}
  .find .input{padding-left:44px}
  .pick span{height:40px;border-radius:20px}
  .dlg .row{flex-wrap:wrap}
  .dlg .row .btn{flex:1 1 0;min-width:fit-content} /* equal halves while both fit; a long one ("Delete group and 120 pages") takes a row of its own */
  .rn>summary{top:-9px}
  .sb{--pr:12px;--pw:44px}
  .rnf .btn{height:44px}
  .sb{padding-top:70px}
  .bk{padding:15px 0}
}
/* On a narrow phone the bar fits one row, down to 320px: Select all is the round box alone, a 44px target, and its words stay for screen readers; the spacer and the box's margin give the room. */
@media (max-width:420px){.selbar .ck{margin-left:0}.selbar .ck>span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.selbar .ck::after{inset:-11px}.selbar .sp{flex-basis:0}}
/* Groups (docs/SPEC.md "Page groups"). A group is one more tile on the wall: a folder on a dark well with its newest three pages fanned out of it. Sizes in cqw so the folder keeps its shape from phone to desktop. */
.err{color:var(--danger);font-size:13.5px;line-height:1.45}
.dlg .choice:has(input:checked){box-shadow:inset 0 0 0 2px var(--ink);background:var(--wash)}
.dlg .dlg-body>p:first-child{margin-bottom:4px}
.dlg .opts{margin-top:4px}
.mt .in{display:inline-flex;align-items:flex-start;gap:6px;color:var(--muted);font-weight:600}
.mt .in .ic{flex:none;width:15px;height:15px;margin-top:2px}
#pick>*{min-width:0}
/* The bar's three buttons sit at its right end; when they wrap onto a row of their own (a phone, or long words), they run edge to edge in equal widths, as far as the bar's corners allow. The spacer takes a shared row's room, so they grow only on their own row. */
.selbar .acts{display:flex;flex:1 0 auto;justify-content:flex-end;gap:6px;margin:0 0 0 -10px}
.selbar .sp{flex-grow:1000}
.selbar .acts .btn{flex:1 1 0;min-width:max-content}
/* Up to 380px a third of a wrapped row is narrower than Move to… at the usual padding, so the three get less: equal widths down to 350px. */
@media (max-width:380px){.selbar .acts .btn{gap:4px;padding:0 6px}}
/* Under 350px a third of the row is narrower than Move to… with its icon, so the three are words alone (Clear has none), and stay equal. */
@media (max-width:350px){.selbar .acts .ic{display:none}}
/* A drop target while a page is dragged over it. */
.dragging [data-drop]{transition:box-shadow .12s,background-color .12s}
[data-drop].over{background:var(--wash)!important;box-shadow:inset 0 0 0 2px var(--focus)!important}
.tile[data-drop].over::after{box-shadow:inset 0 0 0 2px var(--focus)}
/* Fanned stack cover (the folder on the wall, and the Move dialog): up to three pictures, the newest on top and straight, the older ones tilted behind; a page with no picture is a blank sheet. */
.fan{position:relative;display:block;flex:none;width:var(--fw,120px);height:calc(var(--fw,120px) * .625)}
.fan:not(.bare)>*{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:left top;border-radius:calc(var(--fw,120px)/18);background:var(--surface);box-shadow:0 0 0 1px var(--line-strong),0 4px 10px rgba(0,0,0,.25)}
.fan.f3>:nth-child(1){transform:translate(14%,-8%) rotate(7deg) scale(.86)}
.fan.f3>:nth-child(2),.fan.f2>:nth-child(1){transform:translate(7%,-4%) rotate(3.5deg) scale(.93)}
.fan.bare{display:grid;place-items:center;border-radius:calc(var(--fw,120px)/18);box-shadow:inset 0 0 0 1.5px var(--line-strong);color:var(--dim)}
.fan.mini{--fw:56px}
.fan.bare.mini .ic{width:22px;height:22px}
.gtile{box-shadow:0 6px 0 -3px var(--surface),0 6px 0 -2px var(--line-strong),0 12px 0 -6px var(--surface),0 12px 0 -5px var(--line)}
.pv.gpv{container-type:inline-size;background:var(--well)}
.fold{position:absolute;left:12cqw;right:12cqw;top:9cqw;bottom:0}
.fold .fb,.fold .ff{position:absolute;left:0;right:0}
.fold .fb{top:0;bottom:0;border-radius:0 2.4cqw 0 0;background:color-mix(in srgb,var(--ink) 14%,var(--surface-2))}
.fold .fb::before{content:"";position:absolute;left:0;bottom:100%;width:32%;height:4.5cqw;border-radius:2cqw 2cqw 0 0;background:inherit}
.fold .fan{--fw:56cqw;position:absolute;left:10cqw;top:4.5cqw}
/* The tilted sheets stick out to the right: shift the stack left by half of that, so the whole stack sits centred in the folder. */
.fold .fan.f2{left:8.7cqw}
.fold .fan.f3{left:7.2cqw}
.fold .fan>*{border-radius:1.2cqw}
.fold .ff{bottom:0;height:22cqw;border-radius:2.4cqw 2.4cqw 0 0;background:color-mix(in srgb,var(--ink) 22%,var(--surface-2));box-shadow:0 -1px 0 color-mix(in srgb,var(--ink) 30%,transparent),0 -3cqw 6cqw -2cqw rgba(0,0,0,.35)}
.gl{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px 0 7px;border-radius:4px;box-shadow:inset 0 0 0 1.5px var(--line-strong);color:var(--muted);font:800 10.5px/1 var(--sans);letter-spacing:.12em;text-transform:uppercase}
.gl .ic{width:14px;height:14px;stroke-width:2}
/* Inside a group the heading is the way back: "Your pages › Group name", with "Your pages" a link in the heading's own size, so it is the biggest thing to press, where a file manager puts it. */
.trail{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;overflow-wrap:anywhere}
.trail .up{margin:0 -6px;padding:0 6px;border-radius:8px;color:var(--dim);text-decoration:underline 2px var(--line-strong);text-underline-offset:6px}
.trail .up:hover{background:var(--wash);color:var(--ink);text-decoration-color:currentColor}
.trail .up.over{box-shadow:inset 0 0 0 2px var(--focus)}
.trail>.ic{flex:none;width:22px;height:22px;color:var(--dim);stroke-width:2.25}
.gacts{display:flex;flex-wrap:wrap;gap:8px}
/* On the narrowest phones the head's buttons fill their row, or each its own when they wrap, so their edges line up. */
@media (max-width:360px){.top .gacts>.btn{flex:1 1 auto}}
/* The Move dialog's list: each choice a group with its cover. The name box only with "A new group" picked; Delete group's word only with "Delete its pages too". */
/* The scrollbar (--sb, measured by public/manage.js) hangs outside the column, in the dialog's padding: the cards' edges line up with the search box and the Name box. The body reaches out as far, or it would scroll sideways. */
.mvl{max-height:min(46vh,360px);overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:8px 2px 4px;margin:0 calc(-2px - var(--sb,0px)) 0 -2px}
#move .dlg-body{margin-right:calc(-2px - var(--sb,0px));padding-right:calc(2px + var(--sb,0px))}
.choice.mv{align-items:center;gap:14px}
.choice.mv input{margin:0}
@media (max-width:420px){.fan.mini{--fw:40px}.fan.bare.mini .ic{width:18px;height:18px}.choice.mv{gap:10px}}
.newname{display:none;margin-top:4px}
#move:has(input[name=to][value=new]:checked) .newname{display:block}
.typed{display:none;margin-top:12px}
#delete-group:has(input[name=how][value=delete]:checked) .typed{display:block}
@supports not selector(:has(*)){.newname,.typed{display:block}}
/* Find a group, at the top of the Move dialog when there are more than five. With it, the list and the Name box share one fixed height: the list keeps it as it narrows, and gives the Name box its room when "A new group" is picked, so the dialog does not jump while you type. */
.gfind{position:relative;margin:4px 0}
.gfind .ic{position:absolute;left:12px;top:50%;margin-top:-9px;color:var(--dim);pointer-events:none}
.gfind .input{padding-left:38px}
/* The wall's two search boxes have no browser clear button: Chrome's is a blue ×, the screen's only blue. */
.input[type=search]::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
.gfind:not([hidden])+.mvw{display:flex;flex-direction:column;height:min(46vh,360px)}
.gfind:not([hidden])+.mvw .mvl{flex:1 1 0;min-height:0;align-content:start}
.mvn{padding:6px 2px 2px;color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.mvn:empty{position:absolute} /* rendered, so it stays a live region, but out of the list's flow */
/* Sort: a button that shows the order and opens a menu, no <select>. The menu is a popover (top layer, closes on a click outside or Esc, no script), placed by CSS anchor positioning on whichever side of the button has more room, and never taller than that room: on a short screen it scrolls, so every choice stays reachable. */
.sortby{display:flex}
.sbtn{anchor-name:--sort;display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 10px 0 14px;border:0;border-radius:10px;background:var(--surface-2);color:var(--ink);font:600 13.5px/1 var(--sans);white-space:nowrap;cursor:pointer;transition:background-color .15s}
.sbtn:hover,.sortby:has(:popover-open) .sbtn{background:color-mix(in srgb,var(--ink) 9%,var(--surface-2))}
.sbtn .sk{color:var(--dim);font-weight:500}
.sbtn .ic{width:16px;height:16px;margin-left:auto;color:var(--dim);stroke-width:2.25;transition:rotate .2s var(--ease)}
.sortby:has(:popover-open) .sbtn .ic{rotate:180deg}
.smenu{position-anchor:--sort;position-area:block-end span-inline-end;position-try-fallbacks:flip-block;position-try-order:most-block-size;inset:auto;margin:6px 0;min-width:max(anchor-size(width),200px);max-height:-webkit-fill-available;max-height:-moz-available;max-height:stretch;overflow-y:auto;overscroll-behavior:contain;padding:6px;border:0;border-radius:12px;background:var(--surface);color:var(--ink);box-shadow:var(--lift),0 0 0 1px var(--line-strong);opacity:0;translate:0 -4px;transition:opacity .15s,translate .2s var(--ease),display .2s allow-discrete,overlay .2s allow-discrete}
.smenu:popover-open{opacity:1;translate:0}
@starting-style{.smenu:popover-open{opacity:0;translate:0 -4px}}
.smenu a{display:flex;align-items:center;gap:10px;width:100%;height:38px;padding:0 14px 0 10px;border-radius:8px;color:var(--muted);font:500 14px/1 var(--sans);white-space:nowrap;text-decoration:none}
.smenu a:hover{background:var(--wash);color:var(--ink)}
.smenu a:focus-visible{outline-offset:-2px}
.smenu .ic{flex:none;width:16px;height:16px;stroke-width:2.5;visibility:hidden}
.smenu [aria-current]{color:var(--ink);font-weight:600}
.smenu [aria-current] .ic{visibility:visible}
/* On a phone the tools stack: the sort button runs the full row, lined up with the filter above and the search below; thumb-size rows, the filter's 46px. */
@media (max-width:600px){.sortby{flex-basis:100%}.sbtn{flex:1}}
@media (max-width:600px),(max-height:480px){.sbtn{height:46px;font-size:15px}.smenu a{height:44px;font-size:15px}}
/* Between a phone and a wide screen the search wraps below the filter and the sort: it fills that row, as on a phone, not a box pushed right. */
@media (min-width:601px) and (max-width:840px){.find{flex-basis:100%;max-width:none;margin-left:0}}
/* Between the wall and a page's view, same origin, the screen cross-fades instead of cutting. The viewer is another origin: the cover (.leaving, .returning) is its way. */
@media (prefers-reduced-motion:no-preference){@view-transition{navigation:auto}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`;

export let SCAN_CSS = ''; // the self-hosted copy has no scam check
