// Admin CLI: pnpm admin add-tester <name> | set-email <name> <email> | set-limits <name or email> standard|unlimited | disable-tester <name> | takedown <page-id> | restore <page-id> | list-testers | stats
// Needs DATABASE_URL; add-tester also needs APP_ORIGIN (the app's URL, no trailing slash).
import postgres from 'postgres';
import { newKey, sha256Hex } from '../src/keys.ts';
import { email } from '../src/signin.ts';

let usage = `Usage:
  pnpm admin add-tester <name>           create a tester and print their key (shown only once)
  pnpm admin set-email <name> <email>    let a tester sign in with their email, into their existing workspace
  pnpm admin set-limits <name or email> standard|unlimited
                                         unlimited: no cap on pages, storage or daily changes, and 25 MB per page instead of 5; standard: back to the normal limits
  pnpm admin disable-tester <name>       stop a tester's keys, connectors and sign-ins from working, and take their pages offline
  pnpm admin takedown <page-id>          take one page offline for everyone, its owner included (abuse reports)
  pnpm admin restore <page-id>           bring a taken-down page back, as it was
  pnpm admin list-testers
  pnpm admin stats                       page opens of the last 30 days: per day, per page and per country`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, name, address] = process.argv.slice(2);
const needs: Record<string, number> = { 'add-tester': 1, 'set-email': 2, 'set-limits': 2, 'disable-tester': 1, takedown: 1, restore: 1, 'list-testers': 0, stats: 0 };
if (!(command in needs) || [name, address].filter(Boolean).length !== needs[command]) fail(usage);

const databaseUrl = process.env.DATABASE_URL ?? fail('Set DATABASE_URL to the Postgres connection string.');
const appOrigin = process.env.APP_ORIGIN?.replace(/\/+$/, '');
if (command === 'add-tester' && !appOrigin) fail('Set APP_ORIGIN to the app URL first, for example: APP_ORIGIN=https://campfile.example.com');

const sql = postgres(databaseUrl, { max: 1 });
try {
  if (command === 'add-tester') {
    // A sign-up names its workspace after its email (src/signin.ts), so an email-shaped name would refuse that email's sign-up.
    if (name.includes('@')) fail(`A tester's name is not an email address. Add "${name.split('@')[0]}", then "pnpm admin set-email ${name.split('@')[0]} ${name}".`);
    const key = newKey();
    const added = await sql`
      with t as (insert into testers (name) values (${name}) on conflict (name) do nothing returning id)
      insert into credentials (tester, key_hash) select id, ${await sha256Hex(key)} from t returning id`;
    if (!added.length) fail(`A tester named "${name}" already exists.`);
    console.log(`Tester "${name}" created. The key is shown only once, so copy it now.

Key:       ${key}
Connector: ${appOrigin}/mcp
  Claude or ChatGPT: add it as a custom connector and sign in with the tester's email. Run "pnpm admin set-email ${name} <email>" first, or that email gets a new, empty workspace.
  Claude Code, Codex and other agents that run commands: tell them to read ${appOrigin}/agents and give them the Key.

Test it with curl:
  curl -sS -X POST ${appOrigin}/api/pages \\
    -H "Authorization: Bearer ${key}" \\
    -H "Content-Type: application/json" \\
    -d '{"title": "Hello", "html": "<h1>Hello from Campfile</h1>"}'`);
  } else if (command === 'set-email') {
    const parsed = email.safeParse(address);
    if (!parsed.success) fail(parsed.error.issues[0].message);
    const [taken] = await sql<{ name: string }[]>`select name from testers where email = ${parsed.data} and name <> ${name}`;
    if (taken) fail(`${parsed.data} already belongs to "${taken.name}".`);
    // A workspace made by signing in is named after its email: it takes the new one, so the old email can sign up again (src/signin.ts).
    const updated = await sql`update testers set email = ${parsed.data}, name = case when name = email then ${parsed.data} else name end where name = ${name} returning name`;
    if (!updated.length) fail(`There is no tester named "${name}".`);
    console.log(`"${updated[0].name}" now signs in as ${parsed.data}, into the same workspace and pages.`);
  } else if (command === 'set-limits') {
    if (address !== 'standard' && address !== 'unlimited') fail('Limits are "standard" or "unlimited".');
    // name and email are each unique, but one tester's name can be another's email: find exactly one before changing anything.
    const found = await sql<{ id: number; name: string; email: string | null }[]>`
      select id, name, email from testers where name = ${name} or email = ${name.trim().toLowerCase()}`;
    if (!found.length) fail(`There is no tester named "${name}" and none with that email.`);
    if (found.length > 1) fail(`"${name}" matches more than one tester: ${found.map((t) => `"${t.name}" (${t.email ?? 'no email'})`).join(' and ')}. Nothing changed.`);
    const updated = await sql<{ name: string }[]>`update testers set unlimited = ${address === 'unlimited'} where id = ${found[0].id} returning name`;
    console.log(`"${updated[0].name}" now has ${address === 'unlimited' ? 'no cap on pages, storage or daily changes, and 25 MB per page' : 'the standard limits'}.`);
  } else if (command === 'disable-tester') {
    const disabled = await sql`update testers set disabled_at = now() where name = ${name} and disabled_at is null returning id`;
    if (!disabled.length) fail(`There is no active tester named "${name}".`);
    console.log(`Disabled "${name}". Their keys and connectors no longer work, they cannot sign in, and their pages are offline.`);
  } else if (command === 'takedown') {
    const hidden = await sql`update pages set status = 'hidden', updated_at = now() where id = ${name} and status = 'live' returning id`;
    if (!hidden.length) fail(`There is no live page "${name}".`);
    console.log(`Page "${name}" is offline: its links answer 404 and its owner no longer sees it. To undo: pnpm admin restore ${name}`);
  } else if (command === 'restore') {
    const restored = await sql`update pages set status = 'live', updated_at = now() where id = ${name} and status = 'hidden' returning id`;
    if (!restored.length) fail(`There is no taken-down page "${name}".`);
    console.log(`Page "${name}" is back, as it was when it was taken down.`);
  } else if (command === 'stats') {
    // Visitors are approximate (docs/SPEC.md "Open counts"): one per page, day, IP and browser.
    const days = await sql<{ day: Date; opens: number; visitors: number; pages: number }[]>`
      select day, sum(opens)::int as opens, count(*)::int as visitors, count(distinct page)::int as pages
      from page_visits where day > current_date - 30 group by day order by day desc`;
    if (!days.length) console.log('No page opens in the last 30 days.\n');
    console.log(`${'Day'.padEnd(12)}${'Opens'.padStart(8)}${'Visitors'.padStart(10)}${'Pages'.padStart(8)}`);
    for (const row of days) console.log(`${row.day.toISOString().slice(0, 10).padEnd(12)}${String(row.opens).padStart(8)}${String(row.visitors).padStart(10)}${String(row.pages).padStart(8)}`);
    const pages = await sql<{ page: string; title: string; owner: string; opens: number; visitors: number }[]>`
      select v.page, coalesce(p.title, '(deleted)') as title, coalesce(t.name, '-') as owner, sum(v.opens)::int as opens, count(*)::int as visitors
      from page_visits v left join pages p on p.id = v.page left join testers t on t.id = p.owner
      where v.day > current_date - 30 group by v.page, p.title, t.name order by opens desc, v.page limit 20`;
    console.log(`\n${'Page'.padEnd(10)}${'Opens'.padStart(8)}${'Visitors'.padStart(10)}  ${'Owner'.padEnd(16)}Title`);
    for (const row of pages) console.log(`${row.page.padEnd(10)}${String(row.opens).padStart(8)}${String(row.visitors).padStart(10)}  ${row.owner.slice(0, 15).padEnd(16)}${row.title.slice(0, 60)}`);
    const countries = await sql<{ country: string; opens: number; visitors: number }[]>`
      select coalesce(country, '??') as country, sum(opens)::int as opens, count(*)::int as visitors
      from page_visits where day > current_date - 30 group by 1 order by opens desc, 1`;
    console.log(`\n${'Country'.padEnd(10)}${'Opens'.padStart(8)}${'Visitors'.padStart(10)}`);
    for (const row of countries) console.log(`${row.country.padEnd(10)}${String(row.opens).padStart(8)}${String(row.visitors).padStart(10)}`);
  } else {
    const testers = await sql<{ name: string; email: string | null; disabled_at: Date | null; unlimited: boolean; created_at: Date }[]>`
      select name, email, disabled_at, unlimited, created_at from testers order by created_at, id`;
    if (!testers.length) console.log('No testers yet.');
    for (const tester of testers) {
      console.log(
        `${tester.name.padEnd(24)}${(tester.email ?? '-').padEnd(32)}${(tester.disabled_at ? 'disabled' : 'active').padEnd(10)}${(tester.unlimited ? 'unlimited' : 'standard').padEnd(11)}${tester.created_at.toISOString().slice(0, 10)}`,
      );
    }
  }
} finally {
  await sql.end();
}
