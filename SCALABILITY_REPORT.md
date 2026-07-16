# Scalability report — Chess app

Tested by running the scripts in `load-tests/` against the real backend
(`src/index.ts`) with guest-vs-guest games, which don't touch Postgres or
Redis — so these numbers isolate the WebSocket game engine itself.
Environment: **single CPU core**, 4GB RAM sandbox, with the load-test client
and the server sharing that one core — so treat absolute numbers as
directional, not a production capacity plan.

**Update: the fixes described below have been applied to the code.** This
report now shows the original findings, what was changed, and a genuine
before/after re-test — including where the fix helped less than expected, so
the numbers stay honest rather than telling a clean success story.

## What was fixed

1. **`GameManager` O(n) linear scans → O(1) Map lookups.** `games`/`computerGames`
   were plain arrays scanned with `.find()` on every incoming message (move,
   valid-moves request, disconnect). Replaced with `Map<WebSocket, Game>` /
   `Map<WebSocket, StockfishGame>` (plus `Map<string, Game>` by gameId, and
   reverse-index maps for the pending-queue and playerId↔socket lookups that
   were also doing `for...of` scans on disconnect). See `src/chess/GameManager.ts`.

2. **Four separate `PrismaClient` instances → one shared client.** Each of
   `authServices.ts`, `gameHistoryService.ts`, `ratingService.ts`, and
   `puzzleService.ts` used to run `new PrismaClient()` independently, each
   opening its own Postgres connection pool. They now all import a single
   instance from `src/lib/prisma.ts`.

3. **No rate limiting on auth → `express-rate-limit` added.** `/api/auth/register`,
   `/api/auth/login`, and `/api/auth/google` are now limited to 20 requests per
   IP per 15 minutes (`src/middlewares/rateLimiters.ts`), since each of those
   requests does real bcrypt work (cost factor 10) and/or a DB write.

None of this changes gameplay behavior, message formats, or the API surface —
only how the server tracks internal state and guards the auth endpoints.

## Before / after: WebSocket game engine

| Concurrent games | Sockets | Move round-trip p50 (before) | Move round-trip p50 (after) |
|---:|---:|---:|---:|
| 20  | 40   | ~110 ms   | ~110 ms (no change — expected, n is tiny either way) |
| 200 | 400  | ~1,600 ms | ~1,260 ms (~20% better) |
| 500 | 1,000 | ~2,570 ms | ~2,400 ms (~7% better) |

**Honest read of this:** the Map refactor is a real, correct fix — it removes
genuine O(n) work and per-disconnect array-copy allocations, and it's the
right way to write this regardless of benchmarks. But on this single-core
sandbox, where the load-test client and the server are fighting over the same
core, it only produced a modest improvement rather than a dramatic one. That
tells us the linear scan was *a* contributor to the latency curve, not the
whole story — the bigger factor at this scale is that everything (matchmaking,
game logic, all N games' message handling) runs on one Node process's one
event loop with no clustering, and my test client's own CPU usage competes for
that same core in this environment.

**What this means for you:** re-run `npm run loadtest:ws` yourself with the
client and server on separate machines (or at least confirm your production
host has more than one core available to compare against) to see the isolated
server-side effect more cleanly than this sandbox could show. The fix is
in either way — it was worth doing on correctness/GC-pressure grounds even
before considering the benchmark.

## Still true after these fixes (not addressed — bigger architectural changes)

1. **No horizontal scaling.** Game and matchmaking state still live only in
   this one process's memory (now in Maps instead of arrays, but still local).
   Redis is used for reconnect *persistence*, not live traffic routing, so you
   still can't run two server instances behind a load balancer without
   breaking active games. Fixing this means moving matchmaking/game state to
   something shared (Redis pub/sub, or a dedicated game-server tier) — a much
   bigger change than what was done here, and not something I'd do silently
   without discussing the approach with you first.

2. **Per-game 100ms timers for timed games.** `Game.ts` runs a `setInterval`
   every 100ms per active timed game to push clock updates. At high concurrency
   this adds up (500 timed games = 5,000 timer callbacks/sec system-wide).
   Untouched — a fix here (e.g. a single shared ticking loop that batches
   updates) is a bigger behavioral change to game timing and felt like it
   deserved its own discussion rather than folding it into this pass.

3. **REST auth path under real DB load.** Still can't be measured without a
   live Postgres instance — run `INCLUDE_AUTH=1 npm run loadtest:rest` against
   a staging/deployed instance with `DATABASE_URL` set.

## Re-running the tests

```bash
npm run dev            # start the server
npm run loadtest:ws    # WebSocket game-engine test
npm run loadtest:rest  # REST API benchmark
npm run loadtest        # both
```

See `load-tests/README.md` for env vars (`PAIRS`, `MOVE_DELAY_MS`, `WS_URL`, etc).