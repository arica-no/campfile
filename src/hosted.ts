// What a deployment can add to the product: its own info pages (docs/DEPLOY-ADVANCED.md "Hosting other people's accounts"). This one adds none.
import type { Example } from './setup.ts';

/** The example pages /guide's step 2 offers as starters: a prompt that makes a page like it. */
export const EXAMPLES: Example[] = [
  { id: 'yoga', title: 'Fjære Yoga · Nordnes, Bergen', about: 'A made-up yoga studio’s page with a breathing pacer and a timetable. Its booking is pretend.', try: { label: 'Yoga studio', prompt: 'Make a calm page for a small yoga studio in Bergen, with a breathing pacer, a timetable and prices. Then put it on Campfile.' } },
  { id: 'campaign', title: 'The Big Dim · Saturday 6 March 2027, 22:00', about: 'A made-up campaign site: drag the dimmer and the city lights go out. Its sign-up count is pretend.', try: { label: 'Lights-out night', prompt: 'Make a campaign page for a night when a city turns its lights off, with a dimmer I can drag. Then put it on Campfile.' } },
  { id: 'pay', title: 'What happens in the 2\u00a0seconds after you tap Pay?', about: 'An explainer: press play and watch one payment travel to the bank and back.', try: { label: 'How paying works', prompt: 'Make an animated explainer of what happens in the 2 seconds after you tap Pay in a shop. Then put it on Campfile.' } },
  { id: 'conference', title: 'Overshoot 2027', about: 'A made-up conference: drag the spring and filter the programme. Its tickets are pretend.', try: { label: 'Design conference', prompt: 'Make a page for a design conference, with a springy logo I can drag and a programme I can filter. Then put it on Campfile.' } },
];

/** The deployment's own info pages (fragments in public/, like docs.html), as the footer lists them after /docs: [path, label]. */
export const OWN_PAGES: [string, string][] = [];

/** Styles of the own pages, added to every page's (SITE_CSS in src/site.ts). */
export const OWN_CSS = '';

/** Where the setup steps are, for a first-timer's link. */
export const SETUP_PATH = '/guide';

/** The footer's last line: who runs the site, e.g. `© 2027 Example AS`. */
export const FOOTER_NOTE = '';

/** True where /terms and /privacy exist: the code screens, the emails and the reader's consent box then link to them. */
export const HAS_TERMS = false;
