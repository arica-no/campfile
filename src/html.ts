/** Escapes text for HTML element content and quoted attribute values. */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
/** An owner's name in a page, usually their email (src/signin.ts). email_off: a CDN's email obfuscation would show "[email protected]", and its decoding script can't run under our CSP. */
export const ownerText = (name: string) => `<!--email_off-->${escapeHtml(name)}<!--/email_off-->`;

/** The Campfile mark (flame over two pages) in amber, on a 32-unit grid. The viewer's signature and the site's header draw it too. */
export const LOGO_MARK =
  '<path fill="#F2A541" d="M16 18.8C12.2 18.8 9.8 16.5 9.8 13.3C9.8 10.1 12.5 8.2 13.6 4.6C14.8 6.1 15.4 7.5 15.5 9C16.5 8 17.2 6.4 17.2 4C20 5.9 22.8 9.2 22.8 13.3C22.8 16.5 19.8 18.8 16 18.8Z"/><rect x="8" y="20.5" width="16" height="2.6" rx="1.3" fill="#F2A541"/><rect x="10.5" y="24.5" width="11" height="2.6" rx="1.3" fill="#F2A541"/>';
/** The mark on its ember square, the app's favicon. The viewer serves the same drawing as a static file: viewer/public/favicon.svg. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#16130F"/>${LOGO_MARK}</svg>`;
/** The app pages' icon links. The .ico and the PNG are static files in public/: directory listings and older Safari need a raster icon. */
export const FAVICON_LINKS =
  '<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon-192.png" sizes="192x192" type="image/png"><link rel="icon" href="/favicon.svg" type="image/svg+xml">';
