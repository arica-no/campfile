// The request headers that say who is calling. Only the server in front of the code sets them: it drops what a client sends under these names (selfhost/http.ts), so the code trusts them.

/** The client's IP address: the sign-in, approval and report limits and the visitor hashes count by it. */
export const CLIENT_IP = 'Campfile-Client-IP';
/** The client's country as two letters, where the server knows it (countryOf in src/sharing.ts). */
export const CLIENT_COUNTRY = 'Campfile-Client-Country';
/** Present on the requests of the browser that takes link-preview screenshots (src/preview.ts), which sends a normal Chrome User-Agent. */
export const SCREENSHOT = 'Campfile-Screenshot';
