import { CONNECTOR_IDLE_DAYS } from './connector.ts';
import { EXAMPLES } from './hosted.ts';
import { SAY } from './pitch.ts';
import type { ViewerEnv } from './env.ts';
import { CODE_MINUTES, CODES_PER_EMAIL_PER_HOUR, MAX_TRIES, signinWith } from './signin.ts';

/** Where public/guide.html takes these steps. */
export const SETUP_MARK = '<!--setup: steps 1 and 2, from src/setup.ts-->';

/** An example page (EXAMPLES in src/hosted.ts): its picture is public/examples/<id>.webp, `url` is where it can be opened, and `try` makes it a starter of step 2. */
export interface Example {
  id: string;
  url?: string;
  title: string;
  about: string;
  try?: { label: string; prompt: string };
}
const STARTERS = EXAMPLES.flatMap((e) => (e.try ? [{ ...e, try: e.try }] : []));

/** The address in EMAIL_FROM: `signin@example.com` of `Campfile <signin@example.com>`. */
export const senderAddress = (from: string) => /<(.+)>/.exec(from)?.[1] ?? from;

/** /guide's steps 1 and 2 (styled by STEP_CSS in src/site.ts, inside a `.gd`). `origin` is the app's own and `viewer` the pages' (VIEWER_ORIGIN), without a trailing slash; `sender` is EMAIL_FROM; `mode` says how a self-hosted server without SMTP signs people in. */
export const setupSteps = (origin: string, viewer: string, sender: string, mode: Pick<ViewerEnv, 'OWNER_LOGIN' | 'EMAIL_IN_LOG'> = {}) => `<section class="step" id="step-1" data-n="1" data-t="Connect Campfile to your AI">
<div>
<p class="n">Step 1 · once, about 3 minutes</p>
<h3>Connect Campfile to your AI</h3>
<fieldset class="apps"><legend class="sr">Your AI app</legend>
<label><input type="radio" name="app" id="a-claude" checked>Claude</label>
<label><input type="radio" name="app" id="a-gpt">ChatGPT</label>
<label><input type="radio" name="app" id="a-gem">Gemini</label>
<label><input type="radio" name="app" id="a-other">Others</label>
</fieldset>
<div class="app claude">
<p>Go to <b>Customize → Connectors → Add custom connector</b>. Name it Campfile, paste the address and press <b>Add</b>. Then, next to Campfile, press <b>Connect</b>.</p>
<div class="go"><a class="btn" href="https://claude.ai/customize/connectors?modal=add-custom-connector" target="_blank" rel="noopener noreferrer">Open Claude settings<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a></div>
<p class="note">Any plan. The free plan allows one custom connector. On a Team plan, an owner adds Campfile, then you press <b>Connect</b>.</p>
</div>
<div class="app gpt">
<p>Open <b>Plugins</b>, press <b>+</b>, then <b>Add custom MCP server</b>. Name it Campfile, paste the address and press <b>Create as a plugin</b>. In a chat, type @ and pick Campfile.</p>
<div class="go"><a class="btn" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">Open ChatGPT<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a></div>
<p class="note">Business, Enterprise and Edu plans. Your admin may need to allow it.</p>
</div>
<div class="app gem">
<p>Go to <b>Settings → Connected Apps → Add a custom app</b>. Paste the address and press <b>Next</b>. In a chat, type @ and pick Campfile.</p>
<div class="go"><a class="btn" href="https://gemini.google.com/apps" target="_blank" rel="noopener noreferrer">Open Gemini’s Connected Apps<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a></div>
<p class="note">On gemini.google.com, with a personal Google account, in the US, 18 or older.</p>
</div>
<div class="app other">
<p>In the app’s settings, look for <b>Connectors</b> (some apps say MCP servers or custom apps) and add Campfile with the address.</p>
<p class="note">Perplexity, Mistral Le Chat, Cursor and more. Not every app or plan allows it.</p>
</div>
<p>Then sign in with your email and ${signinWith(mode)}.</p>
<p class="note">${mode.EMAIL_IN_LOG ? '' : `No email within a minute? Look in spam for one from ${senderAddress(sender)}. A code works for ${CODE_MINUTES} minutes and ${MAX_TRIES} tries; then press <b>Start again</b> for a new one (up to ${CODES_PER_EMAIL_PER_HOUR} an hour). `}Not used for ${CONNECTOR_IDLE_DAYS} days? Your AI asks you to connect again; your pages stay.</p>
</div>
<div>
<div class="chat fields app claude" aria-label="What to fill in">
<label>Name<span class="addr"><code>Campfile</code></span></label>
<label>Remote MCP server URL<span class="addr"><code id="addr-1">${origin}/mcp</code><button type="button" class="btn" data-copy="addr-1" aria-label="Copy the address"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg><span class="lbl">Copy</span></button></span></label>
</div>
<div class="chat fields app gpt" aria-label="What to fill in">
<label>Name<span class="addr"><code>Campfile</code></span></label>
<label>MCP server URL<span class="addr"><code id="addr-2">${origin}/mcp</code><button type="button" class="btn" data-copy="addr-2" aria-label="Copy the address"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg><span class="lbl">Copy</span></button></span></label>
</div>
<div class="chat fields app gem" aria-label="What to fill in">
<label>MCP server URL<span class="addr"><code id="addr-3">${origin}/mcp</code><button type="button" class="btn" data-copy="addr-3" aria-label="Copy the address"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg><span class="lbl">Copy</span></button></span></label>
</div>
<div class="chat fields app other" aria-label="What to fill in">
<label>Server address<span class="addr"><code id="addr-4">${origin}/mcp</code><button type="button" class="btn" data-copy="addr-4" aria-label="Copy the address"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg><span class="lbl">Copy</span></button></span></label>
</div>
</div>
</section>
<section class="step" id="step-2" data-n="2" data-t="Put your page on Campfile">
<div>
<p class="n">Step 2</p>
<h3>Put your page on Campfile</h3>
<fieldset class="apps ways"><legend class="sr">Your page</legend>
<label><input type="radio" name="way" id="w-have" checked>I have a page</label>
<label><input type="radio" name="way" id="w-try">Try an example</label>
</fieldset>
<div class="way w-have">
<p>Say this in the chat where you made your page. You get a link to a private draft only you can open.</p>
<div class="say"><code id="say-2">${SAY}</code></div><div class="go"><button type="button" class="btn" data-copy="say-2" aria-label="Copy the sentence"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg><span class="lbl">Copy</span></button></div>
</div>
<div class="way w-try">
<p>Pick one. Your AI makes a page like it and puts it on Campfile as a private draft.</p>
<fieldset class="tries"><legend class="sr">A page to try</legend>
${STARTERS.map((e, i) => `<label><input type="radio" name="try" id="t-${e.id}"${i ? '' : ' checked'}><img src="/examples/${e.id}.webp" width="800" height="500" alt="" loading="lazy" decoding="async"><span>${e.try.label}</span></label>`).join('\n')}
</fieldset>
${STARTERS.map((e) => `<div class="try t-${e.id}"><div class="say"><code id="say-${e.id}">${e.try.prompt}</code></div><div class="go"><button type="button" class="btn" data-copy="say-${e.id}" aria-label="Copy this message"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg><span class="lbl">Copy</span></button><a class="btn alt open o-claude" href="https://claude.ai/new?q=${encodeURIComponent(e.try.prompt)}" target="_blank" rel="noopener noreferrer">Open in Claude<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg><span class="sr"> (opens in a new tab)</span></a><a class="btn alt open o-gpt" href="https://chatgpt.com/?q=${encodeURIComponent(e.try.prompt)}" target="_blank" rel="noopener noreferrer">Open in ChatGPT<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg><span class="sr"> (opens in a new tab)</span></a></div>${e.url ? `<p class="note">Your page will be something like <a href="${e.url}" target="_blank" rel="noopener noreferrer">this example<span class="sr"> (opens in a new tab)</span></a>.</p>` : ''}</div>`).join('\n')}
</div>
<p class="note at">In ChatGPT and Gemini, type @ and pick Campfile first.</p>
</div>
<div>
<div class="chat way w-have" aria-label="Example chat"><div class="me"><span class="who">You</span><q>${SAY}</q></div><div class="ai"><span class="who">Your AI</span><p>Done. It’s a private draft for now: only you can open it.</p><div class="card"><div class="t"><b>Weekend in Bergen</b><span>${new URL(viewer).host}/k3Xb9QaZ</span></div><span class="lamp">Draft</span></div></div></div>
<div class="way w-try">
${STARTERS.map((e) => `<div class="chat try t-${e.id}" aria-label="Example chat"><div class="me"><span class="who">You</span><q>${e.try.prompt}</q></div><div class="ai"><span class="who">Your AI</span><p>Done. It’s a private draft for now: only you can open it.</p><img class="shot" src="/examples/${e.id}.webp" width="800" height="500" alt="" loading="lazy" decoding="async"><div class="card"><div class="t"><b>${e.title}</b><span>${e.url?.slice('https://'.length) ?? `${new URL(viewer).host}/k3Xb9QaZ`}</span></div><span class="lamp">Draft</span></div></div></div>`).join('\n')}
</div>
</div>
</section>`;
