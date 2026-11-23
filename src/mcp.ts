import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { Group, GroupService, Ranked } from './groups.ts';
import { DRAFT_FACTS, DRAFT_NOTE, PAGE_RULES, PUBLISH_RULE, SERVER_INSTRUCTIONS } from './instructions.ts';
import { CampfileError, INTERNAL_ERROR, MAX_BODY_BYTES, saysDelete, wordsOf, type PageService } from './pages.ts';
import { SORT_ORDERS, type Sort } from './wall.ts';

/** A tool result: the service's answer as JSON text, or its error message flagged as an error so the AI can relay it. Unexpected errors are logged, not shown. */
async function reply(work: () => Promise<unknown>) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await work(), null, 2) }] };
  } catch (error) {
    if (!(error instanceof CampfileError)) console.error(error);
    return { isError: true, content: [{ type: 'text' as const, text: error instanceof CampfileError ? error.message : INTERNAL_ERROR }] };
  }
}

const id = z.string().describe('The page id, as returned when the page was created or listed. It is also the last part of the public url.');
const groupId = z.string().describe('The group id, as list_groups and create_group return it.');
const groupName = z.string().describe('The group name: one line, up to 80 characters, not one the user already has (case does not count).');
const emails = z.string().describe('Email addresses separated by commas.');
// Tool hints for Claude and ChatGPT: read-only tools run without asking; destructive ones (overwrite, delete, revoke access, send email) always ask; open-world ones put content in front of other people or fetch from the public internet.
const hints = (readOnlyHint: boolean, destructiveHint: boolean, openWorldHint: boolean) => ({ readOnlyHint, destructiveHint, openWorldHint });
// delete_page's confirm for drafts: a plain yes in the words people use (a few languages too), read as saysDelete reads the word, so "no", "yes 2" or "yes, but not that one" deletes nothing.
const YES = new Set(['yes', 'y', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'yes please', 'go ahead', 'yes go ahead', 'do it', 'yes do it', 'yes delete', 'yes delete them', 'yes delete it', 'delete them', 'delete it', 'ja', 'oui', 'si', 'sí',
  // Natural answers to "Are you sure?": still no word that changes what goes ("but", "keep", a number).
  'yes i m sure', 'i m sure', 'yes sure', 'sure go ahead', 'yes thanks', 'yes thank you', 'yes of course', 'of course', 'please do', 'go for it', 'ok do it', 'okay go ahead', 'yeah go ahead', 'yes go ahead and delete them', 'yes yes',
  'ja bitte', 'ja takk', 'ja gerne', 'ja danke', 'ja klar', 'oui s il vous plaît', 'oui bien sûr', 'sí claro', 'si claro', 'sim']);
const saysYes = (reply: string) => YES.has(wordsOf(reply));
const ASK_AGAIN = 'Nothing was deleted: the reply must be a plain yes (just the word delete if a page is published). A question, an added number (“yes 2”) or a change like “yes, but keep one” does not count. If the reply was no, stop.';
const NOT_CONFIRMED = `${ASK_AGAIN} If they changed which pages, plan again with those. Otherwise ask again, naming the same pages, for just yes (just delete if a page is published); never send the reply for them.`;
const GROUP_NOT_CONFIRMED = `${ASK_AGAIN} If they want to keep some pages, move those out with move_pages first, then plan again. Otherwise ask again, naming the same group and pages, for just yes (just delete if a page is published); never send the reply for them.`;
// A group as the tools show it: "published" as list_pages says it.
export const shown = (group: Group) => ({ id: group.id, name: group.name, pages: group.pages, published: group.live, changed: group.changed_at });
const SOURCE_URL =
  "Instead of html: an https link to the complete HTML file, which Campfile downloads (on GitHub: the file's Raw link). Use it for a page too big to write out in full, such as one with embedded images. The link must open for anyone, with no login.";
const sortBy = z
  .enum(SORT_ORDERS)
  .optional()
  .describe(
    'The order, as the user\'s wall sorts: "changed" (Last changed), "added" (Date added, newest first; each item then has added_at), "name" (Name, A to Z, "round 2" before "round 12"), "visitors" (Most visitors this week; each item then has visitors_this_week), "people" (Most people let in; each item then has people_let_in). For a group, the sum over its pages. Only published pages that ask for approval count people let in, and drafts count no visitors. Ties go by last change.',
  );
// The number a "visitors" or "people" order sorted by, named as the wall shows it.
const COUNTED = { visitors: 'visitors_this_week', people: 'people_let_in' } as const;
/** What a sorted item adds so the AI can say why it is where it is: when it was added, or the number it was sorted by. */
const why = (ranked: Ranked | undefined, sort: Sort) =>
  sort === 'added' ? { added_at: ranked?.added ?? null } : sort === 'visitors' || sort === 'people' ? { [COUNTED[sort]]: ranked?.count ?? 0 } : {};
/** `items` in `order` (the wall's, src/groups.ts pagesInOrder), each with why(). */
function inOrder<T extends { id: string }>(items: T[], order: Ranked[], sort: Sort) {
  const rank = new Map(order.map((ranked, i) => [ranked.id, { i, ranked }]));
  const at = (id: string) => rank.get(id)?.i ?? order.length; // one made after the order was read goes last
  return [...items].sort((a, b) => at(a.id) - at(b.id)).map((item) => ({ ...item, ...why(rank.get(item.id)?.ranked, sort) }));
}
/** list_pages and GET /api/pages: only `group`'s pages (an id, or "none"), in a wall order with `sort`. */
export async function pagesListed(pages: PageService, groups: GroupService, group?: string, sort?: Sort) {
  const listed = await pages.list(group);
  return sort ? { pages: inOrder(listed.pages, await groups.pagesInOrder(sort), sort) } : listed;
}
/** list_groups and GET /api/groups. */
export const groupsListed = async (groups: GroupService, sort?: Sort) => ({
  groups: sort ? (await groups.groupsInOrder(sort)).map((ranked) => ({ ...shown(ranked.group), ...why(ranked, sort) })) : (await groups.list()).map(shown),
});
/** move_pages and POST /api/pages/move: null takes the pages out of their group. */
export async function pagesMoved(groups: GroupService, ids: string[], group: string | null) {
  if (group === 'none') throw new CampfileError(400, 'To take pages out of their group, send group as null (not "none"). Nothing was moved.');
  const { moved, group: into } = await groups.move(ids, group);
  return { moved, group: into && shown(into) };
}

/** Stateless MCP over Streamable HTTP: a new server and transport for every request. `whoAmI` answers who_am_i: it needs the connection's OAuth grant, which only the connector has. */
export async function handleMcp(request: Request, pages: PageService, groups: GroupService, whoAmI: () => Promise<unknown>): Promise<Response> {
  const server = new McpServer({ name: 'campfile', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    'create_page',
    {
      title: 'Create page (private draft)',
      annotations: hints(false, false, true), // source_url downloads from the public internet
      description: `Create a new web page as a private draft and get its url.\n${DRAFT_FACTS}\n${PAGE_RULES}`,
      inputSchema: {
        title: z.string().describe('A short title for the page.'),
        html: z.string().optional().describe('The complete HTML document. Leave out when sending source_url.'),
        source_url: z.string().optional().describe(SOURCE_URL),
        group: groupId.nullable().optional().describe('The id of one of your groups to put the page in (list_groups). Leave out (or null) for no group.'),
      },
    },
    ({ title, html, source_url, group }) =>
      reply(async () => {
        // Before the service, so it counts no write.
        if (group === 'none') throw new CampfileError(400, 'To make the page in no group, leave group out (not "none"). Nothing was created.');
        return { ...(await pages.create({ title, html, source_url, group: group ?? undefined })), note: DRAFT_NOTE };
      }),
  );
  server.registerTool(
    'update_page',
    {
      title: 'Update page',
      annotations: hints(false, true, true),
      description: `Replace the HTML (and optionally the title) of one of your pages. The links stay the same. A draft stays a draft. A published page changes for everyone who has its url. The same rules as create_page apply. To change only parts of a page, use edit_page: it does not send the whole page again.`,
      inputSchema: {
        id,
        html: z.string().optional().describe('The complete new HTML document. Leave out when sending source_url.'),
        source_url: z.string().optional().describe(SOURCE_URL),
        title: z.string().optional().describe('A new title. Leave out to keep the old one.'),
      },
    },
    ({ id, html, source_url, title }) => reply(() => pages.update(id, { title, html, source_url })),
  );
  server.registerTool(
    'edit_page',
    {
      title: 'Edit page',
      annotations: hints(false, true, true),
      description: `Change parts of one of your pages without sending the whole page again: each edit replaces its exact "old" text with "new". Use it for small changes; update_page rewrites the whole page. Each "old" must be in the page exactly once, after the edits before it, unless "all" is true; if one edit fails, none is applied. The result's "replaced" says how many places each edit changed, so there is no need to read the page again. To find the exact text to use as "old", use find_in_page. The links stay the same. A draft stays a draft. A published page changes for everyone who has its url.`,
      inputSchema: {
        id,
        edits: z
          .array(
            z.object({
              old: z.string().describe('Text that is in the page now, copied exactly.'),
              new: z.string().describe('The text to put in its place.'),
              all: z.boolean().optional().describe('true: replace every place "old" is in the page, for example to rename a word throughout. Leave out to change exactly one place.'),
            }),
          )
          .describe('The changes, applied in order.'),
        title: z.string().optional().describe('A new title. Leave out to keep the old one.'),
      },
    },
    ({ id, edits, title }) => reply(() => pages.edit(id, { edits, title })),
  );
  server.registerTool(
    'delete_page',
    {
      title: 'Delete pages',
      annotations: hints(false, true, false),
      description:
        `Permanently delete one or more of your pages, only when the user asks. It cannot be undone: the page, its link, its how-it-spread tree and its people list go, and its visit counts can no longer be seen. So call it without confirm first: it deletes nothing. It returns the pages, how many are published, "missing" (not among your pages: check the ids with list_pages, then tell the user) and "needs" (the reply that confirms; null: none of the ids is one of your pages). Then ask the user, naming the pages (up to 10; for more, the first 5, how many others, and every published one) and saying that published pages' links stop working for everyone. The user's request is not their confirmation; only their reply to that question is. It counts only as they typed it: "yes" (or a plain agreement such as "ok", "sure", "yes please", "go ahead") when needs is yes; the English word delete, on its own, when needs is delete (a page is published). When needs is delete and they answer yes or agree in other words, never send delete for them: tell them to type delete. Once they reply, call again with the ids in "pages" and confirm set to their reply, copied exactly: never shorten or tidy it. A reply that adds a condition, a question or a hedge ("yes, but…", "ok?", "I think so") is not a yes: ask again instead of calling. If they say no, stop; if they change which pages, plan again with those. Never fill in confirm yourself, also not after a refusal: ask the user again. All of the pages are deleted, or none.`,
      inputSchema: {
        ids: z.array(id).min(1).describe('The ids of the pages to delete.'), // the 1,000 cap is the service's (pages.ts MAX_DELETE): counted without repeats, and worded without the SDK's " at ids"
        confirm: z.string().optional().describe("The user's reply to your question, as text, exactly as they wrote it (never the boolean true): yes (or a plain agreement such as “ok”), or the word delete when any page is published. Any other reply (no, a condition, a question, a hedge, an added number) deletes nothing. Leave out to get the plan, which deletes nothing."),
      },
    },
    ({ ids, confirm }) =>
      reply(async () => {
        if (confirm?.trim()) {
          if (!saysYes(confirm) && !saysDelete(confirm)) throw new CampfileError(400, NOT_CONFIRMED);
          return pages.removeMany(ids, confirm);
        }
        const plan = await pages.planDelete(ids);
        const { pages: planned, ...counts } = plan;
        // needs before the list: it is the one key the AI must act on.
        return { note: plan.count ? 'Nothing was deleted. These pages are deleted only after the user is asked, with the pages named, and replies; then call again with confirm set to that reply. A plain yes confirms; when a page is published, only the word delete does.' : 'Nothing was deleted: none of these ids is one of your pages.', ...counts, needs: plan.published ? 'delete' : plan.count ? 'yes' : null, pages: planned };
      }),
  );
  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      annotations: hints(true, false, false),
      description:
        "List your pages: id, title, url, whether it is published, who can open it (access), whether the user sees how it is shared (sharing), when each was last updated, and the group it is in (null: none). A draft's url shows the page only to the user, logged in with their email. Last updated first, or with sort in one of the orders of the user's wall.",
      inputSchema: {
        group: z.string().nullable().optional().describe('Only the pages in this group (its id), or "none" for the pages in no group. Leave out (or null) for all pages.'),
        sort: sortBy,
      },
    },
    ({ group, sort }) => reply(() => pagesListed(pages, groups, group ?? undefined, sort)),
  );
  server.registerTool(
    'get_page',
    { title: 'Read page', annotations: hints(true, false, false), description: 'Read one of your pages, drafts included: its title, url, whether it is published, access, sharing, its group, and its HTML source. The id is the last part of its link.', inputSchema: { id } },
    ({ id }) => reply(() => pages.get(id)),
  );
  server.registerTool(
    'list_groups',
    {
      title: 'List groups',
      annotations: hints(true, false, false),
      description: 'List your page groups, last changed first (or with sort in one of the orders of the user\'s wall): id, name, how many pages are in it, how many of those are published, and when it last changed (a page in it updated, a page moved in or out, or renamed). A page is in at most one group.',
      inputSchema: { sort: sortBy },
    },
    ({ sort }) => reply(() => groupsListed(groups, sort)),
  );
  server.registerTool(
    'create_group',
    {
      title: 'Create group',
      annotations: hints(false, false, false),
      description:
        'Make a new group of pages, to keep pages that belong together in one place on the user\'s wall: for example the rounds of one review, or the prototypes of one thing. Check list_groups first and use the group that is already there. page_ids moves pages in straight away (out of any group they were in): all of them, or none and no group.',
      inputSchema: { name: groupName, page_ids: z.array(id).optional().describe('Pages to move into the new group. Leave out to make it empty.') },
    },
    ({ name, page_ids }) => reply(async () => shown(await groups.create(name, page_ids))),
  );
  server.registerTool(
    'rename_group',
    { title: 'Rename group', annotations: hints(false, false, false), description: 'Give one of your groups a new name. Its pages stay in it.', inputSchema: { id: groupId, name: groupName } },
    ({ id, name }) => reply(async () => shown(await groups.rename(id, name))),
  );
  server.registerTool(
    'move_pages',
    {
      title: 'Move pages to a group',
      annotations: hints(false, false, false),
      description:
        'Move one or more of your pages into one of your groups (out of any group they were in), or out of their group with group null. All of them move, or none: an id that is not one of your pages moves nothing. Nothing else about the pages changes: their links, publishing and content stay.',
      inputSchema: {
        ids: z.array(id).min(1).describe('The ids of the pages to move, up to 1,000.'),
        group: groupId.nullable().describe('The group to move them into, or null to take them out of their group.'),
      },
    },
    ({ ids, group }) => reply(() => pagesMoved(groups, ids, group)),
  );
  server.registerTool(
    'delete_group',
    {
      title: 'Delete group',
      annotations: hints(false, true, false),
      description:
        'Delete one of your groups, only when the user asks. Without delete_pages, only the group goes: its pages stay, in no group, unchanged. With delete_pages true, its pages are deleted too, permanently, as delete_page deletes them: then call it without confirm first: it deletes nothing (neither group nor pages) and returns the group, its pages, how many are published and "needs" (the reply that confirms: yes, or the word delete when a page is published). Ask the user, naming the group and its pages, as delete_page says, and call again with confirm set to their reply exactly as they typed it (never fill it in yourself) and ids set to the ids of the plan\'s pages. If the group\'s pages changed since the plan, nothing is deleted: plan again. If the pages are not deleted, the group stays too. A group with no pages is deleted at once. A group of more than 1,000 pages is emptied with delete_page first.',
      inputSchema: {
        id: groupId,
        delete_pages: z.boolean().optional().describe('true: delete the group\'s pages too. Leave out to keep them.'),
        confirm: z.string().optional().describe("Only with delete_pages: the user's reply to your question, exactly as they wrote it. Leave out to get the plan, which deletes nothing."),
        ids: z.array(id).optional().describe('Only with confirm: the ids of the pages in the plan, the ones the user was asked about.'),
      },
    },
    ({ id, delete_pages, confirm, ids }) =>
      reply(async () => {
        if (!delete_pages) {
          if (confirm !== undefined || ids !== undefined) throw new CampfileError(400, 'confirm and ids are only for delete_pages: true. To delete only the group, leave them out; to delete its pages too, set delete_pages: true and plan first. Nothing was deleted.');
          return groups.remove(id, { pages: 'keep' });
        }
        if (!confirm?.trim()) {
          const { pages: planned, ...plan } = await groups.plan(id);
          if (!plan.count) return groups.remove(id, { pages: 'delete', ids: [] });
          // needs before the list: it is the one key the AI must act on.
          return { note: 'Nothing was deleted: neither the group nor its pages. They are deleted only after the user is asked, with the group and its pages named, and replies; then call again with confirm set to that reply and ids set to these pages\' ids. A plain yes confirms; when a page is published, only the word delete does.', count: plan.count, published: plan.published, needs: plan.published ? 'delete' : 'yes', group: plan.group, pages: planned };
        }
        if (!ids) throw new CampfileError(400, 'ids is needed with confirm: send the ids of the plan\'s pages, unchanged. Nothing was deleted.');
        if (!saysYes(confirm) && !saysDelete(confirm)) throw new CampfileError(400, GROUP_NOT_CONFIRMED);
        return groups.remove(id, { pages: 'delete', ids, confirm });
      }),
  );
  server.registerTool(
    'who_am_i',
    {
      title: 'Who am I',
      annotations: hints(true, false, false),
      description:
        'Which Campfile account this connection acts for: its name, email and number of pages, and every app connected to that account. For each app: the name it gave itself, returns_to (the host its sign-in code was sent back to, as recorded when it connected; the app chose it, so it is not proof of who the app is), when it was connected, last_active (when it last renewed its access; it was in use up to an hour after that) and whether it is this connection.',
    },
    () => reply(whoAmI),
  );
  server.registerTool(
    'find_in_page',
    {
      title: 'Find in page',
      annotations: hints(true, false, false),
      description: `Find exact text in one of your pages without reading the whole page, also past the point where get_page cuts a long page. Returns how many times it is there and, for the first 20, the line number and the text around it, copied exactly from the page, ready to use as an edit_page "old". Case and spaces must match.`,
      inputSchema: { id, text: z.string().describe('The exact text to look for, HTML included.') },
    },
    ({ id, text }) => reply(() => pages.find(id, { text })),
  );
  server.registerTool(
    'publish_page',
    {
      title: 'Publish page',
      // Destructive too: switching a public page to approval locks out everyone who already has the link.
      annotations: hints(false, true, true),
      description: `Publish one of your pages, so its public url works, or switch who can open a published page.\n${PUBLISH_RULE}`,
      inputSchema: {
        id,
        access: z
          .enum(['link', 'approval'])
          .optional()
          .describe('"link": anyone with the link. "approval": only people the user approves. Left out: "link", but with sharing given the page keeps the access it has.'),
        emails: emails.optional().describe('Only with "approval": people who may open it without asking, separated by commas.'),
        sharing: z
          .enum(['off', 'links', 'emails'])
          .optional()
          .describe(
            'Only with "link": whether the user sees how the page is shared. "off": no (a new page starts off). "links": readers see a box over the page, naming the user by the name they gave on the owner page or one made from their email (never the email; publishing here never asks for it), asking whether they allow it; each reader who allows gets their own link to pass on, so the user sees who brought whom (get_sharing). "emails": the same, and readers who allow also type an email, which Campfile does not check; only the user sees it. The page always opens, whatever readers choose. Leave it out to keep the current setting. Given without access, the page keeps its access; an approval page stays approval with sharing "off".',
          ),
      },
    },
    ({ id, access, emails, sharing }) => reply(() => pages.publish(id, { access, emails, sharing })),
  );
  server.registerTool(
    'unpublish_page',
    { title: 'Unpublish page', annotations: hints(false, true, false), description: 'Unpublish one of your pages, only when the user asks: it becomes a draft again, which only the user, logged in, can open.', inputSchema: { id } },
    ({ id }) => reply(() => pages.unpublish(id)),
  );
  server.registerTool(
    'list_people',
    { title: 'List people for a page', annotations: hints(true, false, false), description: 'For a page published with access "approval": who asked to open it (waiting), who is let in (approved) and who was told no (denied).', inputSchema: { id } },
    ({ id }) => reply(() => pages.people(id)),
  );
  server.registerTool(
    'get_sharing',
    {
      title: 'See how a page is shared',
      annotations: hints(true, false, false),
      description:
        'For one of your pages: how it spread while its sharing was "links" or "emails", as a tree of entries, so you can summarise it or draw it for the user. The tree stays after sharing is turned off or the page is unpublished, until the user clears it (clear_sharing) or deletes the page; no need to turn sharing on to read it. Each entry is one browser whose reader allowed it, not a person: the same person on another device is another entry. label: the email they typed, not checked by Campfile (null: none asked or typed). ai: the AI assistant that fetched the link for someone (for example "Claude"), null for a browser. country, device ("phone" or "computer"), when they first opened it, how many entries their link brought directly (brought) and how many the whole branch below it reached (reached). The top level is the entries that came through the user\'s own link; "brought" at the top counts them. At most 1,000 entries (capped).',
      inputSchema: { id },
    },
    ({ id }) => reply(() => pages.sharing(id)),
  );
  server.registerTool(
    'clear_sharing',
    {
      title: 'Clear how a page is shared',
      annotations: hints(false, true, false),
      description: 'Delete the whole tree get_sharing shows for one of your pages, only when the user asks. It cannot be undone. The page and every link to it keep working; links readers passed on then count as the user\'s own link. Answers how many entries were deleted (cleared).',
      inputSchema: { id },
    },
    ({ id }) => reply(() => pages.clearSharing(id)),
  );
  server.registerTool(
    'let_people_in',
    { title: 'Let people in', annotations: hints(false, true, true), description: 'For a page published with access "approval": let these people open it, as the user asks. Someone who asked gets an email with a login link and a 6-digit code; anyone else gets a link that opens the page straight away, up to 5 times within 7 days, and after that emails them a login link.', inputSchema: { id, emails } },
    ({ id, emails }) => reply(() => pages.letIn(id, { emails })),
  );
  server.registerTool(
    'decide_person',
    {
      title: 'Approve, deny or remove a person',
      annotations: hints(false, true, true),
      description: 'For a page published with access "approval": approve, say no to, or remove one person, as the user decides. Removing someone lets them ask again.',
      inputSchema: { id, email: z.string().describe('The email of the person.'), decision: z.enum(['approve', 'deny', 'remove']) },
    },
    ({ id, email, decision }) => reply(() => pages.decide(id, { email, decision })),
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
