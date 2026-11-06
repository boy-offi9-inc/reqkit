# Contributing

Thanks for helping. reqkit is small on purpose, so focused changes are easiest to review.

## Setup

```bash
git clone https://github.com/boy-offi9-inc/reqkit && cd reqkit
npm install
npm run check
```

Requires Node 18+. `npm run check` builds the bundle, then runs the tests, the type checks and the smoke checks. To try the playground locally: `npm run build && python3 -m http.server -d playground`.

## Making a change

- Read [docs/architecture.md](./docs/architecture.md) first. `src/` is layered, and a test fails if a layer depends on one above it.
- Add tests for new behavior, and a regression test for every bug fix.
- Update `types/`, `typecheck/` and the README when the public API changes.
- If the bundle test fails, run `npm run build` and commit `playground/reqkit.mjs`.
- No runtime dependencies.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). Mark breaking changes with `!` and a `BREAKING:` paragraph.

## Security

Please don't open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).
