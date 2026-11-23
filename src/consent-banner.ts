import { escapeHtml, ownerText } from './html.ts';

const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const svg = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const LINK = svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>');

/** The reader's consent dialog for a page that sees how it's shared (src/viewer.ts places it, /bar.js opens it with showModal() and shows what applies). Everything starts closed or hidden. */
export function consentBanner(o: { author: string | null; email: boolean; privacyUrl?: string }): { html: string; css: string; tool: string } {
  const author = o.author ? ownerText(o.author) : 'The author';
  const field = o.email
    ? `<div class="consent-field"><label for="consent-email">Your email</label><span id="consent-note" class="consent-note">Campfile doesn't check it</span><input id="consent-email" name="email" type="email" autocomplete="email" maxlength="254" required aria-describedby="consent-note"></div>`
    : '';
  // method="dialog": Allow, the only submit button (so Enter in the email field means Allow), closes it with "allow" once the email checks out. No thanks closes it with "no" (/bar.js); Esc closes it with none, which /bar.js also takes as No thanks.
  const html = `<dialog class="consent" aria-labelledby="consent-lead"><form method="dialog">
<h2 id="consent-lead">${author} wrote this page</h2>
<p class="consent-lede">${author} would love to see how it travels: who it reaches, and through whom.</p>
<p class="consent-text">If you allow, you get your own link to pass on. ${author} sees ${o.email ? 'your email, ' : ''}when you opened the page, whose link you came through, and who opens yours. Campfile keeps a random ID for this page in your browser.${o.privacyUrl ? ` <a href="${escapeHtml(o.privacyUrl)}" target="_blank" rel="noopener">How it works</a>` : ''}</p>
${field}<div class="consent-acts"><button type="button" class="consent-no">No thanks</button><button class="consent-yes" value="allow" autofocus>Allow</button></div>
</form></dialog>`;
  // One button in the bar's own .meta look (icon-only on phones), one of /bar.js's copy buttons (data-copy, "Copied"): its data-copy is empty, so it copies the address as it is (the reader's own link).
  const tool = `<span class="consent-tool" hidden><button type="button" class="meta consent-copy" data-copy="" aria-label="Copy your own link" data-tip="Copy your own link">${LINK}<span class="label">Your own link</span></button></span>`;
  // Styled like the About dialog's card (src/viewer.ts .about), over the dimmed page; unlike it, a bottom sheet on phones, so the consent buttons sit under the thumb.
  const css = `.consent{box-sizing:border-box;width:min(440px,calc(100vw - 32px));max-width:none;margin:auto;padding:22px 24px 24px;border:0;border-radius:16px;background:#1f1a14;color:#d9cdbb;font:15px/1.5 ${FONT};box-shadow:0 2px 6px rgba(0,0,0,.2),0 24px 48px -16px rgba(0,0,0,.6)}
.consent::backdrop{background:rgba(10,8,6,.62)}
.consent h2{margin:0 0 8px;color:#f4eee6;font-size:19px;font-weight:650;line-height:1.25;text-wrap:balance}
.consent p{margin:0;text-wrap:pretty}
.consent .consent-lede{margin-bottom:12px;color:#f4eee6}
.consent-text{font-size:14px;color:#b5a894}
.consent-text a{color:#f4eee6;text-decoration:underline;text-decoration-color:rgba(244,238,230,.45);text-underline-offset:3px;white-space:nowrap}
.consent-text a:hover{text-decoration-color:currentColor}
.consent-field{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin:20px 0 0}
.consent-field label{font:600 13px/1 ${FONT};color:#f4eee6}
.consent-note{font:500 13px/1 ${FONT};color:#b5a894}
.consent-field input{box-sizing:border-box;width:100%;height:44px;margin:0;padding:0 14px;border:0;border-radius:10px;background:#0f0c09;box-shadow:inset 0 0 0 1px rgba(244,238,230,.42);color:#f4eee6;caret-color:#f2a541;font:16px ${FONT}}
.consent-field input:focus{outline:none;box-shadow:inset 0 0 0 2px #f2a541}
.consent-acts{display:flex;gap:8px;margin-top:20px}
.consent-acts button{flex:1;height:44px;margin:0;padding:0 16px;border:0;border-radius:10px;font:600 15px/1 ${FONT};cursor:pointer}
.consent-no{background:transparent;color:#f4eee6;box-shadow:inset 0 0 0 1px rgba(244,238,230,.28)}
.consent-no:hover{background:rgba(244,238,230,.08)}
.consent-yes{background:#f2a541;color:#16130f}
.consent-yes:hover{background:#f6b862}
.consent-tool[hidden]{display:none}
.consent-tool{display:flex;align-items:center}
@media (max-width:520px){
.consent{width:100%;max-height:calc(100% - 24px);margin:auto 0 0;padding:20px max(20px,env(safe-area-inset-right)) calc(20px + env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));border-radius:16px 16px 0 0}
}`;
  return { html, css, tool };
}
