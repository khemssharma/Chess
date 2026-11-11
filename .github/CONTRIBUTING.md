# Contributing to Chess

Thanks for your interest in improving **Chess**, an online multiplayer chess server with a Stockfish computer mode and AI-explained post-game analysis. Bug reports, fixes, docs and new features are all welcome.

**Stack:** TypeScript · Express · Prisma · React (Vite) · Playwright

## Ways to contribute

- 🐛 **Report a bug:** [open a bug report](https://github.com/khemssharma/Chess/issues/new?template=bug_report.yml)
- 💡 **Suggest a feature:** [open a feature request](https://github.com/khemssharma/Chess/issues/new?template=feature_request.yml)
- 📝 **Improve the docs:** typos, unclear steps and missing examples all count
- 🔧 **Fix an issue:** look for issues labelled `good first issue` or `help wanted`

For anything bigger than a small fix, please **open an issue first**, so we can agree on the approach before you spend time on it.

## Local setup

```bash
git clone https://github.com/<your-username>/Chess.git
cd Chess
cp .env.example .env        # fill in the values
npm install                 # also runs the Prisma client generation
npm run db:migrate          # apply database migrations
npm run dev                 # start the backend
```

In a second terminal, start the frontend:

```bash
cd ui
npm install
npm run dev
```

## Project layout

| Path | What lives there |
| --- | --- |
| `src/` | Backend: routes, controllers, services, chess logic |
| `prisma/` | Database schema, migrations, puzzle seed |
| `ui/` | React + Vite frontend |
| `e2e/` | Playwright end-to-end tests |
| `load-tests/` | REST and WebSocket load tests |

## Making a change

1. **Fork** the repo and create a branch from `main`:
   ```bash
   git checkout -b feat/short-description   # or fix/…, docs/…, refactor/…
   ```
2. Make your change. Keep each PR focused on **one** thing.
3. Run the checks below.
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add rematch button
   fix: handle disconnect during game
   docs: clarify .env setup
   ```
5. Push to your fork and open a pull request against `main`. Fill in the PR template.

## Checks before you open a PR

```bash
npm run build                          # backend must compile with no TypeScript errors
(cd ui && npm run lint && npm run build) # frontend lint and build
(cd e2e && npm install && npx playwright install && npm test)   # end-to-end tests
```

If you change WebSocket or matchmaking code, also run the load tests: `npm run loadtest`.

### Continuous integration

The `ci-cd.yml` workflow runs on every pull request and must pass before merge.

## Project-specific guidelines

- **Database changes:** edit `prisma/schema.prisma`, then run `npm run db:migrate` and commit the generated migration.
- **Game logic:** add or update tests for any change to move validation, clocks or game state.
- **Never commit** `.env`, API keys or Stockfish binaries.

## Code style

- Match the style of the code around your change.
- Use clear, descriptive names; avoid unexplained abbreviations.
- Remove debug logs and commented-out code before committing.
- Update the README if your change affects setup or usage.

## Reporting security issues

Please **don't open a public issue** for security vulnerabilities. Contact the maintainer privately through the [GitHub profile](https://github.com/khemssharma) with the details and steps to reproduce.

## Code of conduct

Be respectful and constructive. Harassment, personal attacks and spam aren't tolerated.

## License

This repository doesn't have an open-source license yet. Until one is added, by submitting a contribution you agree that it may be used, modified and distributed as part of this project.
