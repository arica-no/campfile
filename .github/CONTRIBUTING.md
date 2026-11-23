# Contributing

Issues and pull requests are welcome.

1. Set up as in the README's "Development": `pnpm install`, an empty Postgres in `DATABASE_URL`, then `pnpm typecheck` and `pnpm migrate && pnpm test`.
2. A change in behaviour needs an issue first, so it can be agreed before you write it.
3. Add or update a test in `test/` for the behaviour you change. CI runs the typecheck and the whole suite on every pull request.
4. Schema changes are a new numbered file in `migrations/`; never edit one that has shipped.

Security problems are reported privately, not in an issue: see [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the MIT license in [LICENSE](../LICENSE).
