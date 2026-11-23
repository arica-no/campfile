import type { Context } from './http.ts';

type Handler = (request: Request, ctx: Context) => Response | Promise<Response>;

/** One address: decide before running either app, never retry a 404 on the other. */
export function singleOriginHandler(app: Handler, viewer: Handler): Handler {
  return async (request, ctx) => {
    const path = new URL(request.url).pathname;
    const page = /^\/[A-Za-z0-9]{8}(?:-[A-Za-z0-9]{4})?(?:\/|$)/.test(path);
    const response = await (page || path === '/bar.js' || path.startsWith('/spread/') ? viewer : app)(request, ctx);
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    if (response.headers.get('Content-Type')?.startsWith('text/html') && !/(?:^|;)\s*sandbox(?:\s|;|$)/i.test(csp)) {
      // Trusted UI cannot be framed or retain an opener from an opaque uploaded page's escaped popup.
      if (!/(?:^|;)\s*frame-ancestors\b/i.test(csp)) response.headers.set('Content-Security-Policy', `${csp}${csp ? '; ' : ''}frame-ancestors 'none'`);
      response.headers.set('X-Frame-Options', 'DENY');
      response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      response.headers.set('Referrer-Policy', 'no-referrer');
    }
    return response;
  };
}
