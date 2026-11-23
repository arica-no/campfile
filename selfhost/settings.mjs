// Executed by Compose's init service; imported by every Node maintenance/startup process in the image.
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, closeSync, existsSync, fchownSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = '/settings';
const settingsFile = `${directory}/settings.json`;
const passwordFile = `${directory}/postgres-password`;
const secretNames = ['PREVIEW_SECRET', 'CONSENT_SECRET'];
// The screenshot service's secret has a volume of its own: that service renders strangers' pages, so it must not see the settings volume (the database password is in it).
const screenshotDirectory = '/screenshot-key';
const screenshotFile = `${screenshotDirectory}/secret`;

function validate(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Stored settings must be an object.');
  if (typeof settings.POSTGRES_PASSWORD !== 'string' || !settings.POSTGRES_PASSWORD || /[\r\n]/.test(settings.POSTGRES_PASSWORD)) {
    throw new Error('POSTGRES_PASSWORD must be nonempty and contain no line breaks.');
  }
  for (const name of secretNames) {
    if (typeof settings[name] !== 'string' || settings[name].trim().length < 32) throw new Error(`${name} must have at least 32 characters.`);
  }
  return settings;
}

function readSettings() {
  let text;
  try {
    text = readFileSync(settingsFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Cannot read /settings/settings.json; check the settings volume and permissions.');
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new Error('Invalid /settings/settings.json; restore the settings backup.');
  }
  return validate(settings);
}

function writeAtomic(file, text) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, text);
    fchownSync(descriptor, 1000, 1000); // the image's node user also runs compose exec/run maintenance commands
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    const folder = openSync(directory, 'r');
    try {
      fsyncSync(folder);
    } finally {
      closeSync(folder);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function bundledPassword() {
  if (!process.env.DATABASE_URL) return;
  try {
    const url = new URL(process.env.DATABASE_URL);
    if ((url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname === 'postgres' &&
        url.username === 'campfile' && (!url.port || url.port === '5432') && url.pathname === '/campfile') {
      return decodeURIComponent(url.password) || undefined;
    }
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
}

function initialize() {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  chownSync(directory, 1000, 1000);
  let settings = readSettings();
  const password = process.env.POSTGRES_PASSWORD || bundledPassword();
  if (!settings) {
    if (existsSync(passwordFile)) throw new Error('Incomplete settings volume: restore settings.json before starting.');
    if (readdirSync('/existing-pgdata').length && (!password || secretNames.some((name) => !process.env[name]))) {
      throw new Error('Existing PostgreSQL data requires its original database password, PREVIEW_SECRET and CONSENT_SECRET, or restored settings.json.');
    }
    settings = validate({
      POSTGRES_PASSWORD: password || randomBytes(32).toString('hex'),
      PREVIEW_SECRET: process.env.PREVIEW_SECRET || randomBytes(32).toString('hex'),
      CONSENT_SECRET: process.env.CONSENT_SECRET || randomBytes(32).toString('hex'),
    });
    writeAtomic(settingsFile, `${JSON.stringify(settings)}\n`);
  }
  const effective = validate({
    ...settings,
    POSTGRES_PASSWORD: password || settings.POSTGRES_PASSWORD,
    PREVIEW_SECRET: process.env.PREVIEW_SECRET || settings.PREVIEW_SECRET,
    CONSENT_SECRET: process.env.CONSENT_SECRET || settings.CONSENT_SECRET,
  });
  // JSON is the authority: a crash before this second write is recovered without generating new secrets.
  writeAtomic(passwordFile, effective.POSTGRES_PASSWORD);
  // Made once, with or without the screenshot service: the volume costs nothing, and turning the service on later needs no step.
  if (!existsSync(screenshotFile) || readFileSync(screenshotFile, 'utf8').trim().length < 32) {
    mkdirSync(screenshotDirectory, { recursive: true });
    const temporary = `${screenshotFile}.tmp`;
    writeFileSync(temporary, randomBytes(32).toString('hex'), { mode: 0o400 });
    chownSync(temporary, 1000, 1000); // read by the app and by the service, both the image's node user
    renameSync(temporary, screenshotFile);
  }
}

function preload() {
  if (!process.env.SCREENSHOT_SECRET && existsSync(screenshotFile)) process.env.SCREENSHOT_SECRET = readFileSync(screenshotFile, 'utf8').trim();
  const settings = readSettings();
  if (!settings) {
    if (process.env.DATABASE_URL && secretNames.every((name) => process.env[name])) return; // manual external-database containers
    throw new Error('Missing /settings/settings.json. Run docker compose up to initialize settings, or supply DATABASE_URL, PREVIEW_SECRET and CONSENT_SECRET.');
  }
  for (const name of secretNames) process.env[name] ||= settings[name];
  // start.sh exports the restricted app URL; never replace it with owner credentials.
  process.env.DATABASE_URL ||= `postgres://campfile:${encodeURIComponent(process.env.POSTGRES_PASSWORD || settings.POSTGRES_PASSWORD)}@postgres:5432/campfile`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) initialize();
else preload();
