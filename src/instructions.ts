import { MAX_HTML_BYTES, MAX_HTML_BYTES_UNLIMITED } from './pages.ts';
import { CODE_MINUTES } from './signin.ts';

/** What an AI must know to write a page that works here. Used by GET / and by the MCP tool descriptions. */
export const PAGE_RULES = `The page must be ONE self-contained HTML file, at most ${MAX_HTML_BYTES / 2 ** 20} MB, or ${MAX_HTML_BYTES_UNLIMITED / 2 ** 20} MB on an account with the higher limit. Unsure which the user has? Send it: a page over their limit is refused with that limit, and nothing is saved. A page too big to write out in full, already at an https link (on GitHub: the file's Raw link), can be sent as source_url instead of html: Campfile downloads it.
- Most people open the link on a phone. Make one page that works on phones and computers: it fits screens from 360px wide, never scrolls sideways, has controls big enough to tap, and needs no hover.
- Put all CSS and JavaScript inline. Embed images, fonts and audio as data: URLs.
- Nothing is loaded from the internet: CDN scripts, web fonts, external images and fetch()/XMLHttpRequest calls are all blocked.
- The page runs in a sandbox. localStorage, sessionStorage and cookies throw errors, so keep state in JavaScript variables. Forms do not submit (not even to a submit handler), so use buttons with click handlers. alert()/confirm()/prompt(), print(), full screen, the Clipboard API, file downloads, the camera, the microphone, geolocation and navigator.share() do not work either.
- Links to other sites must open in a new tab (target="_blank"): one that opens in the same tab shows a blocked page.
- An existing page the user points you to (a link, or its files): rebuild it as one page that follows these rules, never a copy of a whole website, and only a page the user may publish. Keep its text, layout, styles and images; leave out what talks to the outside or tracks visitors: outside scripts, analytics, ads, embeds and forms that send data elsewhere. A page that needs a server or a login cannot work here: say so. If you cannot finish it yourself (you cannot download its files, or the result is too big to write out in full), tell the user exactly what they need to do, for example turn on a tool of yours that can download files, or make the page one self-contained HTML file themselves and give you its https link to send as source_url.`;

/** What a CLI agent says after creating a page (GET /agents only: directory review rules keep scripted wording out of the MCP tools). */
export const PREVIEW_RULE = `give the user the url and say: "Open it to check it. Only you can see it until it's published: log in with your email on the page. When you're happy, click Publish on the page, or tell me to publish it."`;

/** When publishing is allowed and what the answer means. Used by GET /agents and the publish_page tool; the precondition is the only guard against publishing on the AI's own initiative, so keep it. */
export const PUBLISH_RULE = `Call only when the user has asked to publish the page (for example "publish it" or "make it public"). Unpublishing, too, is only for when the user asks.
- Access "link": anyone with the link can open the page. Access "approval": visitors ask with their email and the user approves them; "emails" lets in the people the user named at once.
- The answer's public_link_works says whether the public link opened for a visitor just now. When it is false, public_link_status, if given, says what happened; the link may start working a minute later.`;

/** What a draft is. Used by GET /agents and the create_page tool description. */
export const DRAFT_FACTS = `A new page starts as a private draft. Its url shows the page only to the user, after they log in with their email on the page; everyone else sees "This page isn't published" until it is published. The user can publish it on the page, where they choose who can open it.
- The url is the page's only link: the same link works as the public link once the page is published. A page open to anyone with the link is unlisted, not private: anyone who has its url can view it and share it further.`;

/** The create_page result says this, as a fact, instead of telling the AI what to say. */
export const DRAFT_NOTE = "Private draft: only the user can open this url, after logging in with their email on the page. It goes public when the user publishes it, on the page or through publish_page.";

/** The MCP server's instructions: what Campfile is and when to use it, read by every connector client at connect time. */
export const SERVER_INSTRUCTIONS = `Campfile hosts web pages that the user makes with AI: a plan, checklist, diagram, quiz, calculator, prototype or interactive document. Each page is one self-contained HTML file at a link the user controls.

Use Campfile when the user asks to turn something into a page or to put an existing page on Campfile; to host, share, publish, change or delete one of their pages; or to see who asked to open one. For a request that needs no page, answer without Campfile.

A new page is a private draft that only the user can open. Publish only when the user asks, and ask who may open it:
- Anyone with the link: the link is unlisted, not private; anyone who has it can open the page and pass it on.
- Only approved people: visitors ask with their email and open the page only after the user lets them in.

To change a page, use edit_page for small changes or update_page to replace it; the link stays the same. Use list_pages to find a page.

Keep pages that belong together in one group, so they sit together on the user's wall: the rounds of one review, or the prototypes of one thing. Before creating such a page, look for its group with list_groups, else make one with create_group, then create_page with that group. move_pages puts pages already made into a group.`;

/** The plain-text answer to GET /agents (and GET / for anything that does not ask for HTML). */
export function instructions(origin: string): string {
  // Read the key from the file inside each command, so it never appears in the conversation.
  // The old ~/.config/campfire/ is still read: a computer signed in before the rename keeps working.
  const auth = '-H "Authorization: Bearer $(cat ~/.config/campfile/credentials 2>/dev/null || cat ~/.config/campfire/credentials)"';
  return `Campfile hosts one self-contained HTML page and gives back links. Links are unlisted, not private: anyone with the public link can view the page or share it further. Tell the user this before they publish anything sensitive.
Use it when the user asks you to publish, host or share an HTML page, app or game.

CANNOT RUN COMMANDS? (for example in an AI chat app such as Claude or ChatGPT)
The steps below need a terminal. Instead, tell the user to add Campfile as a connector in their AI app's settings, once:
1. Open the app's connector settings. In Claude: https://claude.ai/customize/connectors?modal=add-custom-connector (Customize → Connectors → Add custom connector).
2. Name: Campfile. URL: ${origin}/mcp
3. Click Add or Connect, and sign in with the code Campfile emails them. Then ask again: Campfile's tools will be there.

SIGN IN (once per computer)
1. If ~/.config/campfile/credentials or ~/.config/campfire/credentials exists, the user is signed in. Skip to the next section.
2. Otherwise ask the user for their email address. Do not guess it from git or other settings. Then send:
   curl -sS -X POST ${origin}/api/signin -H "Content-Type: application/json" -d '{"email": "USER_EMAIL"}'
3. Tell the user what the answer's "message" asks for. Usually that is: "I asked Campfile to email you a 6-digit code. What is it? If it's not in your inbox, check your spam folder." A self-hosted server without email says to ask for a password or a code from its log instead. The code works for ${CODE_MINUTES} minutes. A new email address gets a new account; there is no separate sign-up.
4. Send the code. This one command saves the key to the file without printing it:
   (umask 077 && curl -sSf --create-dirs -o ~/.config/campfile/credentials -X POST ${origin}/api/signin/verify -H "Accept: text/plain" -H "Content-Type: application/json" -d '{"email": "USER_EMAIL", "code": "123456"}') && echo "Signed in"
   If curl reports error 400, the code was wrong, expired or used up: ask the user to check it, or go back to step 2 for a new one. 403 means the account is disabled.
Never show the key to the user and never put it inside a page. The commands below read it from the file.

${PAGE_RULES}

${DRAFT_FACTS}
- After creating a page, ${PREVIEW_RULE}

CREATE A PAGE
1. Save the HTML in a file, for example page.html.
2. Turn it into a JSON request body (this does the escaping for you):
   jq -n --arg title "Page title" --rawfile html page.html '{title: $title, html: $html}' > request.json
   No jq? Use Python instead:
   python3 -c 'import json; print(json.dumps({"title": "Page title", "html": open("page.html", encoding="utf-8").read()}))' > request.json
3. Send it:
   curl -sS -X POST ${origin}/api/pages ${auth} -H "Content-Type: application/json" --data-binary @request.json
   The answer is {"id": "...", "url": "...", "published": false, "group": null}. Give the user the url, as described above.
   To make it in one of the user's groups (see GROUPS below), add "group" to the JSON: jq -n --arg title "Page title" --arg group GROUP_ID --rawfile html page.html '{title: $title, html: $html, group: $group}' > request.json

UPDATE A PAGE (same links, new content; "title" is optional in the JSON, and the old title stays if you leave it out)
   curl -sS -X PUT ${origin}/api/pages/PAGE_ID ${auth} -H "Content-Type: application/json" --data-binary @request.json
   The answer has the same id and url as before. A draft stays a draft. A published page changes for everyone who has its url.

DELETE A PAGE (only when the user asks; gone for good)
   First ask the user "Are you sure?", naming the page. The call deletes it at once, and if it is published its link stops working for everyone.
   curl -sS -X DELETE ${origin}/api/pages/PAGE_ID ${auth}

LIST THE USER'S PAGES
   curl -sS ${origin}/api/pages ${auth}
   The answer is {"pages": [{"id": "...", "title": "...", "url": "...", "published": true, "access": "link", "sharing": "off", "updated_at": "...", "group": {"id": "...", "name": "..."}}]}, last updated first; "group" is null for a page in no group.
   Only one group's pages: add ?group=GROUP_ID, or ?group=none for the pages in no group.
   In another order, as the user's wall sorts: add ?sort= with "changed" (last changed), "added" (newest first; each page then has "added_at"), "name" (A to Z, "round 2" before "round 12"), "visitors" (most visitors this week; each page then has "visitors_this_week") or "people" (most people let in; each page then has "people_let_in"). Quote a url with both, for the shell's sake:
   curl -sS "${origin}/api/pages?group=GROUP_ID&sort=name" ${auth}

READ A PAGE (drafts too: the user's own pages only)
   curl -sS ${origin}/api/pages/PAGE_ID ${auth}
   The answer is like one entry of the list, plus "html", the page's source. A source over 100,000 characters is cut, with "truncated": true and a "note": then it is not the whole page.

GROUPS (keep pages that belong together in one group, so they sit together on the user's wall: the rounds of one review, or the prototypes of one thing)
   Before creating such a page, look for its group:
   curl -sS ${origin}/api/groups ${auth}
   The answer is {"groups": [{"id": "...", "name": "...", "pages": 3, "published": 1, "changed": "..."}]}, last changed first ("published" counts its published pages). ?sort= takes the same orders as the list of pages, each summed over the group's pages.
   No group for it yet? Make one (the name is one line, up to 80 characters, not one the user already has; "page_ids" is optional and moves those pages in at once):
   curl -sS -X POST ${origin}/api/groups ${auth} -H "Content-Type: application/json" -d '{"name": "Checkout redesign", "page_ids": ["PAGE_ID"]}'
   The answer is the group, as in the list. Then create the page with that group's id as "group" (CREATE A PAGE above).
   Move pages into a group (out of any group they were in), or out of their group with "group": null. All of them move or none; their links, publishing and content stay:
   curl -sS -X POST ${origin}/api/pages/move ${auth} -H "Content-Type: application/json" -d '{"ids": ["PAGE_ID"], "group": "GROUP_ID"}'
   Rename a group:
   curl -sS -X PUT ${origin}/api/groups/GROUP_ID ${auth} -H "Content-Type: application/json" -d '{"name": "New name"}'
   Delete a group, only when the user asks. Its pages stay, in no group:
   curl -sS -X DELETE ${origin}/api/groups/GROUP_ID ${auth}
   To delete its pages too, list them with ?group=GROUP_ID, ask the user "Are you sure?" naming them, then delete each page (DELETE A PAGE) and then the group.

PUBLISH A PAGE
${PUBLISH_RULE}
   curl -sS -X POST ${origin}/api/pages/PAGE_ID/publish ${auth} -H "Content-Type: application/json" -d '{"access": "link"}'
   Only approved people: -d '{"access": "approval", "emails": "ingrid@example.com, omar@example.com"}' ("emails" is optional; they can open it without asking).
   To let the user see how the page is shared (only with "link"), add "sharing": "links" (readers see a box over the page, naming the user by the name they gave on the owner page or one made from their email (never the email; publishing here never asks for it), asking whether they allow it; each reader who allows gets their own link to pass on, so the user sees who brought whom) or "emails" (the same, and readers who allow also type an email, which Campfile does not check; only the user sees it). The page always opens, whatever readers choose. "off" turns it off. Leave it out to keep the current setting. With "sharing" and no "access", the page keeps its access: an approval page stays approval, and its sharing stays "off". Without either, "access" is "link".
   The answer is {"id": "...", "url": "...", "published": true, "access": "link", "sharing": "off", "public_link_works": true}. Publishing again with the other access switches it.

UNPUBLISH A PAGE (it becomes a draft again: only the user, logged in, can open its url)
   curl -sS -X POST ${origin}/api/pages/PAGE_ID/unpublish ${auth}

HOW A PAGE IS SHARED (any of the user's pages; the tree stays after sharing is turned off or the page is unpublished)
   curl -sS ${origin}/api/pages/PAGE_ID/sharing ${auth}
   The answer is a tree: {"sharing": "links", "entries": 3, "capped": false, "brought": 2, "children": [{"label": null, "ai": null, "country": "NO", "device": "phone", "first_opened": "...", "brought": 1, "reached": 1, "children": [...]}]}. Each entry is one browser whose reader allowed it, not a person: "label" is the email they typed, not checked (null: none), "ai" names the AI assistant that fetched the link for someone (for example "Claude"; null for a browser), "device" is "phone" or "computer", "brought" counts the entries their link brought, "reached" the whole branch below it. The top "brought" counts the entries that came through the user's own link. At most 1,000 entries ("capped"). Sum it up or draw it for the user.
   Only when the user asks, delete the whole tree (the page and its links keep working; the answer is {"cleared": 3}):
   curl -sS -X DELETE ${origin}/api/pages/PAGE_ID/sharing ${auth}

WHO CAN OPEN AN APPROVAL PAGE (only for a page published with "approval")
   See who asked, who is let in and who was told no:
   curl -sS ${origin}/api/pages/PAGE_ID/people ${auth}
   The answer is {"id": "...", "published": true, "access": "approval", "people": [{"email": "...", "status": "waiting"}]}; status is "waiting", "approved" or "denied". The user also gets an email when someone asks.
   Let people in (someone who asked gets an email with a login link and a 6-digit code; anyone else gets a link that opens the page straight away, up to 5 times within 7 days, and after that emails them a login link):
   curl -sS -X POST ${origin}/api/pages/PAGE_ID/people ${auth} -H "Content-Type: application/json" -d '{"emails": "ingrid@example.com"}'
   Approve, say no to, or remove one person, as the user decides:
   curl -sS -X POST ${origin}/api/pages/PAGE_ID/people/decide ${auth} -H "Content-Type: application/json" -d '{"email": "ingrid@example.com", "decision": "approve"}'
   "decision" is "approve", "deny" or "remove". Removing someone lets them ask again.

If a request fails, the answer is JSON like {"error": "..."}. Tell the user what it says, in plain words.
`;
}
