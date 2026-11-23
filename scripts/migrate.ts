// Applies migrations/*.sql in name order, once each, to the database in DATABASE_URL.
import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Set DATABASE_URL to the Postgres connection string.');
  process.exit(1);
}

const dir = new URL('../migrations/', import.meta.url);
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
try {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((row) => row.name));
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    const text = await readFile(new URL(name, dir), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${name})`;
    });
    console.log(`applied ${name}`);
  }
  console.log('Database is up to date.');
} finally {
  await sql.end();
}
