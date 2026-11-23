// Gives the role of migrations/001_init.sql a login with a new random password and prints the connection string the app should use. selfhost/start.sh runs it with the owner's DATABASE_URL.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL must be set.');

const password = randomBytes(24).toString('hex'); // new at every start and only in this container, so nobody has one to set or leak
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} }); // a notice would land in the string start.sh captures
try {
  // shortcut: the role was campfire_app until 2026-11, and a database set up before has only that one; drop this once no self-host predates the public repo's first release.
  await sql`do $$ begin
    if exists (select from pg_roles where rolname = 'campfire_app') and not exists (select from pg_roles where rolname = 'campfile_app') then alter role campfire_app rename to campfile_app; end if;
  end $$`;
  // ALTER ROLE takes no parameters, so the server quotes the password.
  const [{ statement }] = await sql<{ statement: string }[]>`select format('alter role campfile_app login password %L', ${password}::text) as statement`;
  await sql.unsafe(statement);
} finally {
  await sql.end();
}

const url = new URL(DATABASE_URL);
url.username = 'campfile_app';
url.password = password;
console.log(url.href);
