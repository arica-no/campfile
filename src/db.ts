import { createMiddleware } from 'hono/factory';
import postgres from 'postgres';
import type { ViewerEnv } from './env.ts';

export type Sql = postgres.Sql;

/** Like `ctx.waitUntil`: keeps the request alive until the work settles, and keeps its database connection open until then. */
export type WaitUntil = (work: Promise<unknown>) => void;

export interface DbVariables {
  sql: Sql;
  waitUntil: WaitUntil;
}

/** One client per request (the connection pool does the pooling), closed once the response is built and any `c.var.waitUntil` work is done. Sets `c.var.sql` and `c.var.waitUntil`. */
export const withDb = createMiddleware<{ Bindings: ViewerEnv; Variables: DbVariables }>(async (c, next) => {
  const sql = postgres(c.env.DB.connectionString, { max: 1, fetch_types: false });
  const background: Promise<unknown>[] = [];
  c.set('sql', sql);
  c.set('waitUntil', (work) => {
    background.push(work);
    c.executionCtx.waitUntil(work);
  });
  try {
    await next();
  } finally {
    // Work that outlives the response still queries, and a closed client would fail it.
    // That work is the link previews.
    c.executionCtx.waitUntil(Promise.allSettled(background).then(() => sql.end()));
  }
});
