// The code's two stores on a directory: FileBucket holds the pages' files, FileKv the OAuth library's entries (types in src/env.ts).
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Bucket, KeyValueStore } from '../src/env.ts';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Writes through a temporary file next to the target, so neither a reader nor a crash ever sees half a file. */
async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'w');
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    const dir = await open(dirname(path), 'r'); // the new name is durable only once its directory is
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** A Range header as the bucket reads it: one range (`bytes=a-b`, `a-`, `-n`) as an offset and length inside the object. Anything else, or a range past the end, gets the whole object. */
function byteRange(header: string | null, size: number): { offset: number; length: number } | undefined {
  const [, from = '', to = ''] = /^bytes=(\d*)-(\d*)$/.exec(header ?? '') ?? [];
  if (!from && !to) return undefined;
  const offset = from ? Number(from) : Math.max(0, size - Number(to));
  const end = from && to ? Math.min(Number(to), size - 1) : size - 1;
  return offset <= end ? { offset, length: end - offset + 1 } : undefined;
}

/** Objects as files under `root`, one file per key (`pages/<id>/<random>.html`). */
export class FileBucket implements Bucket {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** A key never leaves the directory, whatever builds it. */
  #path(key: string): string {
    if (!key.split('/').every((part) => part && part !== '.' && part !== '..')) throw new Error(`Not a storage key: ${key}`);
    return join(this.root, key);
  }

  async put(key: string, value: Uint8Array<ArrayBuffer>) {
    await writeAtomic(this.#path(key), value);
  }

  async get(key: string, options?: { range: Headers }) {
    const path = this.#path(key);
    const info = await stat(path).catch((error) => (missing(error) ? undefined : Promise.reject(error)));
    if (!info?.isFile()) return null;
    const range = options && byteRange(options.range.get('Range'), info.size);
    const body = Readable.toWeb(createReadStream(path, range && { start: range.offset, end: range.offset + range.length - 1 })) as ReadableStream<Uint8Array>;
    return { body, size: info.size, range, uploaded: info.mtime };
  }

  async delete(keys: string | string[]) {
    for (const key of [keys].flat()) {
      const path = this.#path(key);
      await rm(path, { force: true });
      if (dirname(path) !== this.root) await rmdir(dirname(path)).catch(() => {}); // pages/<id>/ goes with its last file; a directory still in use stays
    }
  }

  /** Everything under the prefix in one answer: a directory walk has no page size to continue from. */
  async list({ prefix }: { prefix: string; cursor?: string }) {
    const at = prefix.lastIndexOf('/');
    const parent = at < 0 ? '' : prefix.slice(0, at);
    const objects: { key: string; uploaded: Date }[] = [];
    const entries = await readdir(parent ? this.#path(parent) : this.root, { withFileTypes: true, recursive: true }).catch((error) => (missing(error) ? [] : Promise.reject(error)));
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      const key = relative(this.root, path).split(sep).join('/');
      const info = key.startsWith(prefix) ? await stat(path).catch(() => undefined) : undefined; // gone since the walk: skip
      if (info) objects.push({ key, uploaded: info.mtime });
    }
    return { objects, truncated: false };
  }
}

interface Entry {
  key: string;
  value: string;
  /** Unix seconds. */
  expires?: number;
  metadata?: unknown;
}

/** The kinds of key whose second field is a user's id (`grant:<user>:<id>`, `token:<user>:<grant>:<id>`): inside the kind's directory each user has one of their own. */
const USER_KINDS = ['grant', 'token'];
const USER_KIND_DIRS = USER_KINDS.map(hash);

const subdirs = async (dir: string) => (await readdir(dir, { withFileTypes: true }).catch((error) => (missing(error) ? [] : Promise.reject(error)))).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));

/**
 * KV entries as JSON files named by the SHA-256 of the key, which is the OAuth library's `grant:…` and `token:…` text: any length, any characters.
 * Each kind of key, the text before its first `:`, has a directory of its own, so listing `grant:` reads no token; a grant or a token has one more for its user, so listing `grant:7:` reads no other user's grant.
 * Expired entries are gone for readers at once and deleted when read or purged.
 */
export class FileKv implements KeyValueStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  #file = (key: string) => {
    const [kind, user = ''] = key.split(':', 2);
    return join(this.dir, hash(kind), ...(USER_KINDS.includes(kind) ? [hash(user)] : []), hash(key));
  };

  async #read(path: string): Promise<Entry | undefined> {
    const text = await readFile(path, 'utf8').catch((error) => (missing(error) ? undefined : Promise.reject(error)));
    if (text === undefined) return undefined;
    const entry: Entry = JSON.parse(text);
    if (entry.expires === undefined || entry.expires > Date.now() / 1000) return entry;
    await rm(path, { force: true });
    return undefined;
  }

  /** The directories that can hold a key starting with `prefix`: with a user in it (`grant:7:`) that user's, otherwise every user's of the kind (`grant:`, `grant:7`, which `grant:70:` also starts with) or of every kind (no `:`). */
  async #dirs(prefix: string): Promise<string[]> {
    const [kind, user, rest] = prefix.split(':', 3);
    const dirs: string[] = [];
    for (const dir of user === undefined ? await subdirs(this.dir) : [join(this.dir, hash(kind))]) {
      if (!USER_KIND_DIRS.includes(basename(dir))) dirs.push(dir);
      else if (rest === undefined) dirs.push(...(await subdirs(dir)));
      else dirs.push(join(dir, hash(user)));
    }
    return dirs;
  }

  /** The live entries whose key starts with `prefix`, read 64 files at a time so that a big directory is never in memory whole. shortcut: every list reads all the files of its kind, or of its user; keep an index when that is slow. */
  async *#scan(prefix: string): AsyncGenerator<Entry> {
    for (const dir of await this.#dirs(prefix)) {
      const names = (await readdir(dir).catch((error) => (missing(error) ? [] : Promise.reject(error)))).filter((name) => !name.endsWith('.tmp'));
      for (let start = 0; start < names.length; start += 64) {
        for (const entry of await Promise.all(names.slice(start, start + 64).map((name) => this.#read(join(dir, name))))) if (entry?.key.startsWith(prefix)) yield entry;
      }
    }
  }

  async get(key: string, options?: unknown) {
    const entry = await this.#read(this.#file(key));
    if (!entry) return null;
    const type = typeof options === 'string' ? options : (options as { type?: string } | undefined)?.type;
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }) {
    const expires = options?.expiration ?? (options?.expirationTtl === undefined ? undefined : Date.now() / 1000 + options.expirationTtl);
    const entry: Entry = { key, value, expires, metadata: options?.metadata };
    await writeAtomic(this.#file(key), new TextEncoder().encode(JSON.stringify(entry)));
  }

  async delete(key: string) {
    await rm(this.#file(key), { force: true });
  }

  /** In key order; `cursor` is the last key of the previous page. */
  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    const { prefix = '', cursor, limit = 1000 } = options ?? {};
    const found: { name: string; expiration?: number; metadata?: unknown }[] = []; // no values: a big prefix must not hold every entry's text
    for await (const entry of this.#scan(prefix)) if (cursor === undefined || entry.key > cursor) found.push({ name: entry.key, expiration: entry.expires, metadata: entry.metadata });
    found.sort((a, b) => (a.name < b.name ? -1 : 1));
    const keys = found.slice(0, limit);
    const complete = keys.length === found.length;
    return { keys, list_complete: complete, cursor: complete ? undefined : keys.at(-1)?.name };
  }

  /** Deletes the expired entries nobody has asked for since. */
  async purge() {
    for await (const _ of this.#scan('')); // reading an expired entry deletes it
  }
}
