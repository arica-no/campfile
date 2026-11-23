// Static files: the app's public/, where a file answers before the app runs, and the viewer's viewer/public.
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export interface StaticFiles {
  /** What the app gets as `ASSETS`: `/docs` is `docs.html`, `/x` is `x/index.html`; 404 when nothing is there. */
  assets: { fetch(request: Request): Promise<Response> };
  /** A file by its own name, for GET and HEAD, or undefined. Never an `.html` file or a hidden one except `.well-known/`: the .html files in public/ are fragments the app wraps (src/site.ts). */
  exact(request: Request): Promise<Response | undefined>;
}

export function staticFiles(dir: string): StaticFiles {
  const root = resolve(dir);

  async function find(request: Request, pretty: boolean): Promise<Response | undefined> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return undefined; // a malformed %-escape
    }
    const parts = path.split('/').slice(1);
    if (parts.some((part, at) => part === '.' || part === '..' || part.includes('\\') || part.includes('\0') || (part.startsWith('.') && part !== '.well-known') || (!part && at < parts.length - 1))) return undefined;
    for (const candidate of pretty ? [path, `${path}.html`, `${path}/index.html`] : [path]) {
      const file = join(root, candidate);
      const info = file.startsWith(root + sep) ? await stat(file).catch(() => undefined) : undefined;
      if (!info?.isFile() || (!pretty && file.endsWith('.html'))) continue;
      const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
      const headers = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', ETag: etag, 'Cache-Control': 'public, max-age=0, must-revalidate' };
      if (request.headers.get('If-None-Match')?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) return new Response(null, { status: 304, headers });
      return new Response(request.method === 'HEAD' ? null : await readFile(file), { headers });
    }
    return undefined;
  }

  return {
    assets: { fetch: async (request) => (await find(request, true)) ?? new Response('Not found', { status: 404 }) },
    exact: (request) => find(request, false),
  };
}
