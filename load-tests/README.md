# Load / scalability tests

Two scripts, both run against a **live server** (local or deployed):

| Script | What it exercises |
|---|---|
| `load-tests/ws-load-test.ts` | The WebSocket game engine — matchmaking + full games played with real, legal moves via `chess.js` |
| `load-tests/rest-load-test.ts` | The REST API (`/api/leaderboard` by default; optionally `/api/signup` under load) |

## Running them

```bash
npm run dev              # in one terminal — starts the server on :3000

npm run loadtest:ws      # in another terminal
npm run loadtest:rest
npm run loadtest         # runs both back to back
```

Both scripts are plain env-var-configurable, so you can push harder without editing code:

```bash
# Stress-test matchmaking + gameplay with 200 concurrent games, no artificial delay between moves
PAIRS=200 MOVE_DELAY_MS=0 npm run loadtest:ws

# Point at a deployed instance
WS_URL=wss://your-app.onrender.com npm run loadtest:ws
BASE_URL=https://your-app.onrender.com npm run loadtest:rest

# Include signup/login in the REST benchmark (needs a real DATABASE_URL on the server)
INCLUDE_AUTH=1 npm run loadtest:rest
```

See the header comment in each file for the full list of env vars.

### What "PAIRS" means for the WS test

`PAIRS=N` opens `2N` sockets (N matches). Each pair goes through real matchmaking
(`init_game`) and then plays randomized-but-legal moves back and forth until either
the game ends or `MAX_PLIES` half-moves have been played — the cap exists so a run
finishes in bounded time even though random play almost never reaches checkmate.
Reaching the cap counts as a clean completion, not a failure.

The script reports:
- WebSocket connect latency
- matchmaking latency (time to get paired)
- move round-trip latency (a good proxy for "is the server keeping up")
- completed / stalled / errored counts
- aggregate moves/sec

A run is flagged unhealthy (non-zero exit code) if more than 5% of players stall or
error out.

## What I found running these here

Full write-up is in `SCALABILITY_REPORT.md` at the repo root — short version:

- The WebSocket game engine handles guest-vs-guest games correctly at every
  concurrency level tested (up to 500 simultaneous games / 1,000 sockets on a
  single CPU core), but **move round-trip latency grows sharply with concurrency**
  (~110ms median at 20 games → ~1.6s at 200 games → ~2.6s at 500 games) because
  `GameManager` looks up the game and the computer-game list with a linear
  `Array.find()` scan on **every single message**, and everything runs on one
  Node event loop / one process with no clustering.
- The app cannot horizontally scale behind a load balancer as written: game and
  matchmaking state live only in the process's memory. Redis is used for
  reconnect *persistence*, not for routing live traffic, so a second instance
  can't serve a game that started on the first one.
- Four separate `new PrismaClient()` instances exist across the codebase
  (`authServices.ts`, `gameHistoryService.ts`, `ratingService.ts`,
  `puzzleService.ts`), each opening its own DB connection pool — this multiplies
  Postgres connections unnecessarily under load.
- No rate limiting on `/api/signup` or `/api/login`; bcrypt cost factor 10 means
  each login/signup is a real (if small) CPU cost per request under concurrency.

None of these are addressed by the load tests themselves — they're just what the
tests surfaced. See `SCALABILITY_REPORT.md` for the numbers and suggested fixes,
ordered by impact vs. effort.
