// Campfile's screenshot service: POST /screenshot takes the options of src/preview.ts takeScreenshot (src/env.ts ScreenshotOptions) and answers with a JPEG of the page, taken in headless Chromium.
// It renders pages written by strangers, so it trusts nothing of them: every shot is a fresh browser context, the browser can reach only the app and the viewer (the proxy flags below; everything else, WebSockets and WebRTC too, is refused),
// the container has no database and no secrets but this one, and only the app, which holds the secret, can ask for a shot.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';
import { bounded } from './bounded.mjs';

const secret = process.env.SCREENSHOT_SECRET || readFileSync('/screenshot-key/secret', 'utf8').trim();
if (secret.length < 32) throw new Error('SCREENSHOT_SECRET must be at least 32 characters.');
// The addresses a shot may load: where the pages are served (the same settings as the app's).
const origins = [process.env.APP_ORIGIN, process.env.VIEWER_ORIGIN].filter(Boolean).map((origin) => new URL(origin).origin);
if (!origins.length) throw new Error('APP_ORIGIN is not set.');
const MAX_SHOTS = Number(process.env.MAX_SHOTS || 2); // each takes a few hundred MB; more at once get a 503, which the app answers by trying again later
const SHOT_HEADER = 'Campfile-Screenshot'; // src/client.ts SCREENSHOT: it tells the app this is the screenshot browser (not a reader to count), and carries the secret as proof

const digest = (text) => createHash('sha256').update(text).digest();
const isSecret = (given) => typeof given === 'string' && timingSafeEqual(digest(given), digest(`Bearer ${secret}`));

class Bad extends Error {}
const number = (value, min, max, name) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Bad(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
};

/** The shot's options, checked: the body is the app's, but anything that reached the app's API is not worth trusting with a browser. */
function parse(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Bad('The body is not JSON.');
  }
  if (!o || typeof o !== 'object' || typeof o.url !== 'string' || !URL.canParse(o.url) || !origins.includes(new URL(o.url).origin)) throw new Bad('url is not the app or the viewer.');
  if (o.screenshotOptions?.type !== 'jpeg') throw new Bad('Only JPEG is taken.');
  const cookies = (o.cookies ?? []).map((cookie) => {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || !URL.canParse(cookie.url) || !origins.includes(new URL(cookie.url).origin)) throw new Bad('A cookie is not for the app or the viewer.');
    return { name: cookie.name, value: cookie.value, url: cookie.url, path: '/', secure: cookie.secure === true, httpOnly: cookie.httpOnly === true, sameSite: 'Lax' };
  });
  return {
    url: o.url,
    width: number(o.viewport?.width, 100, 2000, 'viewport.width'),
    height: number(o.viewport?.height, 100, 2000, 'viewport.height'),
    gotoTimeout: number(o.gotoOptions?.timeout, 1000, 30_000, 'gotoOptions.timeout'),
    wait: number(o.waitForTimeout ?? 0, 0, 10_000, 'waitForTimeout'),
    actionTimeout: number(o.actionTimeout ?? 10_000, 1000, 30_000, 'actionTimeout'),
    quality: number(o.screenshotOptions.quality ?? 80, 1, 100, 'screenshotOptions.quality'),
    cookies,
  };
}

let browser;
let launched; // the running browser, so a hung shot can kill it (killChromium)
const chromium = () =>
  (browser ??= puppeteer
    .launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-headless-shell',
      headless: 'shell',
      args: [
        // The container is the sandbox: Chromium's own needs kernel features that Docker's default profile withholds.
        '--no-sandbox',
        '--disable-dev-shm-usage', // /dev/shm is 64 MB in a container; /tmp is sized in compose.yaml
        '--disable-gpu',
        '--disable-breakpad',
        '--hide-scrollbars',
        '--mute-audio',
        // Everything goes to a proxy that is not there, except the app and the viewer: with `<-loopback>` not even this container's own addresses are exempt.
        '--proxy-server=http://127.0.0.1:9',
        `--proxy-bypass-list=<-loopback>;${origins.join(';')}`,
        '--force-webrtc-ip-handling-policy=disable_non_proxified_udp',
        // In a local install the address is localhost, which here is this container: the app is campfile (compose.yaml), at its own port.
        '--host-resolver-rules=MAP localhost campfile:8787',
        // Caps a page's JavaScript heap: a page piling up objects stops near 450 MB, not at the container's 1 GB. Buffers and canvases are outside it.
        '--js-flags=--max-old-space-size=256',
      ],
    })
    .then((started) => {
      launched = started;
      started.on('disconnected', () => {
        if (launched === started) launched = browser = undefined;
      });
      return started;
    }, (error) => {
      browser = undefined;
      throw error;
    }));

/** Kills the browser outright, for a shot whose pages do not close: the shots running with it fail too, and the next one starts a new browser. */
function killChromium() {
  launched?.process()?.kill('SIGKILL');
  launched = browser = undefined;
}

/** The shot, in its own browser context, which it closes when done; `opened` hears of the context at once, so a timed-out shot's can be closed from outside (bounded). */
async function shoot(shot, opened) {
  const context = await (await chromium()).createBrowserContext();
  opened(context);
  try {
    const page = await context.newPage();
    await page.setViewport({ width: shot.width, height: shot.height });
    await page.setExtraHTTPHeaders({ [SHOT_HEADER]: secret }); // goes only where the proxy flags let a request go: to the app and the viewer
    const session = await page.createCDPSession();
    for (const cookie of shot.cookies) await session.send('Network.setCookie', cookie); // by url, so a __Host- cookie stays host-only
    await page.goto(shot.url, { waitUntil: 'load', timeout: shot.gotoTimeout });
    await new Promise((done) => setTimeout(done, shot.wait));
    return await page.screenshot({ type: 'jpeg', quality: shot.quality });
  } finally {
    await context.close().catch(() => {});
  }
}

let running = 0;
const reply = (response, status, body, headers = {}) => response.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'image/jpeg', ...headers }).end(body);

createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url ?? '/', 'http://service');
    if (request.method === 'GET' && pathname === '/health') return reply(response, 200, 'ok');
    if (pathname !== '/screenshot') return reply(response, 404, 'Not found');
    if (request.method !== 'POST') return reply(response, 405, 'POST only');
    if (!isSecret(request.headers.authorization)) return reply(response, 401, 'Wrong or missing secret');
    if (running >= MAX_SHOTS) return reply(response, 503, 'Busy', { 'Retry-After': '10' });
    running++;
    try {
      let text = '';
      for await (const chunk of request) if ((text += chunk).length > 64 * 1024) return reply(response, 413, 'Too big');
      const shot = parse(text);
      let context;
      const image = await bounded(() => shoot(shot, (opened) => (context = opened)), {
        ms: shot.gotoTimeout + shot.wait + shot.actionTimeout,
        cleanupMs: 5000,
        cleanup: () => context?.close().catch(() => {}),
        kill: killChromium,
      });
      return reply(response, 200, image);
    } finally {
      // The browser is closed once no shot is running: idle, the service holds about 30 MB instead of about 150 MB, and a page cannot leave anything behind.
      if (!--running && launched) {
        const idle = launched;
        launched = browser = undefined;
        idle.close().catch(() => idle.process()?.kill('SIGKILL'));
      }
    }
  } catch (error) {
    if (!(error instanceof Bad)) console.error('A shot failed:', error?.message ?? error);
    if (!response.headersSent) reply(response, error instanceof Bad ? 400 : 502, error instanceof Bad ? error.message : 'The shot failed');
  }
}).listen(3000);
