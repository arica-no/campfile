-- The whole schema, in one file. Databases that already exist have 001_init.sql to 027_*.sql recorded in schema_migrations
-- (the old 002_*.sql to 027_*.sql files are gone), so they skip this file and every older name. The next migration MUST be
-- numbered 028_ or higher, so its name was never recorded anywhere. Until the public repo's first release there is none: a schema change goes into
-- this file, and production and preview get it once by hand (docs/operations.md "The first releases").

-- The app and viewer connect as campfile_app: it reads and writes rows but cannot change or drop the schema, create roles or bypass row security.
-- Migrations, scripts/admin.ts and preview-data keep the owner role. Its login password is set once per database, outside migrations (README "Deploy" step 3).
do $$ begin
  if not exists (select from pg_roles where rolname = 'campfile_app') then create role campfile_app; end if;
end $$;
-- A stuck query would otherwise hold a database connection forever.
alter role campfile_app set statement_timeout = '30s';

grant usage on schema public to campfile_app;
grant select, insert, update, delete on all tables in schema public to campfile_app; -- schema_migrations, which scripts/migrate.ts creates first
-- Tables the owner creates below (and in later migrations, and preview-data's restore) get these rights; new columns are covered by the table's.
alter default privileges in schema public grant select, insert, update, delete on tables to campfile_app;
alter default privileges in schema public grant usage on sequences to campfile_app;

-- A tester row is a workspace: one person and their pages (email sign-in, see src/signin.ts).
create table testers (
  id           integer generated always as identity primary key,
  name         text not null unique,
  disabled_at  timestamptz,
  created_at   timestamptz not null default now(),
  email        text unique check (email = lower(email)),
  -- Pages created or updated today (UTC), for the daily limit in src/pages.ts. A counter, not a log: nothing to clean up, and one row lock makes parallel writes count in turn.
  writes_day   date,
  writes       integer not null default 0,
  -- The author's name readers see in the sharing consent modal (src/sharing.ts authorName). Asked once when publishing to anyone with the link.
  -- null = never asked; '' = asked and left blank, so the name derived from the email is used and the question is not asked again.
  display_name text check (char_length(display_name) <= 80),
  -- A workspace with no cap on pages, storage or daily writes (src/pages.ts); the 5 MB per page still applies. Switch it per tester: pnpm admin set-limits.
  unlimited    boolean not null default false
);

-- One row per key: every CLI sign-in adds one, so signing in on another machine leaves the first key working. Only the key's hash is stored.
create table credentials (
  id         integer generated always as identity primary key,
  tester     integer not null references testers (id),
  key_hash   text not null unique,
  created_at timestamptz not null default now()
);
create index credentials_tester_idx on credentials (tester);

-- The one live sign-in code per email, hashed.
create table signin_codes (
  email         text primary key,
  code_hash     text not null,
  expires_at    timestamptz not null,
  attempts      integer not null default 0,
  -- The terms version the code's email named (src/signin.ts TERMS_VERSION). Null: using the code records no acceptance.
  terms_version text
);

-- Every code sent, for the send limits. Rows older than a day are deleted as new codes go out.
create table signin_sends (
  email   text not null,
  ip      text not null,
  sent_at timestamptz not null default now()
);
create index signin_sends_email_idx on signin_sends (email, sent_at);
create index signin_sends_ip_idx on signin_sends (ip, sent_at);

-- Proof that a workspace accepted a version of the terms: who, which email, which version, when.
-- Recorded when a sign-in code is used, since every sign-in page and the code email say that continuing accepts the terms.
create table terms_acceptances (
  tester      integer not null references testers (id),
  email       text not null,
  version     text not null,
  accepted_at timestamptz not null default now(),
  primary key (tester, version)
);

-- Every page id ever issued. Rows are never deleted, so a deleted page's id is never handed out again.
create table page_ids (
  id text primary key check (id ~ '^[A-Za-z0-9]{8}$')
);

-- Page groups (docs/SPEC.md "Page groups"): one level, a page in at most one group, a group belongs to one tester. Deleting a group keeps its pages unless asked (src/groups.ts).
create table page_groups (
  id         text primary key,
  owner      int not null references testers(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index page_groups_owner_name on page_groups (owner, lower(name));
create index page_groups_owner on page_groups (owner);

create table pages (
  id              text primary key references page_ids (id),
  owner           integer not null references testers (id),
  title           text not null,
  size            integer not null,
  file            text not null, -- bucket key of the current HTML; every write goes to a fresh key (see src/pages.ts)
  status          text not null default 'live' check (status in ('live', 'hidden', 'deleted')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Bucket key of the page's link-preview image, or null while it has none (see src/preview.ts and src/pages.ts). Every preview goes to a fresh key.
  preview_file    text,
  -- When the page went public, or null while it is still a draft (see src/pages.ts). A draft opens only with its preview key.
  published_at    timestamptz,
  -- Publish with approval (docs/SPEC.md, src/access.ts). Who can open a published page: anyone with the link, or only approved people.
  access          text not null default 'link' check (access in ('link', 'approval')),
  -- Screenshot retries (docs/SPEC.md "Link previews"): when a page's screenshot was last tried and how many tries in a row have not landed,
  -- so a page whose shot keeps failing waits longer each time and the others get their turn. Both are reset when a screenshot lands.
  preview_tried_at timestamptz,
  preview_tries   integer not null default 0,
  -- "See how it's shared" (docs/SPEC.md, src/sharing.ts): with sharing on, every reader gets their own link, recorded under the link they came through.
  -- Only meaningful while access = 'link'; publishing with approval sets it back to 'off'.
  sharing         text not null default 'off' check (sharing in ('off', 'links', 'emails')),
  -- "How it spread" (docs/SPEC.md): the owner lets anyone with the link see <viewer>/<id>/spread, with no names or emails. Counts only while the page is live, published and access = 'link'.
  spread_public   boolean not null default false,
  group_id        text references page_groups(id) on delete set null,
  -- shootDue (src/pages.ts) claims the pages it is about to shoot, so the 10-minute cron and a wall load at the same time never shoot one page twice.
  -- Cleared when the run ends; a claim left by a run that was cut off lapses after 5 minutes.
  preview_claimed_at timestamptz
);
create index pages_owner_idx on pages (owner);
create index pages_group_id on pages (group_id);

-- The people who asked for, or were given, access to an approval page. Login is one for everyone (docs/SPEC.md "Login"): no access codes are kept here.
create table page_people (
  id           integer generated always as identity primary key,
  page         text not null references pages (id) on delete cascade,
  email        text not null check (email = lower(email)),
  status       text not null check (status in ('waiting', 'approved', 'denied')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  -- Until when an invite opens its page without a screen (src/access.ts): set when the invite is sent, cleared by Say no. Null: the invite only offers its email a login link.
  invite_until timestamptz,
  -- How many times an invite has logged its email in: reset when the invite is sent; at INVITE_OPENS it only offers its email a login link.
  invite_opens int not null default 0,
  unique (page, email)
);

-- Every email an owner lets in, saved per workspace so they can pick it again for another page (docs/SPEC.md "Publish with approval").
-- It stays after Remove, Say no and after its page is deleted, until the owner presses Forget; the workspace's own deletion removes the rest.
create table remembered_emails (
  owner   integer not null references testers (id) on delete cascade,
  email   text not null check (email = lower(email)),
  used_at timestamptz not null default now(),
  primary key (owner, email)
);

-- Open counts (docs/SPEC.md "Open counts"): one row per page, day and visitor. `visitor` is sha256 of that day's salt, the page, the IP and the browser;
-- no IP, browser or email is stored, and once the daily cron deletes the salt nobody can match a visitor again. No foreign key: counts outlive their page.
create table page_visits (
  page    text not null,
  day     date not null,
  visitor bytea not null,
  country text,
  opens   integer not null default 1,
  primary key (page, day, visitor)
);
create table visit_salts (
  day  date primary key,
  salt text not null
);

-- "See how it's shared" (docs/SPEC.md, src/sharing.ts): a reader who allows gets their own link /<id>-<code>, kept by a random key in their browser.
-- One row per entry, recorded under the link they came through: parent null = they came through the author's plain link. label = the email they typed, unchecked.
-- (page, parent) points into the same page, so a tree never crosses pages; deleting the page deletes its tree and the emails.
-- key_hash = sha256 hex of the browser's key: the only thing that finds, keeps or deletes ("Turn off") a browser's entry.
-- ai = the AI fetcher's name (Claude, ChatGPT, ...); an AI entry has no key. Its one-per-(page, parent, ai, UTC day) rule is kept by src/sharing.ts under the page lock,
-- not by an index: Turn off moves children up to their parent, which may then hold two same-day entries of one AI.
create table share_links (
  page       text not null references pages (id) on delete cascade,
  code       text not null,
  parent     text,
  label      text check (char_length(label) <= 254),
  created_at timestamptz not null default now(),
  ai         text,
  key_hash   text,
  country    text check (country ~ '^[A-Z]{2}$'),
  device     text check (device in ('phone', 'computer')),
  primary key (page, code),
  foreign key (page, parent) references share_links (page, code) on delete cascade,
  constraint share_links_key_or_ai check ((key_hash is null) <> (ai is null))
);
create unique index share_links_key on share_links (page, key_hash) where key_hash is not null;

-- The link-preview screenshot of a public spread page, one per design (bucket key spread/<id>/<design>.jpg, src/manage.ts shootSpread).
-- Only the last try's time: a claim, so many crawlers asking at once start one screenshot, not one each.
create table spread_shots (
  page     text not null references pages (id) on delete cascade,
  design   text not null check (design in ('ember', 'rings', 'cascade')),
  tried_at timestamptz not null default now(),
  primary key (page, design)
);

