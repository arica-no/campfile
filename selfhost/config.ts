// What server.ts needs from the environment, checked once at start: a mistake stops the container with a message, instead of turning up later as a broken sign-in or a page that is not isolated.
import { BlockList } from 'node:net';
import { trustedProxies } from './http.ts';

export interface Config {
  databaseUrl: string;
  /** `https://campfile.example.com`: no trailing slash, no path. */
  appOrigin: string;
  viewerOrigin: string;
  previewSecret: string;
  consentSecret: string;
  emailFrom: string;
  adminEmail: string;
  smtp?: { host: string; port: number; auth?: { user: string; pass: string } };
  /** OWNER_EMAIL and OWNER_PASSWORD, only while there is no SMTP: that one email may type the password wherever a sign-in code is asked for. */
  ownerLogin?: { email: string; password: string };
  /** SCREENSHOT_URL, when this install runs the screenshot service (selfhost/screenshot/): where it is, and the secret the two share. */
  screenshot?: { url: string; secret: string };
  dataDir: string;
  appPort: number;
  viewerPort: number;
  trusted: BlockList;
  /** Settings that work but are probably not what the operator wants. */
  warnings: string[];
}

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

/** Reads and checks the settings in docs/DEPLOY.md and selfhost/.env.example. Throws one error listing everything wrong. */
export function readConfig(vars: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const warnings: string[] = [];
  const get = (name: string) => vars[name]?.trim() || undefined;
  const need = (name: string, wrong?: (value: string) => boolean, because = '') => {
    const value = get(name);
    if (!value) problems.push(`${name} is not set.`);
    else if (wrong?.(value)) problems.push(`${name} ${because}`);
    return value ?? '';
  };
  const secret = (name: string) => need(name, (value) => value.length < 32, 'must be at least 32 characters.');
  const origin = (name: string, fallback: string): URL | undefined => {
    const value = get(name) ?? fallback;
    const url = URL.canParse(value) ? new URL(value) : undefined;
    if (value && (!url || !/^https?:$/.test(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username)) problems.push(`${name} must be an address like https://campfile.example.com, with no path.`);
    else if (url?.protocol === 'http:' && !LOCAL.includes(url.hostname)) problems.push(`${name} must be https:// unless it is localhost: the login cookies are Secure, and a browser drops them over http.`);
    return url;
  };
  const port = (name: string, fallback: number) => {
    const value = Number(get(name) ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 65535) problems.push(`${name} must be a port number.`);
    return value;
  };

  const databaseUrl = need('DATABASE_URL', (value) => !/^postgres(ql)?:\/\//.test(value), 'must be a postgres:// connection string.');
  const app = origin('APP_ORIGIN', 'http://localhost:8787');
  const viewer = origin('VIEWER_ORIGIN', app?.origin ?? 'http://localhost:8787');
  const previewSecret = secret('PREVIEW_SECRET');
  const consentSecret = secret('CONSENT_SECRET');
  const emailFrom = get('EMAIL_FROM') ?? 'Campfile <signin@localhost>';
  const adminEmail = get('ADMIN_EMAIL') ?? 'admin@localhost';
  if (!adminEmail.includes('@')) problems.push('ADMIN_EMAIL must be an email address.');
  const appPort = port('APP_PORT', 8787);
  const viewerPort = port('VIEWER_PORT', 8788);
  if (app?.origin !== viewer?.origin && appPort === viewerPort) problems.push('APP_PORT and VIEWER_PORT must differ.');

  let trusted = new BlockList();
  try {
    trusted = trustedProxies(get('TRUSTED_PROXIES') ?? '');
  } catch (error) {
    problems.push((error as Error).message);
  }

  // Distinct origins retain separate-site isolation; one origin relies on the opaque HTML sandbox.
  if (app && viewer && app.origin !== viewer.origin && !(LOCAL.includes(app.hostname) && LOCAL.includes(viewer.hostname))) {
    const [a, b] = [app.hostname, viewer.hostname];
    const [x, y] = [a.split('.'), b.split('.')];
    let shared = 0; // how many labels the two names end with in common
    while (shared < Math.min(x.length, y.length) && x.at(-1 - shared) === y.at(-1 - shared)) shared++;
    if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) problems.push(`APP_ORIGIN (${a}) and VIEWER_ORIGIN (${b}) must be on different sites, not one name or one under the other: the pages would not be isolated from the app.`);
    else if (shared >= 2) warnings.push(`APP_ORIGIN and VIEWER_ORIGIN both end in ${x.slice(-shared).join('.')}. That is fine only if that ending is a public suffix (publicsuffix.org/list), as duckdns.org is; otherwise browsers see one site and the pages are not isolated from the app. cloudapp.azure.com, sslip.io and nip.io are not public suffixes: use two different domains, or one name under sslip.io and one under nip.io.`);
  }
  const smtpHost = get('SMTP_HOST');
  const smtpPort = port('SMTP_PORT', 587);
  const smtpUser = get('SMTP_USER');
  const smtpPassword = vars.SMTP_PASSWORD || undefined; // passwords may start or end with spaces
  if (!smtpHost && (get('SMTP_PORT') || smtpUser || smtpPassword)) problems.push('SMTP_HOST is required when SMTP_PORT, SMTP_USER or SMTP_PASSWORD is set.');
  if (Boolean(smtpUser) !== Boolean(smtpPassword)) problems.push('SMTP_USER and SMTP_PASSWORD must be set together.');
  const smtp = smtpHost ? { host: smtpHost, port: smtpPort, auth: smtpUser && smtpPassword ? { user: smtpUser, pass: smtpPassword } : undefined } : undefined;
  if (!smtp) warnings.push('SMTP_HOST is not set: every email, sign-in codes included, is printed in this log instead of sent.');
  const ownerEmail = get('OWNER_EMAIL')?.toLowerCase();
  const ownerPassword = vars.OWNER_PASSWORD || undefined; // passwords may start or end with spaces
  if (Boolean(ownerEmail) !== Boolean(ownerPassword)) problems.push('OWNER_EMAIL and OWNER_PASSWORD must be set together.');
  if (ownerEmail && !ownerEmail.includes('@')) problems.push('OWNER_EMAIL must be an email address.');
  if (ownerPassword && ownerPassword.length < 12) problems.push('OWNER_PASSWORD must be at least 12 characters.');
  if (ownerEmail && smtp) warnings.push('OWNER_PASSWORD is ignored: SMTP is set, so everyone signs in with an emailed code.');
  const ownerLogin = ownerEmail && ownerPassword && !smtp ? { email: ownerEmail, password: ownerPassword } : undefined;
  const shotUrl = get('SCREENSHOT_URL');
  const shotAddress = shotUrl && URL.canParse(shotUrl) ? new URL(shotUrl) : undefined;
  if (shotUrl && (!shotAddress || !/^https?:$/.test(shotAddress.protocol) || shotAddress.pathname !== '/' || shotAddress.search || shotAddress.hash || shotAddress.username)) problems.push('SCREENSHOT_URL must be an address like http://screenshot:3000, with no path.');
  const screenshot = shotUrl ? { url: shotAddress?.origin ?? '', secret: secret('SCREENSHOT_SECRET') } : undefined;

  if (problems.length || !app || !viewer) throw new Error(`Campfile cannot start:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  return { databaseUrl, appOrigin: app.origin, viewerOrigin: viewer.origin, previewSecret, consentSecret, emailFrom, adminEmail, smtp, ownerLogin, screenshot, dataDir: get('DATA_DIR') ?? './data', appPort, viewerPort, trusted, warnings };
}
