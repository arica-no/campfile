// "See how it's shared" (docs/SPEC.md): with pages.sharing on, a reader who allows gets their own link /<id>-<code>, recorded under the link they came through (migrations/001_init.sql).
// A browser is known only by sha256 of its random key for this page; labels (emails) are unchecked and never used to find an entry.
import type postgres from 'postgres';
import type { Sql } from './db.ts';
import { newPageId, sha256Hex } from './keys.ts';

export type Sharing = 'off' | 'links' | 'emails';
export const SHARE_CAP = 1000;
/** A reader's link code. */
export const CODE = /^[A-Za-z0-9]{4}$/;
/** A browser's secret key for one page. */
export const KEY = /^[A-Za-z0-9]{22}$/;
export type Device = 'phone' | 'computer';

/** 4 random [A-Za-z0-9]: the first half of a page id, every character equally likely. */
const newCode = () => newPageId().slice(0, 4);

export function deviceOf(userAgent: string): Device | null {
  if (!userAgent) return null;
  return /Mobi|iPhone|iPod/.test(userAgent) ? 'phone' : 'computer';
}

/** The country in the CLIENT_COUNTRY header (src/client.ts): two capitals, or null. XX = unknown; T1 (Tor) is no country either. */
export function countryOf(header: string | undefined): string | null {
  return header && /^[A-Z]{2}$/.test(header) && header !== 'XX' ? header : null;
}

/**
 * The author's name in the consent modal; never an email address. Their chosen display_name, else a name made from their email's local part
 * (`amy.rivera@x.com` → `Amy Rivera`; all-digit parts dropped), else their account name when it isn't an email, else null ("The author").
 */
export function authorName(t: { display_name: string | null; email: string | null; name: string }): string | null {
  const chosen = t.display_name?.trim();
  if (chosen) return chosen;
  const email = t.email ?? (t.name.includes('@') ? t.name : null);
  const derived = email
    ?.split('@')[0]
    .split(/[._+-]/)
    .filter((part) => part && !/^\d+$/.test(part))
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
  if (derived) return derived;
  const name = t.name.trim();
  return name && !name.includes('@') ? name : null;
}

type Tx = postgres.TransactionSql;

/** One change to a page's tree at a time: the cap holds, a key gets one entry, and no child is added under an entry being deleted. */
const lock = (tx: Tx, page: string) => tx`select pg_advisory_xact_lock(hashtext(${`share_links ${page}`}))`;

/** Inside the lock: the page's entry count and the parent code (null = author's link) that `via` stands for on this page. */
async function place(tx: Tx, page: string, via: string | null): Promise<{ entries: number; parent: string | null }> {
  const [row] = await tx<{ entries: number; parent: string | null }[]>`
    select (select count(*)::int from share_links where page = ${page}) as entries,
           (select code from share_links where page = ${page} and code = ${via && CODE.test(via) ? via : null}) as parent`;
  return row;
}

/** Inserts an entry under a fresh code, drawing again if the code is taken on this page. */
async function insert(
  tx: Tx,
  code: () => string,
  e: { page: string; parent: string | null; key_hash: string | null; label: string | null; ai: string | null; country: string | null; device: Device | null },
): Promise<string> {
  for (;;) {
    const [row] = await tx<{ code: string }[]>`
      insert into share_links (page, code, parent, key_hash, label, ai, country, device)
      values (${e.page}, ${code()}, ${e.parent}, ${e.key_hash}, ${e.label}, ${e.ai}, ${e.country}, ${e.device})
      on conflict (page, code) do nothing returning code`;
    if (row) return row.code;
  }
}

/**
 * A browser that allowed. Same key hash on this page → its existing code, nothing changes. Else a new entry under `via` (invalid/unknown → root) with label/country/device, or null at the cap.
 * `label` is required by the caller on 'emails' pages for a new entry; this stores what it gets (trimmed, lowercased). The caller has checked `KEY`.
 */
export async function arrive(
  sql: Sql,
  a: { page: string; via: string | null; key: string; label: string | null; country: string | null; device: Device | null },
  code = newCode,
): Promise<{ code: string | null; created: boolean }> {
  const keyHash = await sha256Hex(a.key);
  const label = a.label?.trim().toLowerCase() || null;
  return sql.begin(async (tx) => {
    await lock(tx, a.page);
    const [held] = await tx<{ code: string }[]>`select code from share_links where page = ${a.page} and key_hash = ${keyHash}`;
    if (held) return { code: held.code, created: false };
    const { entries, parent } = await place(tx, a.page, a.via);
    if (entries >= SHARE_CAP) return { code: null, created: false };
    return { code: await insert(tx, code, { page: a.page, parent, key_hash: keyHash, label, ai: null, country: a.country, device: a.device }), created: true };
  });
}

/** True if this key already has an entry on this page (so an 'emails' page needs no email). */
export async function hasEntry(sql: Sql, page: string, key: string): Promise<boolean> {
  const [row] = await sql`select 1 from share_links where page = ${page} and key_hash = ${await sha256Hex(key)}`;
  return row !== undefined;
}

/** An AI fetcher's entry: one per (page, parent, ai, UTC day); null at the cap. */
export async function arriveAi(
  sql: Sql,
  a: { page: string; via: string | null; ai: string; country: string | null },
  code = newCode,
): Promise<string | null> {
  return sql.begin(async (tx) => {
    await lock(tx, a.page);
    const { entries, parent } = await place(tx, a.page, a.via);
    const [held] = await tx<{ code: string }[]>`
      select code from share_links
      where page = ${a.page} and parent is not distinct from ${parent} and ai = ${a.ai}
        and (created_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date
      limit 1`;
    if (held) return held.code;
    if (entries >= SHARE_CAP) return null;
    return insert(tx, code, { page: a.page, parent, key_hash: null, label: null, ai: a.ai, country: a.country, device: null });
  });
}

/** Deletes the page's whole tree; returns how many entries went. */
export async function clearTree(sql: Sql, page: string): Promise<number> {
  return sql.begin(async (tx) => {
    await lock(tx, page);
    return (await tx`delete from share_links where page = ${page}`).count;
  });
}

/** The code if it belongs to this page, else null. Used for og:url. */
export async function validCode(sql: Sql, page: string, code: string | null | undefined): Promise<string | null> {
  if (!code || !CODE.test(code)) return null;
  const [row] = await sql<{ code: string }[]>`select code from share_links where page = ${page} and code = ${code}`;
  return row?.code ?? null;
}

export interface ShareEntry {
  label: string | null;
  ai: string | null /* AI name, null for a browser */;
  country: string | null;
  device: Device | null;
  first_opened: string /* ISO date-time */;
  brought: number /* direct */;
  reached: number /* whole branch below it */;
  children: ShareEntry[];
}
export interface ShareTree {
  sharing: Sharing;
  entries: number;
  capped: boolean;
  brought: number /* through the author's link */;
  children: ShareEntry[];
}

/** The page's whole tree, for its owner (the caller checks ownership). Children are sorted by reached, most first, then by first_opened. Codes and keys stay out. */
export async function shareTree(sql: Sql, page: string): Promise<ShareTree> {
  const [pageRow] = await sql<{ sharing: Sharing }[]>`select sharing from pages where id = ${page}`;
  const rows = await sql<{ code: string; parent: string | null; label: string | null; ai: string | null; country: string | null; device: Device | null; created_at: Date }[]>`
    select code, parent, label, ai, country, device, created_at from share_links where page = ${page}`;
  const below = new Map<string | null, (typeof rows)[number][]>();
  for (const row of rows) below.set(row.parent, [...(below.get(row.parent) ?? []), row]);
  const nest = (parent: string | null): ShareEntry[] =>
    (below.get(parent) ?? [])
      .map((row) => {
        const children = nest(row.code);
        return {
          label: row.label,
          ai: row.ai,
          country: row.country,
          device: row.device,
          first_opened: row.created_at.toISOString(),
          brought: children.length,
          reached: children.reduce((sum, child) => sum + 1 + child.reached, 0),
          children,
        };
      })
      .sort((x, y) => y.reached - x.reached || x.first_opened.localeCompare(y.first_opened));
  const children = nest(null);
  return { sharing: pageRow?.sharing ?? 'off', entries: rows.length, capped: rows.length >= SHARE_CAP, brought: children.length, children };
}
