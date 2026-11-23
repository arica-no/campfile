// The owner's screens in a real Chrome: public/manage.js's delete waits for a save still on its way, and closing its dialog meanwhile stops it;
// the wall's screenshots, which the browser keeps, are not shown after sign-out or to another account.
// Runs where CHROME_PATH names a Chrome or Chromium, or one is on PATH (GitHub's runners have google-chrome), else skips. No sandbox: CI runners refuse Chrome's, and it loads only this test's pages.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { addTester, callApp, ownerCookie, publishedPage, sessionCookie, sql, useCleanDatabase } from './helpers.ts';

useCleanDatabase();

const chrome = process.env.CHROME_PATH || ['google-chrome', 'chromium', 'chromium-browser'].find((name) => spawnSync('which', [name]).status === 0);

/** What a DevTools command answers, as far as these tests read it. */
interface Answer {
  result?: { value?: unknown };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

/** One browser for the file, talking DevTools protocol over the WebSocket Node has built in. */
async function launch() {
  const dir = mkdtempSync(join(tmpdir(), 'campfile-chrome-'));
  const proc = spawn(chrome!, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true }); // its own process group, so closing ends its helper processes too
  const endpoint = await new Promise<string>((resolve, reject) => {
    let log = '';
    proc.stderr.on('data', (chunk) => {
      log += chunk;
      const found = /DevTools listening on (ws:\S+)/.exec(log);
      if (found) resolve(found[1]);
    });
    proc.on('exit', () => reject(new Error(`Chrome exited: ${log}`)));
  });
  const target = (await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/new?about:blank`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string }; // Chrome's own DevTools answer
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let last = 0;
  const answers = new Map<number, (message: { result?: Answer; error?: { message: string } }) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    answers.get(message.id)?.(message);
    answers.delete(message.id);
  });
  const send = (method: string, params = {}) =>
    new Promise<Answer>((resolve, reject) => {
      const id = ++last;
      answers.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result ?? {})));
      socket.send(JSON.stringify({ id, method, params }));
    });
  const run = async (expression: string) => {
    const answer = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
    return answer.result?.value;
  };
  // The dialog's 10 s wait before Close is the only timer this needs to pass; nothing else in manage.js waits that long.
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'const t = setTimeout; window.setTimeout = (f, ms, ...a) => t(f, ms === 10000 ? 50 : ms, ...a);' });
  const close = async () => {
    socket.close();
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    process.kill(-proc.pid!);
    await exited; // Chrome writes its profile until it is gone
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  };
  return { send, run, close };
}

/** The app on a real port, signed in as `cookie` unless the browser sends its own, logging every request; `hold` keeps the next matching one waiting until released. */
async function serve() {
  const log: string[] = [];
  const holds: { match: (line: string) => boolean; arrived: () => void; released: Promise<void> }[] = [];
  let cookie = '';
  const server = createServer(async (req, res) => {
    const line = `${req.method} ${req.url}`;
    log.push(line);
    const hold = holds.find((h) => h.match(line));
    if (hold) {
      holds.splice(holds.indexOf(hold), 1);
      hold.arrived();
      await hold.released;
    }
    if (req.url === '/settled') {
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/manage.js' || req.url === '/takeover.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(readFileSync(`public${req.url}`));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string' && name !== 'host' && name !== 'cookie') headers.set(name, value);
    headers.set('Cookie', req.headers.cookie ?? cookie);
    const answer = await callApp(req.url!, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'manual' });
    const out: Record<string, string> = {};
    answer.headers.forEach((value, name) => {
      if (name !== 'set-cookie') out[name] = value.replaceAll('https://app.test', origin);
    });
    res.writeHead(answer.status, out).end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hold = (match: (line: string) => boolean) => {
    let arrived!: () => void, release!: () => void;
    const arrival = new Promise<void>((resolve) => (arrived = resolve));
    holds.push({ match, arrived, released: new Promise((resolve) => (release = resolve)) });
    return { arrival, release };
  };
  return { origin, log, hold, signIn: (value: string) => (cookie = value), close: () => server.close() };
}

// Started once the file is collected, and only with a browser: the tests below skip without one.
const browser = chrome ? await launch() : undefined!;
const app = chrome ? await serve() : undefined!;
afterAll(async () => {
  app?.close();
  await browser?.close();
});

// Polls for a state the page reaches on its own (a load, a redraw, a request): DevTools has no event for "this is true now".
const waitFor = async (check: () => unknown, what: string) => {
  for (let tries = 0; tries < 100; tries++, await new Promise((resolve) => setTimeout(resolve, 50))) if (await Promise.resolve().then(check).catch(() => false)) return;
  throw new Error(`Never true: ${what}`);
};
const until = (expression: string) => waitFor(() => browser.run(expression), expression);

/** Opens the page's panel, changes "See how it's shared" twice with the first save held on its way, and presses Yes, delete: the delete waits for the saves. */
async function deleteBehindASave(id: string) {
  app.signIn(await ownerCookie(id));
  await browser.send('Page.navigate', { url: `${app.origin}/p/${id}/manage` });
  await until(`document.readyState === 'complete' && !!document.querySelector('#panel form.shf') && !!document.getElementById('said')`);
  const save = app.hold((line) => line === `POST /p/${id}/publish`);
  await browser.run(`document.querySelector('form.shf input[name="sharing"][value="links"]').click()`);
  await save.arrival;
  await browser.run(`document.querySelector('form.shf input[name="sharing"][value="links"]').click()`); // the second change waits its turn behind the first
  await browser.run(`(() => {
    const dialog = document.getElementById('delete');
    dialog.showModal();
    const word = dialog.querySelector('input[name="confirm"]');
    word.value = 'delete';
    word.dispatchEvent(new Event('input', { bubbles: true }));
    dialog.querySelector('button.danger').click();
  })()`);
  await until(`document.querySelector('#delete [command="close"]').textContent === 'Close'`); // waited "10 s": the dialog may be closed now
  return save;
}

it.skipIf(!chrome)('a delete waiting for a save goes through once the save lands', async () => {
  const { id } = await publishedPage(await addTester('amy'));
  const save = await deleteBehindASave(id);
  expect(app.log).not.toContain(`POST /p/${id}/delete`);
  save.release();
  await until(`!document.getElementById('delete')?.open`);
  await until(`location.pathname === '/my'`);
  expect(app.log).toContain(`POST /p/${id}/delete`);
  expect(await sql`select id from pages where id = ${id} and status = 'live'`).toHaveLength(0);
}, 30_000);

it.skipIf(!chrome)('closing its dialog stops a delete that waits for a save, even when the save lands before the page has loaded again', async () => {
  const { id } = await publishedPage(await addTester('amy'));
  const save = await deleteBehindASave(id);
  // Chained on the saves after the waiting delete, so it reports once the delete has gone or not. DevTools cannot ask a page that is being loaded again, so the page says it over the network.
  await browser.run(`void saves.then(() => setTimeout(() => fetch('/settled', { method: 'POST', keepalive: true })))`);
  const reload = app.hold((line) => line.startsWith(`GET /p/${id}/manage`)); // Close loads the page again: kept waiting, the old page still runs when the save lands
  await browser.run(`document.getElementById('delete').close()`);
  await reload.arrival;
  save.release();
  await waitFor(() => app.log.includes('POST /settled'), 'the saves landed');
  reload.release();
  await until(`document.readyState === 'complete' && !!document.getElementById('panel')`);
  expect(app.log).not.toContain(`POST /p/${id}/delete`);
  expect(await sql`select id from pages where id = ${id} and status = 'live'`).toHaveLength(1);
}, 30_000);

it.skipIf(!chrome)("the wall's screenshot the browser keeps is not shown after sign-out or to another account", async () => {
  const { id } = await publishedPage(await addTester('amy'));
  await addTester('bob');
  const [{ id: bob }] = await sql<{ id: number }[]>`select id from testers where name = 'bob'`;
  const signIn = async (cookie: string) => {
    const [name, value] = cookie.split('=');
    await browser.send('Network.setCookie', { name, value, url: app.origin, path: '/', secure: true, httpOnly: true });
  };
  app.signIn(''); // only the browser's own cookies count here
  try {
    await signIn(await ownerCookie(id));
    await browser.send('Page.navigate', { url: `${app.origin}/my` });
    const shown = `[...document.images].find((img) => img.getAttribute('src').startsWith('/p/${id}/thumb.jpg?v='))`;
    await until(`${shown}?.complete`); // loaded; the test screenshot is not a real JPEG, so it draws nothing
    const src = (await browser.run(`${shown}.getAttribute('src')`)) as string;
    const fetches = () => app.log.filter((line) => line === `GET ${src}`).length;
    const status = () => browser.run(`fetch(${JSON.stringify(src)}).then((answer) => answer.status)`);
    expect(await status()).toBe(200);
    expect(fetches()).toBe(1); // kept: the wall loads it once
    await browser.send('Network.clearBrowserCookies'); // what /signout does to the browser
    expect(await status()).toBe(404);
    await signIn(await sessionCookie(bob));
    expect(await status()).toBe(404);
    expect(fetches()).toBe(3);
  } finally {
    await browser.send('Network.clearBrowserCookies');
  }
}, 30_000);
