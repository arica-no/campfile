// The link-preview picture of a page that has no screenshot: its title on Campfile's dark card, 1200x630, drawn here with no browser (env.TITLE_CARD, src/viewer.ts /:id/card.png).
// satori lays the text out into an SVG (the letters as outlines), resvg-wasm turns that into a PNG; both are plain JavaScript and WebAssembly, so the same code can run on any server runtime.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori from 'satori';
import { LOGO_MARK } from '../src/html.ts';
import { CARD_TIERS, cardTier, PREVIEW_HEIGHT, PREVIEW_WIDTH } from '../src/preview.ts';

// The one font, Inter Display Bold (SIL Open Font License, selfhost/fonts/Inter-LICENSE.txt).
const FONT = readFile(new URL('./fonts/InterDisplay-Bold.ttf', import.meta.url));
let wasm: Promise<void> | undefined;

const INK = '#f4eee6';
const MUTED = '#b5a894';
const MARK = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 3.5 24 24">${LOGO_MARK}</svg>`)}`;

/** What Inter has: Latin (with the extended and Vietnamese blocks), Greek, Cyrillic and the usual punctuation and currency signs. Anything else (CJK, Arabic, emoji …) would be drawn as an empty box, so it is left out. */
const DRAWABLE = /[^\u0020-\u007e\u00a0-\u024f\u0300-\u036f\u0370-\u03ff\u0400-\u052f\u1e00-\u1fff\u2010-\u2027\u2030-\u205e\u20a0-\u20bf]/gu;
const MAX_CHARS = 300; // beyond what any card shows, so a huge title costs no more than a long one
const FALLBACK = 'Made for sharing'; // a title with nothing drawable (all CJK, say): the chat app shows the real title beside the picture

/** The title as it is drawn, and how (src/preview.ts CARD_TIERS). */
function fit(title: string): { text: string; size: number; lines: number; balance: boolean } {
  const text = title.replace(DRAWABLE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS).trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return { text: FALLBACK, size: 96, lines: 2, balance: true };
  return { text, ...CARD_TIERS[cardTier(text)] };
}

const box = (style: Record<string, string | number>, children: unknown) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } });

const CACHED = 64; // cards kept: the ones chat apps are asking for just now, each a few tens of KB
const cards = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

/** A 1200x630 PNG: the page's title, big, over Campfile's mark and name. The last few are kept, as a link posted in a chat is fetched by every app and member at once. */
export function titleCard(title: string): Promise<Uint8Array<ArrayBuffer>> {
  let card = cards.get(title);
  if (!card) {
    card = draw(title);
    cards.set(title, card);
    card.catch(() => cards.delete(title)); // a failed draw is tried again next time
    if (cards.size > CACHED) cards.delete(cards.keys().next().value!);
  }
  return card;
}

async function draw(title: string): Promise<Uint8Array<ArrayBuffer>> {
  const { text, size, lines, balance } = fit(title);
  const card = box(
    {
      boxSizing: 'border-box', flexDirection: 'column', justifyContent: 'space-between', width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, padding: '72px 80px', color: INK, fontFamily: 'Inter', fontWeight: 700,
      backgroundColor: '#16130f', backgroundImage: 'radial-gradient(circle at 100% 100%, rgba(242,165,65,0.22) 0%, rgba(242,165,65,0) 55%)',
    },
    [
      box({ flex: 1, alignItems: 'center' }, [
        { type: 'div', props: { style: { display: 'block', width: '100%', fontSize: size, lineHeight: 1.12, letterSpacing: '-0.025em', lineClamp: lines, wordBreak: 'break-word', textWrap: balance ? 'balance' : 'wrap' }, children: text } },
      ]),
      box({ alignItems: 'center', gap: 16 }, [
        { type: 'img', props: { src: MARK, width: 52, height: 52, style: { marginLeft: -4 } } }, // the mark's own margin less the big letter's: both start at the same x
        { type: 'div', props: { style: { display: 'block', fontSize: 34, letterSpacing: '-0.01em', color: MUTED }, children: 'Campfile' } },
      ]),
    ],
  );
  const svg = await satori(card as never, { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, fonts: [{ name: 'Inter', data: await FONT, weight: 700, style: 'normal' }] });
  wasm ??= readFile(fileURLToPath(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm'))).then((bytes) => initWasm(bytes));
  await wasm;
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: PREVIEW_WIDTH } });
  const image = resvg.render();
  try {
    return new Uint8Array(image.asPng());
  } finally {
    image.free();
    resvg.free();
  }
}
