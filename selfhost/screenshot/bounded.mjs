/**
 * Runs `start()` (one shot) for at most `ms`, then settles only once `cleanup()` and the shot itself have finished, or, when that takes over `cleanupMs`, once `kill()` has run.
 * So a shot that times out keeps its slot until its browser work is really gone (server.mjs MAX_SHOTS), and a hung one cannot let new shots pile up past the limit.
 */
export async function bounded(start, { ms, cleanupMs, cleanup, kill }) {
  const work = start();
  work.catch(() => {}); // a late shot fails once cleanup closes its pages; that is expected
  let timer;
  try {
    return await Promise.race([work, new Promise((_, fail) => (timer = setTimeout(fail, ms, new Error('The shot took too long.'))))]);
  } finally {
    clearTimeout(timer);
    let late;
    const done = await Promise.race([
      Promise.allSettled([Promise.resolve().then(cleanup), work]).then(() => true),
      new Promise((resolve) => (late = setTimeout(resolve, cleanupMs, false))),
    ]);
    clearTimeout(late);
    if (!done) await kill();
  }
}
