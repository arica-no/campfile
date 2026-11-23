import { defineConfig } from 'vitest/config';

// All test files share one database, so they run one after another.
// The OAuth library imports `cloudflare:workers`, which only the hosted runtime has: it is inlined so the alias can replace that import with a stub.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': new URL('./test/oauth-runtime.ts', import.meta.url).pathname } },
  test: { include: ['test/**/*.test.ts'], fileParallelism: false, server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } } },
});
