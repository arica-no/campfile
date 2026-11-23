/** The words for what Campfile is for, as the person who made something hears them. The viewer's About dialog uses these and nothing else. One sentence each. */
export const HEADLINE = ['Create it.', 'Share it anywhere.', 'Watch it spread.'];
export const LEDE = ['One link to the page you made, for chats, email or LinkedIn.', 'Anyone can open it, and if you like, you see how it travels.', 'No server, no code.'];
/** What the maker tells their AI to put a page on Campfile: the setup steps (src/setup.ts, on /guide) and the empty wall say it the same way. */
export const SAY = 'Put my page on Campfile.';
/** What to tell the AI when a page doesn't work here, in the empty wall's steps. */
export const FIX = 'If your page, or part of it, doesn’t work (a blank screen, a button that does nothing), tell your AI: <b>“Make it work on Campfile.”</b>';
/** Opening the AI's private link, and how the maker publishes and finds the link to send, on the page's own bar: the empty wall's steps. HTML: the step, then the hint with the if-cases, shown quieter. */
export const OPEN = {
  step: 'Open the link. The first time, it says the page isn’t published: press <b>Log in</b> to show Campfile it’s yours. Only you can see the page now: check that it all works.',
  hint: `If Campfile then asks for your email, type the one you gave it and press <b>Send link and code</b>, then open the link it emails you or type the code. ${FIX}`,
};
/** `viewer` is the deployment's page origin (VIEWER_ORIGIN), so preview names its own address. The panel stays open after Publish, over the bar, so its Copy link is the one to name first. On a phone the Publish icon is an up arrow, beside the back and Log out arrows. The owner's own visit is sent on to the app's page view (src/viewer.ts), so the browser's bar shows an address only they can open. */
export const publish = (viewer: string) => ({
  step: 'Press <b>Publish</b> at the top of the page, and in the panel that opens choose who can open it. For <b>Anyone with the link</b>, also tick <b>See how it’s shared</b> if you want to watch it spread. Press <b>Publish</b> under those choices, then <b>Copy link</b> at the top of the panel: that’s the link to send.',
  hint: `On a phone, <b>Publish</b> is the up-arrow button at the top right. The first time you publish for <b>Anyone with the link</b>, the panel also asks for the name readers will see. The link starts with ${new URL(viewer).host}, the same one your AI gave you; the address in your browser’s bar is another one that only you can open. Later, <b>Copy link</b> at the top of the page (on a phone, the link button) copies it too.`,
});

/** The sentences as spans, so the pages can keep each one on a line of its own where it fits: they style `span` as an inline block. */
export const sentences = (list: string[]) => list.map((s) => `<span>${s}</span>`).join(' ');

/** The line a person pastes into their AI to set Campfile up; `origin` is the app's own, without a trailing slash. The caller escapes it for HTML. */
export const setupLine = (origin: string) => `Set up Campfile so you can put my pages online. Instructions: ${origin}/agents`;
