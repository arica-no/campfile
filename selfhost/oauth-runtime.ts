// Stands in for the module `cloudflare:workers`, which Node does not have (server.ts points the import here). The OAuth library uses WorkerEntrypoint only to recognise
// class-based handlers; Campfile passes plain `{ fetch }` handlers, so an empty class is enough. The same stand-in as test/oauth-runtime.ts.
export class WorkerEntrypoint {}
