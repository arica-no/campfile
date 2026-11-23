<p align="center">
  <img src="viewer/public/favicon.svg" alt="Campfile" width="96" />
</p>

<h1 align="center">Campfile</h1>

<p align="center">
  <a href="#quick-start">Quick start</a> · <a href="docs/DEPLOY.md">Run your own</a> · <a href="docs/DEPLOY-ADVANCED.md">Advanced hosting</a> · <a href="#development">Development</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license" /></a>
  <a href="https://github.com/arica-no/campfile/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/arica-no/campfile/ci.yml?branch=main&label=tests&labelColor=333333&color=666666" alt="Test status" /></a>
  <a href="docs/DEPLOY.md"><img src="https://img.shields.io/badge/runs%20on-Docker%20Compose-666666?labelColor=333333&logo=docker&logoColor=white" alt="Runs on Docker Compose" /></a>
  <a href="https://github.com/arica-no/campfile/stargazers"><img src="https://img.shields.io/github/stars/arica-no/campfile?labelColor=333333&color=666666&logo=github" alt="GitHub stars" /></a>
</p>

---

<img src="docs/readme/prototype.webp" alt="A clickable prototype of a booking flow, made by an AI, open under Campfile's bar: the page title, Shared on Campfile, Log in and full screen" width="100%">

**One place for the prototypes, architecture pages and reviews your AIs make. It runs on your own server, and everyone who should see a page gets a link.**

When you build with AI, the output ends up scattered: an artifact inside one chat app, an HTML file in a repo nobody opens, a canvas that only works for people with the same subscription. Campfile is one small server where any AI puts a page, and where you, your other AIs, your colleagues and your testers open it by link.

- **Any AI can write to it**: Claude and ChatGPT through an MCP connector; Claude Code, Codex and anything else that runs `curl` through the HTTP API.
- **Any AI can read it back**: list your pages, read one, update it. The review one model wrote is the next model's input.
- **Yours, not a vendor's**: one Docker Compose command, Postgres and files on your own disk, MIT licence. No AI company's account decides who can open a page.
- **Groups keep a project together**: the prototypes of one feature, the rounds of one review. The AI looks for the group before it makes the page.
- **One link per page**: update the page and the link stays, so testers always open the newest version.
- **Draft until you publish**: a new page opens only for you. Then you choose: anyone with the link, or only the people you approve by email.
- **Pages run in a sandbox**: no cookies, no storage, nothing loaded or fetched from other servers, and no way into your Campfile account. One known gap: in Chrome a page can still reach a server over WebRTC, which shows that server the visitor's IP address ([isolation check](docs/DEPLOY-ADVANCED.md#4-isolation)).

---

## What goes on it

Anything that fits in one self-contained HTML file. A page can be 5 MB, or 25 MB once you [lift the limit](docs/DEPLOY-ADVANCED.md#admin). Above about 20 MB the AI sends a link to the file (`source_url`) instead of the HTML itself.

**Prototypes.** Something to click through, sent to testers with a list of what to try. The picture at the top is one.

**Architecture pages.** The diagram and the decisions, for your colleagues and for the next AI that needs the context.

<img src="docs/readme/architecture.webp" alt="An architecture page: a system diagram in lanes with the booking request numbered step by step, under Campfile's bar" width="100%">

**Reviews.** Of a change, a design or a plan, written by one model and read by another.

<img src="docs/readme/review.webp" alt="A code review page: the verdict, a summary row and the first blocking finding with its code excerpt, under Campfile's bar" width="100%">

**Everything else an agent reports.** Test results, weekly reports from a pipeline, design system pages, explainers.

## Your pages

<img src="docs/readme/wall.webp" alt="Your pages: three groups (Tern, Software factory, Design system) and single pages, each card showing a small screenshot of its page, marked Live, Approval or Unpublished, with its visitors this week" width="100%">

Everything you and your AIs have put up, by group. Each card says who can open the page and how many visitors it had this week. The pictures on the cards are screenshots of the pages.

## Quick start

You need Docker with Compose and Git ([Before you start](docs/DEPLOY.md#before-you-start) has the commands, and what a domain needs).

```sh
git clone https://github.com/arica-no/campfile
cd campfile/selfhost
./install.sh
```

It asks where Campfile runs (only this computer, or a domain name), whether to take screenshots for link previews, and how you sign in, then starts Campfile. Open the address it prints: **Get started** on the home page lists what is left to set up and ticks each step once it is done. On a remote server without a domain, run `ssh -L 8787:localhost:8787 <user>@<server>` on your own computer and keep it open; then open http://localhost:8787 there. Agents on your computer use the same tunnel.

To share pages with other people, give it an HTTPS address and outgoing email: [Share through one HTTPS address](docs/DEPLOY.md#share-through-one-https-address). Anyone who finds that address can then make an account and publish pages on it.

## How it works

1. **Ask.** "Put this prototype on Campfile, in the Tern group." The AI sends the HTML through the MCP connector or the HTTP API.
2. **Check the draft.** The AI gives you a link that only you can open.
3. **Publish.** Click Publish, or tell the AI to.
4. **Share.** Send the link to whoever should give feedback. They open it in a browser, under a thin Campfile bar.
5. **Change it.** "Update the prototype with the notes from testing." The link stays the same.

## Connect your AI

- **Claude, ChatGPT**: add a custom connector with the address `https://<your address>/mcp` and sign in with the emailed code (or your password, in single-user mode). They reach the connector from their own servers, so this needs the HTTPS address.
- **Claude Code, Codex and other agents that run commands**: tell the agent to read `<your address>/agents`. It prints the instructions the agent follows, and works on localhost too.

## Docs

- [Run your own Campfile](docs/DEPLOY.md): start locally, HTTPS, email, API keys, backup with `backup.sh`, upgrade, roll back with `restore.sh`.
- [Advanced hosting](docs/DEPLOY-ADVANCED.md): a separate site for pages, your own Postgres or proxy, admin commands, restoring a backup, moving to a new server, operator checks.

## Development

Node 22.18 or newer, pnpm and an empty Postgres 17.

```sh
git clone https://github.com/arica-no/campfile
cd campfile
pnpm install
export DATABASE_URL=postgres://postgres:test@localhost:5432/postgres

pnpm typecheck                # types
pnpm migrate && pnpm test     # creates the tables, then runs the whole suite
```

`src/` is the product: `app.ts` (connector, HTTP API, sign-in, the owner's screens) and `viewer.ts` (pages as visitors see them). `selfhost/` runs both in one Node process. Read [CONTRIBUTING.md](.github/CONTRIBUTING.md) before opening a pull request, and [SECURITY.md](.github/SECURITY.md) to report a vulnerability.

## License

Campfile is licensed under the [MIT License](LICENSE).
