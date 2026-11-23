import { readFileSync } from 'node:fs';
import { setImmediate as settle } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { consentBanner } from '../src/consent-banner.ts';

const PRIVACY = 'https://app.test/privacy#sharing';
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

it("names the author, and asks for an email only on an emails page", () => {
  const links = text(consentBanner({ author: 'Amy Rivera', email: false, privacyUrl: PRIVACY }).html);
  expect(links).toBe(
    'Amy Rivera wrote this page Amy Rivera would love to see how it travels: who it reaches, and through whom. If you allow, you get your own link to pass on. Amy Rivera sees when you opened the page, whose link you came through, and who opens yours. Campfile keeps a random ID for this page in your browser. How it works No thanksAllow',
  );
  const emails = consentBanner({ author: null, email: true, privacyUrl: PRIVACY }).html;
  expect(text(emails)).toMatch(/^The author wrote this page The author would love to see how it travels: .* The author sees your email, when you opened the page,/);
  expect(emails).toMatch(/<input [^>]*type="email"[^>]*required/);
  expect(text(emails)).toContain("Your emailCampfile doesn't check it");
  expect(consentBanner({ author: 'Amy', email: false, privacyUrl: PRIVACY }).html).not.toContain('<input');
});

it("escapes the author's name and starts with everything closed or hidden", () => {
  const { html, tool } = consentBanner({ author: '<img src=x onerror=alert(1)>"', email: true, privacyUrl: PRIVACY });
  expect(html).not.toContain('<img');
  expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;&#34;<!--/email_off--> wrote this page');
  expect(html).toContain(`href="${PRIVACY}" target="_blank" rel="noopener"`);
  expect(html).toMatch(/^<dialog class="consent" aria-labelledby="consent-lead"><form method="dialog">/);
  expect(tool).toMatch(/^<span class="consent-tool" hidden>/);
});

it("keeps an author's email name out of a host's email obfuscation, every time", () => {
  const { html } = consentBanner({ author: 'amy@example.com', email: false, privacyUrl: PRIVACY });
  expect(html.match(/<!--email_off-->amy@example\.com<!--\/email_off-->/g)).toHaveLength(3);
  expect(html.split('amy@example.com')).toHaveLength(4);
});

// /bar.js run against a minimal stand-in for the frame page: just what it touches.
const BAR = readFileSync(new URL('../viewer/public/bar.js', import.meta.url), 'utf8');
type Sent = { url: string; body: { via: string | null; key: string; email?: string } };

function element() {
  const listeners: Record<string, (e: { preventDefault(): void }) => void> = {};
  return {
    hidden: true,
    dataset: {} as Record<string, string>,
    addEventListener: (type: string, f: (e: { preventDefault(): void }) => void) => (listeners[type] = f),
    fire: (type: string) => listeners[type]?.({ preventDefault() {} }),
    focus() {},
  };
}

function openPage(path: string, storage: Map<string, string>, sent: Sent[], reply: (body: Sent['body']) => object | Promise<object>) {
  // The dialog as a browser handles it: Allow (its submit button) closes it with "allow" (method="dialog"), Esc with none, keeping the last returnValue.
  const no = element();
  const dialog = Object.assign(element(), {
    open: false,
    returnValue: 'allow', // left over from an earlier close: bar.js must clear it before showing the dialog again
    showModal() {
      this.open = true;
    },
    close(value?: string) {
      if (value !== undefined) this.returnValue = value;
      this.open = false;
      dialog.fire('close');
    },
    querySelector: (s: string) => (s === '.consent-no' ? no : null),
  });
  // The Copy button's attributes as consentBanner() renders them, so the "Copied" reset is checked against the real markup.
  const attrs = new Map([...consentBanner({ author: null, email: false, privacyUrl: PRIVACY }).tool.match(/<button[^>]*data-copy[^>]*>/)![0].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
  const copy = Object.assign(element(), { querySelector: () => null, attrs, getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: unknown) => attrs.set(k, String(v)), classList: { add() {}, remove() {} } });
  const timers: (() => void)[] = [];
  copy.dataset.copy = ''; // as consentBanner() renders it
  const copied: string[] = [];
  const tool = element();
  const location = { pathname: path, hash: '', get href() { return `https://view.test${this.pathname}${this.hash}`; } };
  const parts: Record<string, unknown> = { '.consent': dialog, '.consent-tool': tool };
  runInNewContext(BAR, {
    document: { body: { dataset: { share: 'links' } }, querySelector: (s: string) => (s in parts ? parts[s] : element()), getElementById: () => element(), querySelectorAll: (s: string) => (s === '[data-copy]' ? [copy] : []) },
    navigator: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
    setTimeout: (f: () => void) => timers.push(f),
    location,
    history: { state: null, replaceState: (_: unknown, __: string, url: string) => (location.pathname = new URL(url, 'https://view.test').pathname) },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      sent.push({ url, body });
      const answer: { status?: number } = await reply(body); // `status` stands in for the HTTP status, 200 by default
      return { ok: (answer.status ?? 200) < 300, status: answer.status ?? 200, json: async () => answer };
    },
    crypto,
    addEventListener() {},
    HTMLButtonElement: { prototype: { command: '' } },
    window: {},
  });
  return { dialog, allow: () => dialog.close('allow'), no: () => no.fire('click'), esc: () => dialog.close(), copy, copied, timers, tool, location };
}

it('keeps one key per page: allowing on two pages stores two keys, and each page only ever sends its own', async () => {
  const storage = new Map<string, string>();
  const sent: Sent[] = [];
  const codes: Record<string, string> = {};
  const reply = (body: Sent['body']) => ({ url: `https://view.test/${sent.at(-1)!.url.slice(1, 9)}-${(codes[body.key] ??= `c${Object.keys(codes).length}xy`)}` });

  const a = openPage('/AAAAAAAA', storage, sent, reply);
  expect(a.dialog.open).toBe(true);
  a.allow();
  await settle();
  const b = openPage('/BBBBBBBB-c0xy', storage, sent, reply);
  expect(b.dialog.open).toBe(true); // A's key is no answer for B
  b.allow();
  await settle();

  const keyA = JSON.parse(storage.get('campfile:share:AAAAAAAA')!).key;
  const keyB = JSON.parse(storage.get('campfile:share:BBBBBBBB')!).key;
  expect(keyA).toMatch(/^[A-Za-z0-9]{22}$/);
  expect(keyB).toMatch(/^[A-Za-z0-9]{22}$/);
  expect(keyB).not.toBe(keyA);
  expect(a.location.pathname).toBe('/AAAAAAAA-c0xy');
  expect(b.location.pathname).toBe('/BBBBBBBB-c1xy');
  expect(sent).toEqual([
    { url: '/AAAAAAAA/arrive', body: { via: null, key: keyA } },
    { url: '/BBBBBBBB/arrive', body: { via: 'c0xy', key: keyB } },
  ]);

  // Reloads: no banner, each page sends its own key whatever link was opened.
  const againA = openPage('/AAAAAAAA-zzzz', storage, sent, reply);
  const againB = openPage('/BBBBBBBB', storage, sent, reply);
  await settle();
  expect([againA.dialog.open, againB.dialog.open]).toEqual([false, false]);
  expect(sent.slice(2)).toEqual([
    { url: '/AAAAAAAA/arrive', body: { via: 'zzzz', key: keyA } },
    { url: '/BBBBBBBB/arrive', body: { via: null, key: keyB } },
  ]);
  expect(againA.tool.hidden).toBe(false);
});

describe('two tabs of one page, both opened before choosing, share one item', () => {
  const KEY_ITEM = 'campfile:share:AAAAAAAA';
  const twoTabs = () => {
    const storage = new Map<string, string>();
    const sent: Sent[] = [];
    const codes: Record<string, string> = {}; // the server: one code per key
    const reply = (body: Sent['body']) => ({ url: `https://view.test/AAAAAAAA-${(codes[body.key] ??= `c${Object.keys(codes).length}xy`)}` });
    return { storage, sent, a: openPage('/AAAAAAAA', storage, sent, reply), b: openPage('/AAAAAAAA', storage, sent, reply) };
  };
  const stored = (storage: Map<string, string>) => JSON.parse(storage.get(KEY_ITEM)!);

  it("Allow in both: one key, both tabs send it, and B gets A's own link", async () => {
    const { storage, sent, a, b } = twoTabs();
    expect([a.dialog.open, b.dialog.open]).toEqual([true, true]);
    a.allow();
    await settle();
    const { key } = stored(storage);
    b.allow();
    await settle();
    expect(stored(storage).key).toBe(key);
    expect(sent.map((s) => s.body.key)).toEqual([key, key]);
    expect([a.location.pathname, b.location.pathname]).toEqual(['/AAAAAAAA-c0xy', '/AAAAAAAA-c0xy']);
  });

  it("No thanks in B after Allow in A keeps A's key", async () => {
    const { storage, sent, a, b } = twoTabs();
    a.allow();
    await settle();
    const before = storage.get(KEY_ITEM);
    b.no();
    expect(b.dialog.open).toBe(false);
    expect(storage.get(KEY_ITEM)).toBe(before);
    expect(sent).toHaveLength(1);
  });

  it('Allow in B after No thanks in A is a fresh choice: a new key', async () => {
    const { storage, sent, a, b } = twoTabs();
    a.no();
    b.allow();
    await settle();
    const { key } = stored(storage);
    expect(key).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(sent).toEqual([{ url: '/AAAAAAAA/arrive', body: { via: null, key } }]);
  });
});

it('Copy your own link copies the address as it is when tapped, hash included, and keeps its name after "Copied"', async () => {
  const page = openPage('/AAAAAAAA-zzzz', new Map(), [], () => ({ url: 'https://view.test/AAAAAAAA-abcd' }));
  page.allow();
  await settle();
  page.location.hash = '#part-2'; // e.g. an anchor in the page's own link, after Allow
  page.copy.fire('click');
  await settle();
  expect(page.copied).toEqual(['https://view.test/AAAAAAAA-abcd#part-2']);
  expect(page.copy.attrs.get('aria-label')).toBe('Copied');
  for (const reset of page.timers) reset();
  expect(page.copy.attrs.get('aria-label')).toBe('Copy your own link');
});

it('No thanks sends nothing and is remembered for six months', async () => {
  const storage = new Map<string, string>();
  const sent: Sent[] = [];
  const page = openPage('/AAAAAAAA', storage, sent, () => ({ url: 'https://view.test/AAAAAAAA-abcd' }));
  page.no();
  expect(page.dialog.open).toBe(false);
  expect(openPage('/AAAAAAAA', storage, sent, () => ({})).dialog.open).toBe(false);
  storage.set('campfile:share:AAAAAAAA', JSON.stringify({ no: true, at: Date.now() - 184 * 24 * 60 * 60 * 1000 }));
  const later = openPage('/AAAAAAAA', storage, sent, () => ({ url: 'https://view.test/AAAAAAAA-abcd' }));
  expect(later.dialog.open).toBe(true);
  expect(sent).toEqual([]);
});

it('Esc (closing the dialog without a button) is No thanks, whatever an earlier close left as returnValue', async () => {
  const storage = new Map<string, string>();
  const sent: Sent[] = [];
  const page = openPage('/AAAAAAAA', storage, sent, () => ({ url: 'https://view.test/AAAAAAAA-abcd' }));
  page.esc();
  await settle();
  expect(sent).toEqual([]);
  expect(JSON.parse(storage.get('campfile:share:AAAAAAAA')!)).toEqual({ no: true, at: expect.any(Number) });
  expect(openPage('/AAAAAAAA', storage, sent, () => ({})).dialog.open).toBe(false);
});
