// The app's timed jobs (src/app.ts `scheduled`), run here on a timer.

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const; // minute, hour, day of month, month, day of week

/**
 * Does `cron` (five fields, UTC) fire in the minute of `at`? Reads `*`, numbers, ranges `a-b`, steps (`*` or a range, then `/n`) and comma lists; anything else throws.
 * shortcut: day of month and day of week must both match (cron itself fires on either); CRONS restricts neither. Upgrade when a cron restricts both.
 */
export function due(cron: string, at: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Not a cron with five fields: "${cron}"`);
  const now = [at.getUTCMinutes(), at.getUTCHours(), at.getUTCDate(), at.getUTCMonth() + 1, at.getUTCDay()];
  const matches = fields.map((field, i) =>
    field.split(',').map((part) => {
      const match = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
      if (!match) throw new Error(`Cron "${cron}": cannot read "${part}"`);
      const [, first, last, step = '1'] = match;
      const [min, max] = RANGES[i];
      const from = first === undefined ? min : Number(first);
      const to = last !== undefined ? Number(last) : first === undefined || part.includes('/') ? max : from;
      if (from < min || to > max || from > to || Number(step) < 1) throw new Error(`Cron "${cron}": "${part}" is out of range`);
      return now[i] >= from && now[i] <= to && (now[i] - from) % Number(step) === 0;
    }).some(Boolean),
  );
  return matches.every(Boolean); // after all fields are read, so a form the matcher cannot read always throws
}

/** The daily cleanup, which src/app.ts knows by this exact text (its DAILY). */
export const CRONS = ['17 3 * * *'];
/**
 * Every 10 minutes, where there is a screenshot service: the retry of pages without a screenshot (src/pages.ts shootDue).
 */
export const SHOT_CRON = '4-59/10 * * * *';

/** Calls `run(cron)` in every minute the cron fires. A run that fails is logged; the next one still happens. */
export function schedule(crons: string[], run: (cron: string) => Promise<unknown>): void {
  const tick = () => {
    const minute = new Date();
    minute.setUTCSeconds(0, 0);
    for (const cron of crons) if (due(cron, minute)) run(cron).catch((error) => console.error(`The cron "${cron}" failed:`, error));
    setTimeout(tick, 60_050 - (Date.now() % 60_000)); // just past the next minute, in case the timer fires early
  };
  setTimeout(tick, 60_050 - (Date.now() % 60_000));
}
