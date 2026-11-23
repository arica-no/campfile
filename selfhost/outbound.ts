// What a self-hosted server may fetch: the public internet, and nothing else.
// Two things fetch an address somebody else chose: a page's `source_url` (src/pages.ts; the sender reads the answer back as a page) and the OAuth library's client metadata and JWKS documents.
// The library does the second only on a runtime that tells it fetch is limited to public addresses, which Node never does, so here the first is the real hole: without this guard a `source_url` of http://169.254.169.254/ (a cloud's metadata service) or of anything on the server's network would be fetched and stored.
import { lookup as resolve } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, isIPv6, SocketAddress, type LookupFunction } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import { createGunzip, createInflate } from 'node:zlib';

const nonPublic = new BlockList();
const block = (family: 'ipv4' | 'ipv6', ...ranges: string[]) => {
  for (const range of ranges) {
    const [address, prefix] = range.split('/');
    nonPublic.addSubnet(address, Number(prefix), family);
  }
};
// Loopback, private, shared (carrier-grade NAT), link-local (169.254.169.254 is in it), documentation, benchmarking, multicast, reserved, and the transition ranges that carry an IPv4 address inside an IPv6 one (6to4, Teredo, NAT64, IPv4-compatible).
// An IPv4-mapped address (::ffff:127.0.0.1, which a dual-stack socket connects to 127.0.0.1) is matched against the IPv4 ranges by BlockList itself.
block('ipv4', '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4');
block('ipv6', '::/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/32', '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8');

const familyOf = (address: string) => (isIPv6(address) ? 'ipv6' : 'ipv4');

/** Whether `address`, an IP address as text, is on the public internet. Text that is not an address is not. */
export function isPublic(address: string): boolean {
  try {
    return !nonPublic.check(new SocketAddress({ address, family: familyOf(address) }));
  } catch {
    return false;
  }
}

export interface OutboundOptions {
  /** Origins fetched as they are, at whatever address: the app and the viewer (local, in a local install). */
  allow: string[];
  /** Addresses refused although they are public: what the names of the app and the viewer resolve to (resolveHosts), because another port at the server's own address is the operator's own network. */
  ownAddresses?: string[];
  /** Which addresses are public. Only the tests set it, to play an attacker's server on 127.0.0.2. */
  isPublic?: (address: string) => boolean;
}

/** The addresses the host names of `origins` resolve to now, for `ownAddresses`. A name that does not resolve gives none and a warning: until the next start nothing guards that address. */
export async function resolveHosts(origins: string[]): Promise<string[]> {
  const found = origins.map((origin) => {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    const { promise, resolve: done } = Promise.withResolvers<string[]>();
    resolve(host, { all: true }, (error, addresses) => {
      if (error) console.warn(`Warning: ${host} does not resolve (${error.message}), so downloads from this server's own address are not refused until Campfile restarts.`);
      done(error ? [] : addresses.map(({ address }) => address));
    });
    return promise;
  });
  return (await Promise.all(found)).flat();
}

type Judge = (address: string) => boolean;

/** What fetch rejects with when it cannot get an answer. A refused address looks the same, so the one who chose it learns nothing about the network behind it. */
const failed = (cause: unknown) => new TypeError('fetch failed', { cause });
const refusal = (address: string) => new Error(`${address} is not a public address`);

/** Resolves a name like dns.lookup, but fails when any address it has is not public: the address that is checked is the one connected to, so the name cannot change between the check and the connection. */
const checkedLookup =
  (judge: Judge): LookupFunction =>
  (host, options, callback) =>
    resolve(host, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      const bad = addresses.find(({ address }) => !judge(address));
      if (bad) return callback(refusal(bad.address), []);
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NO_BODY = new Set([204, 205, 304]);
const MAX_REDIRECTS = 20;
const DEFAULT_HEADERS = { accept: '*/*', 'accept-encoding': 'gzip, deflate', 'user-agent': 'node' }; // what fetch sends unasked
const decoders = { gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate };

/** A fetch Response for what node:http received: its status, its headers and its body as a stream, decoded as fetch does. */
function toResponse(res: IncomingMessage, method: string): Response {
  const headers = new Headers();
  for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
  const status = res.statusCode ?? 0;
  if (method === 'HEAD' || NO_BODY.has(status)) {
    res.resume();
    return new Response(null, { status, headers });
  }
  let body: Readable = res;
  for (const coding of (res.headers['content-encoding'] ?? '').split(',').reverse()) {
    const decoder = decoders[coding.trim().toLowerCase() as keyof typeof decoders];
    if (decoder) body = pipeline(body, decoder(), () => {});
  }
  return new Response(Readable.toWeb(body), { status, headers });
}

/** One request to an address that is not one of ours, over a connection that only a public address can get. Never follows a redirect: the caller decides. */
async function open(url: URL, method: string, headers: Headers, signal: AbortSignal, judge: Judge): Promise<Response> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw failed(new Error(`${url.protocol} is not fetched`));
  // A name is judged where it is resolved (checkedLookup). node:http connects to an IP address without resolving anything, so that one is judged here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !judge(host)) throw failed(refusal(host));
  const { promise, resolve, reject } = Promise.withResolvers<Response>();
  // No shared agent: a pooled connection would outlive the request, and nothing here asks again soon.
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers: { ...DEFAULT_HEADERS, ...Object.fromEntries(headers) }, agent: false, lookup: checkedLookup(judge) });
  let answer: IncomingMessage | undefined;
  // An abort rejects with its own reason, as fetch does: src/pages.ts tells a TimeoutError from other failures. After the answer began, it ends the body the same way.
  const abort = () => {
    reject(signal.reason);
    (answer ?? req).destroy(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  req.once('close', () => signal.removeEventListener('abort', abort));
  req.on('error', (error) => reject(failed(error)));
  req.once('response', (res) => {
    answer = res;
    try {
      resolve(toResponse(res, method));
    } catch (error) {
      res.destroy();
      reject(failed(error));
    }
  });
  req.end();
  return promise;
}

/**
 * A fetch that reaches the origins of `allow` as they are and every other address only when it is public and not one of `ownAddresses`, and only with GET or HEAD.
 * Redirects are followed here, not by the connection, so each hop gets the same check, including a hop that leaves an origin of `allow`: an open redirect of ours must not lead into the network either.
 */
export function guardedFetch({ allow, ownAddresses = [], isPublic: publicAddress = isPublic }: OutboundOptions): typeof fetch {
  const own = new Set(allow.map((origin) => new URL(origin).origin));
  const taken = new BlockList();
  for (const address of ownAddresses) taken.addAddress(address, familyOf(address));
  const judge: Judge = (address) => publicAddress(address) && !taken.check(address, familyOf(address));
  const original = globalThis.fetch;
  return async (input, init) => {
    const request = new Request(input, init);
    const { method, redirect, signal } = request;
    let url = new URL(request.url);
    if (method !== 'GET' && method !== 'HEAD') {
      // The viewer's POST to the app: an address the code fixes, never one a user chose.
      if (own.has(url.origin)) return original(request, { redirect: 'error' }); // a redirect of ours must not lead a POST into the network either
      throw failed(new Error(`${method} is not sent to other servers`));
    }
    const headers = new Headers(request.headers);
    for (let hops = 0; ; hops++) {
      signal.throwIfAborted();
      const response = await (own.has(url.origin) ? original(url, { method, headers, redirect: 'manual', signal }) : open(url, method, headers, signal, judge));
      const location = REDIRECTS.has(response.status) ? response.headers.get('location') : null;
      if (location === null || redirect === 'manual') return response;
      await response.body?.cancel();
      if (redirect === 'error' || hops === MAX_REDIRECTS) throw failed(new Error(redirect === 'error' ? 'it redirected' : `it redirected more than ${MAX_REDIRECTS} times`));
      const next = new URL(location, url);
      if (next.origin !== url.origin) for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name);
      url = next;
    }
  };
}

/** Replaces the global fetch, which the app, the viewer and the OAuth library call, with guardedFetch. */
export function guardOutbound(options: OutboundOptions): void {
  globalThis.fetch = guardedFetch(options);
}
