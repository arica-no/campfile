import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { HAS_TERMS } from '../src/hosted.ts';
import { infoPage, siteFooter } from '../src/site.ts';
import { SETUP_MARK, setupSteps } from '../src/setup.ts';

it('shows every info page in the landing page’s header and footer, its own footer link marked', () => {
  // docs and guide ship everywhere; the hosted site adds pricing, support, privacy and terms (test/deploy-config.test.ts).
  const names = readdirSync(new URL('../public', import.meta.url)).filter((file) => file.endsWith('.html')).map((file) => file.slice(0, -5));
  expect(names).toEqual(expect.arrayContaining(['docs', 'guide']));
  for (const name of names) {
    const html = infoPage(`/${name}`, readFileSync(new URL(`../public/${name}.html`, import.meta.url), 'utf8'));
    expect(html).toMatch(/<head>[^]*<title>[^<]*Campfile[^<]*<\/title>[^]*<\/head>/);
    expect(html).toContain('<header class="wrap top">\n<a class="brand" href="/"');
    expect(html.match(/aria-current="page"/g)).toEqual(['aria-current="page"']);
    expect(html).toContain(`<a href="/${name}" aria-current="page">`);
    expect(html.match(/<html|<\/html>|<footer/g)).toEqual(['<html', '<footer', '</html>']); // the file is a fragment: no page of its own, no old footer
  }
});

it('links only to info pages that exist, in the footer and in the terms notices', () => {
  const has = (name: string) => existsSync(new URL(`../public/${name}.html`, import.meta.url));
  const links = [...siteFooter().matchAll(/<li><a href="\/([a-z]+)"/g)].map((match) => match[1]).filter((name) => name !== 'agents'); // /agents is the app's own route, not a file
  expect(links).toEqual(expect.arrayContaining(['docs', 'guide']));
  for (const name of links) expect(has(name), `/${name}`).toBe(true);
  expect(has('terms') && has('privacy')).toBe(HAS_TERMS);
});

it('gives every /guide step, 1 to 16, a sentence to copy', () => {
  const html = readFileSync(new URL('../public/guide.html', import.meta.url), 'utf8').replace(SETUP_MARK, setupSteps('https://app.test', 'https://pages.test', 'Campfile <signin@app.test>'));
  for (let n = 1; n <= 16; n++) {
    const step = new RegExp(`<section class="step" id="step-${n}"[^>]*>([^]*?)</section>`).exec(html)?.[1];
    expect(step, `step ${n}`).toBeDefined();
    const targets = [...step!.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length, `step ${n} has a Copy button`).toBeGreaterThan(0);
    const said = targets.map((id) => new RegExp(`<code id="${id}">([^<]+)</code>`).exec(step!)?.[1]);
    expect(said, `step ${n} copies its own sentence`).not.toContain(undefined);
  }
});
