// Stands in for the hosted runtime's module `cloudflare:workers` in Node tests. The OAuth library imports WorkerEntrypoint only to recognise
// class-based handlers; Campfile passes plain `{ fetch }` handlers, so an empty class is enough.
export class WorkerEntrypoint {}
