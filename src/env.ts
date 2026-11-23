/** The slice of a bucket Campfile uses. Tests pass an in-memory stand-in. */
export interface Bucket {
  put(key: string, value: Uint8Array<ArrayBuffer>): Promise<unknown>;
  /** With `range`, the bucket reads the request's Range header and returns only those bytes; `range` and `size` then say which. */
  get(
    key: string,
    options?: { range: Headers },
  ): Promise<{ body: ReadableStream<Uint8Array>; size?: number; range?: { offset?: number; length?: number; suffix?: number }; uploaded?: Date } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: { key: string; uploaded: Date }[]; truncated: boolean; cursor?: string }>;
}

/** What src/preview.ts asks the screenshot service for. Field names are the service's own (selfhost/screenshot/server.mjs reads the same ones). */
export interface ScreenshotOptions {
  url: string;
  viewport: { width: number; height: number };
  gotoOptions: { waitUntil: 'load'; timeout: number };
  waitForTimeout: number;
  actionTimeout: number;
  /** Seconds. A service may cache a screenshot for a few seconds unless this is 0. */
  cacheTTL: number;
  screenshotOptions: { type: 'jpeg'; quality: number };
  /** A login for the shot, as the site sets it (src/pages.ts: an approval page is shot as its owner). */
  cookies?: { name: string; value: string; url: string; path: string; secure: boolean; httpOnly: boolean; sameSite: 'Lax' }[];
}

/** The slice of the screenshot service Campfile uses: one screenshot action. Answers 429 or 503 when it has no capacity right now. Tests pass a fake. */
export interface Browser {
  quickAction(action: 'screenshot', options: ScreenshotOptions): Promise<Response>;
}

/** The slice of a key-value store the OAuth library (src/connector.ts) uses. Tests pass an in-memory stand-in. */
export interface KeyValueStore {
  get(key: string, options?: unknown): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string; expiration?: number; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
}

/** Bindings both deployables have. Origins have no trailing slash. */
export interface ViewerEnv {
  /** The database connection pool. Tests put a plain Postgres URL in `connectionString`. */
  DB: { connectionString: string };
  PAGES: Bucket;
  /** The app's origin: where the viewer sends a page's owner (their page view, which frames the page's /raw), and where the owner's request emails link to. */
  APP_ORIGIN: string;
  /** A secret, the same in both deployables. The viewer's login cookie, the app's login tickets for it and the owner's view tickets for /raw are HMACs of it (src/keys.ts). */
  PREVIEW_SECRET: string;
  /** Draws the PNG of a title (1200x630) that src/viewer.ts serves as a page's link-preview picture until it has a screenshot. Unset: no such picture. The drawing needs a font and a rendering library, so only selfhost/server.ts sets it (selfhost/title-card.ts). */
  TITLE_CARD?: (title: string) => Promise<Uint8Array<ArrayBuffer>>;
  /** Sends sign-in emails, access requests and approvals (SMTP, self-hosted). Delivery failures reject. Unset in local dev, where emails are logged instead. */
  SEND_EMAIL?: (to: string, subject: string, text: string) => Promise<void>;
  /** Self-hosted without SMTP: SEND_EMAIL prints every email in the server's log, and the login's code screen says where to find the code. */
  EMAIL_IN_LOG?: boolean;
  /** Self-hosted without SMTP, from OWNER_EMAIL and OWNER_PASSWORD: that email may type the password wherever a sign-in code is asked for (checkCode). Only selfhost/server.ts sets it. */
  OWNER_LOGIN?: { email: string; password: string };
  /** The sender of every email, authorized by the email service, e.g. `Campfile <signin@example.com>`. */
  EMAIL_FROM: string;
  /** The viewer's canonical origin (e.g. `https://viewer.example`): page links, and where the owner login returns to. */
  VIEWER_ORIGIN: string;
  /**
   * Where the new sign-up and new page emails (src/signin.ts tellAdmin) go.
   */
  ADMIN_EMAIL: string;
}

/** Bindings of the app: the ones above plus what sign-in needs (src/signin.ts, src/connector.ts). */
export interface AppEnv extends ViewerEnv {
  /** The screenshot service. Unset: no screenshot is tried, and a page has no screenshot. */
  BROWSER?: Browser;
  /** The OAuth library's storage: connector clients, grants and tokens. */
  OAUTH_KV: KeyValueStore;
  /** A secret of 32+ characters. Signs the sign-in page's session cookie and the remembered connector approvals. */
  CONSENT_SECRET: string;
  /** Set by selfhost/server.ts only: this is a self-hosted install, so `/` is its own home page (src/home.ts). */
  SELF_HOSTED?: boolean;
  /** The static files in public/. Tests pass a stand-in. */
  ASSETS: { fetch(request: Request): Promise<Response> };
}
