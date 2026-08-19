# End-to-end tests

Playwright tests that drive the real app in a browser: registration/login, playing a game
against Stockfish, and two browser contexts being matched for an online PvP game.

This suite is intentionally its own npm package (`e2e/package.json`), separate from the
backend's root `package.json` and the frontend's `ui/package.json`. That keeps Playwright and
its browser download out of Render's build steps entirely — Render only ever runs `npm install`
in the repo root and in `ui/`, neither of which touches this folder.

The suite assumes the app is already running and reachable — it does not build or start
anything itself, because that requires Postgres, Redis, and (for full-fidelity Stockfish
behavior) the Stockfish binary described in `DEPLOY_RENDER.md`. See
`.github/workflows/ci-cd.yml` for exactly how CI brings the app up before running these tests.

## Running locally

1. Start Postgres and Redis (for example via Docker):
   ```bash
   docker run -d --name chess-e2e-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=chess \
     -p 5432:5432 postgres:16
   docker run -d --name chess-e2e-redis -p 6379:6379 redis:7
   ```
2. From the repo root, set up and start the backend (which also serves the built frontend):
   ```bash
   export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/chess"
   export REDIS_HOST=localhost REDIS_PORT=6379
   export JWT_SECRET=dev-secret CLIENT_URL=http://localhost:3000 PORT=3000
   npm install
   npx prisma db push --accept-data-loss
   npm run build
   (cd ui && npm install && npm run build)
   npm start &
   ```
   Stockfish is optional locally — without `STOCKFISH_PATH` set to a working binary, the
   backend automatically falls back to random legal moves for the "vs computer" tests, which
   is enough to exercise the same code paths.
3. From `e2e/`:
   ```bash
   npm install
   npx playwright install --with-deps chromium
   npm test
   ```

Set `E2E_BASE_URL` if the app is listening somewhere other than `http://localhost:3000`.
