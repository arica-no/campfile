import { timingSafeEqual } from 'node:crypto';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

/** base64url(HMAC-SHA256(secret, message)). Whoever has the secret can compute it again, so a token built from it needs no storage. */
async function mac(secret: string, message: string): Promise<string> {
  if (!secret) throw new Error('A secret (PREVIEW_SECRET or CONSENT_SECRET) is not set');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
}

/** True if `given` is `expected`. The time taken does not depend on how much of it is right; only its length can show. */
function sameToken(expected: string, given: string): boolean {
  const a = encoder.encode(expected);
  const b = encoder.encode(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Logging in on the viewer (docs/SPEC.md "Login"): the viewer keeps a random state in a cookie and sends the browser to the app's sign-in.
 * The app hands back a ticket, a workspace id signed under `ticket:<state>` for TICKET_SECONDS, so it works only in the browser that holds that state.
 */
export const TICKET_SECONDS = 60;
export const newState = () => base64url(crypto.getRandomValues(new Uint8Array(16)));
export const STATE = /^[\w-]{22}$/;

/**
 * A signed cookie value `<id>.<expires, Unix seconds>.<mac>`, bound to a scope: `session` for the app's sign-in session and `owner` for the viewer's (a workspace id),
 * `pass:<page id>:<approval version>` for an invite's pass to one page (a page_people id), `ticket:<state>` and `pass-ticket:<page id>:<state>:<approval version>` for the hand-overs from the app to the viewer,
 * and `view:<page id>` for the owner's page view's frame of /raw (a workspace id).
 */
export async function signedId(secret: string, scope: string, id: number, expires: number): Promise<string> {
  return `${id}.${expires}.${await mac(secret, `${scope}:${id}:${expires}`)}`;
}
/** The id in a valid signed value for this scope, unexpired at `at` (Unix seconds; 0 checks only the signature), or undefined. */
export async function readSignedId(secret: string, scope: string, value: string | undefined, at = Date.now() / 1000): Promise<number | undefined> {
  const parts = value?.split('.') ?? [];
  if (parts.length !== 3) return undefined;
  const [id, expires, given] = parts;
  if (!/^\d+$/.test(id ?? '') || !/^\d+$/.test(expires ?? '') || Number(expires) <= at) return undefined;
  return sameToken(await mac(secret, `${scope}:${id}:${expires}`), given ?? '') ? Number(id) : undefined;
}

// docs/SPEC.md "Login": the viewer's one cookie that says which workspace (person) a browser is logged in as, an id signed under `owner`. Set by the viewer.
// The app sets it too, for an approval page's screenshot (src/pages.ts).
// It keeps its name from when only owners logged in.
export const VIEWER_LOGIN = '__Host-campfile-owner';

// shortcut: cookies were named __Host-campfire-* until 2026-11; a login cookie set before the rename still counts, so nobody is logged out.
// Every such cookie has expired 30 days after the release that renamed them: then delete this and every oldCookie() call.
export const oldCookie = (name: string) => name.replace('__Host-campfile-', '__Host-campfire-');

/** A tester key: 256 random bits as 64 hex characters. */
export const newKey = () => hex(crypto.getRandomValues(new Uint8Array(32)));

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 8 random characters [A-Za-z0-9]. Bytes >= 248 (the last multiple of 62 below 256) are skipped so every character is equally likely. */
export function newPageId(): string {
  let id = '';
  while (id.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 248 && id.length < 8) id += ALPHABET[byte % 62];
    }
  }
  return id;
}
