# Scalability report — Chess app

Tested by running the scripts in `load-tests/` against the real backend
(`src/index.ts`, unmodified) with guest-vs-guest games, which don't touch
Postgres or Redis — so these numbers isolate the WebSocket game engine itself.
Environment: **single CPU core**, 4GB RAM sandbox — so treat absolute numbers
as directional, not a production capacity plan. The trend (how latency grows
with concurrency) is the important part, and it will reproduce on any single
Node process regardless of host core count, because this app is unclustered.

## What was tested

- `load-tests/ws-load-test.ts` — real matchmaking + real games, N concurrent
  pairs, randomized-but-legal moves via `chess.js`, latency measured end to end.
- `load-tests/rest-load-test.ts` — `autocannon` against `/api/leaderboard`,
  optionally `/api/signup` if you have a live DB.

## Results: WebSocket game engine

| Concurrent games | Sockets | Move round-trip p50 | p99 | Completed cleanly |
|---:|---:|---:|---:|---:|
| 20  | 40   | ~110 ms  | ~200 ms  | 100% |
| 200 | 400  | ~1,600 ms | ~2,100 ms | 100% |
| 500 | 1,000 | ~2,570 ms | ~3,380 ms | 100% |

Nothing crashed or dropped connections at any of these levels — the server
stayed correct. But latency degrades fast and non-linearly as concurrency
rises, which is the real finding.

**Why:** `GameManager` (`src/chess/GameManager.ts`) stores active games and
sockets in plain arrays and does `this.games.find(...)` / linear scans on
*every* incoming WebSocket message (`move`, `get_valid_moves`, matchmaking).
That's an O(n) lookup per message with n = concurrent games, all on a single
event loop. At 500 games that's 1,000 players' worth of moves each doing a
linear scan through 500 entries, competing for the same thread. This is the
dominant cost — there's no per-game CPU-heavy work otherwise (chess.js move
validation is cheap).

A secondary, latent cost: when a game has a time control, `Game.ts` runs a
`setInterval` **every 100ms per active game** to push clock updates to both
players (`startTimeTracking`). At 500 timed games that's 5,000 timer callbacks/sec
system-wide, each doing 2 sends — this test used untimed games specifically to
isolate the array-scan cost from this; in production, timed games (the common
case) will add this on top.

## Results: REST API

`/api/leaderboard` (no DB configured in this sandbox, so every request hit the
error path) sustained **~1,470 req/s** at 50 concurrent connections on one
core, p50 latency 28ms, p99 101ms — the HTTP layer itself is not a bottleneck
at this scale. The real ceiling for auth-related endpoints will be bcrypt
(CPU-bound, cost factor 10) and Postgres connection pool limits, which
couldn't be measured here without a live database — run
`INCLUDE_AUTH=1 npm run loadtest:rest` against a deployed/staging instance
with `DATABASE_URL` set to get real numbers for that path.

## Structural issues found while testing (not just numbers)

1. **In-memory, single-process game state.** `GameManager`'s `games`,
   `users`, and `pendingUsers` live only in that process's memory. This means:
   - You cannot run more than one server instance behind a load balancer
     without breaking active games and matchmaking — a player matched on
     instance A can't be reached by a move sent to instance B. Redis here is
     used for *reconnect persistence* (surviving a restart/reconnect), not for
     cross-instance routing.
   - The array scans described above get linearly worse with every concurrent
     game, with no way to shard the work across cores in-process.

2. **Four independent `PrismaClient` instances** — one each in
   `authServices.ts`, `gameHistoryService.ts`, `ratingService.ts`, and
   `puzzleService.ts`. Each opens its own connection pool to Postgres, so
   under load you get up to 4x the DB connections you'd expect from a single
   shared client. Low-risk, high-value fix:
   ```ts
   // src/lib/prisma.ts
   import { PrismaClient } from "@prisma/client";
   export const prisma = new PrismaClient();
   ```
   ...and import `prisma` from there in all four files instead of constructing
   a new one each.

3. **No rate limiting** on `/api/signup` or `/api/login`. Combined with
   bcrypt at cost 10 (deliberately slow), a burst of concurrent auth requests
   is the most CPU-expensive thing this API can be asked to do — worth putting
   behind something like `express-rate-limit` before it's internet-facing.

4. **Prisma client instantiated eagerly at module load** in all four files
   above (`const prisma = new PrismaClient()` at the top of the file). This
   isn't a runtime scalability issue, but it did surface during setup here:
   if `prisma generate` hasn't been run (e.g. a fresh clone, restricted CI
   network), the entire process — including the WebSocket game engine, which
   needs no database at all — fails to boot. Worth knowing if you ever see the
   whole app down because of a Postgres/codegen hiccup unrelated to gameplay.

## Suggested priority

1. Fix the `GameManager` array scans — swap `games: Game[]` /
   `computerGames: StockfishGame[]` for `Map<socket, Game>` lookups (or a
   `Map<gameId, Game>` plus a `Map<WebSocket, gameId>` index) so move/valid-moves
   routing is O(1) instead of O(n). This alone should flatten the latency curve
   seen above.
2. Consolidate the four `PrismaClient`s into one shared instance.
3. Add rate limiting to `/api/signup` and `/api/login`.
4. If/when you need more than one server instance: matchmaking and live game
   state need to move to something shared (Redis pub/sub or a dedicated game
   server), since right now horizontal scaling silently breaks active games
   rather than erroring loudly.

None of these were changed as part of this pass — the load tests are left in
`load-tests/` so you can re-run them yourself (`npm run loadtest`) before and
after making any of these changes to see the before/after difference directly.
