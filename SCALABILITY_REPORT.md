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

**Second update: horizontal scaling (the #1 item in "still true after these
fixes," below) has now been implemented.** See "Horizontal scaling" further
down for what changed, how it was verified without a live multi-instance
deployment to test against, and what's still a known limitation.

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

1. ~~No horizontal scaling.~~ **Done — see "Horizontal scaling" below.**

2. **Per-game 100ms timers for timed games.** `Game.ts` runs a `setInterval`
   every 100ms per active timed game to push clock updates. At high concurrency
   this adds up (500 timed games = 5,000 timer callbacks/sec system-wide).
   Untouched — a fix here (e.g. a single shared ticking loop that batches
   updates) is a bigger behavioral change to game timing and felt like it
   deserved its own discussion rather than folding it into this pass.

3. **REST auth path under real DB load.** Still can't be measured without a
   live Postgres instance — run `INCLUDE_AUTH=1 npm run loadtest:rest` against
   a staging/deployed instance with `DATABASE_URL` set.

## Horizontal scaling

The core problem: a `Game` object lived only in one process's memory, holding
direct references to both players' WebSocket objects. Render's load balancer
assigns every incoming WebSocket connection to a random instance — there's no
sticky-session option — so with more than one instance running, the two
players in a game could easily end up connected to two different processes,
each unable to see the other's socket. Redis was already used for
reconnect *persistence* (a snapshot to restore from), but not for routing live
traffic, so matchmaking and in-game messages simply couldn't cross an
instance boundary. Digging into it further, this was already silently broken,
not just theoretical: the old matchmaking code looked up a waiting player's
socket in a **purely local** map, and — if the waiter happened to be on a
different instance — deleted their (perfectly valid) Redis queue entry and
gave up, rather than completing the match. With one instance this bug was
unreachable; it's exactly the kind of thing that only surfaces once you
actually try to scale out.

**What changed:**

- **`Game` no longer holds WebSocket references at all.** It identifies
  players by `playerId` (a stable string) instead of `===` on a socket
  object, and sends messages through `redisService.publishToPlayer(playerId,
  gameId, message)` instead of `socket.send(...)`. See `src/chess/Game.ts`.

- **Two Redis pub/sub channels bridge instances** (`src/chess/RedisService.ts`):
  `chess:to-player` delivers a message to whichever instance holds a
  player's live socket (every instance subscribes and checks its own local
  map; only one actually delivers it), and `chess:game-command` carries the
  reverse direction — a MOVE, GET_VALID_MOVES, DISCONNECT, or RECONNECT that
  arrived on an instance which doesn't own the `Game` object locally gets
  forwarded to whichever instance does. Neither channel needs to know *which*
  instance that is; broadcast-plus-local-filter handles it for free.

- **Matchmaking is now atomic and actually cross-instance.**
  `consumePendingPlayer` uses Redis `GETDEL` instead of a GET-then-DELETE
  pair, so two instances can no longer both match against the same waiting
  player (the old code had this race too — it just could never be triggered,
  since cross-instance matching never worked in the first place). A match
  now completes using playerId identity alone, regardless of which instance
  either player is connected to.

- **Reconnection uses a Redis ownership claim** (`game_owner:{gameId}`,
  `SET NX EX`, refreshed periodically by whoever holds it) as the single
  source of truth for "is a live owner still out there." A reconnecting
  instance that doesn't already hold the `Game` object locally tries to claim
  it: success means nobody's actively holding it (first reconnect after a
  crash, once the previous claim's TTL lapses) and this instance rebuilds
  from the last snapshot; failure means someone else holds it, so this
  instance defers via the command channel instead. (An earlier version of
  this used a separate "is the other player online" presence flag to make
  that decision — dropped after the cluster-simulation test below caught it
  racing with itself: two concurrent reconnects could each see the other as
  "online" and both defer, with nobody actually rebuilding the game. The
  single ownership-claim check doesn't have that failure mode.)

- **`src/index.ts`** now handles `SIGTERM`/`SIGINT` (Render sends `SIGTERM` on
  every deploy or scale-down) by refusing new connections but leaving
  in-flight game sockets alone — when they do eventually drop, the affected
  players reconnect through whichever instance is still up, because game
  state lives in Redis rather than tied to that one process.

- **`render.yaml`** had a pre-existing bug independent of any of this:
  `rootDir: backend` / `rootDir: frontend`, but the repo has no such
  directories — the backend's `package.json` is at the repo root and the
  frontend is in `ui/`. Fixed, and `numInstances: 2` plus a `chess-redis` Key
  Value service were added so the blueprint actually deploys a horizontally
  scaled setup out of the box. See `DEPLOY_RENDER.md`.

**How this was verified.** The sandbox this work was done in has no route to
provision a real Redis instance (no root access for `apt`/`redis-server`, and
outbound network is allowlisted, so a static binary couldn't be fetched
either) — so the *code* couldn't be run against live Redis here. Two things
were used instead: `npx tsc --noEmit` for type-level correctness across the
refactor, and a purpose-built script
(`load-tests/simulated-cluster-test.ts`) that instantiates two independent
`GameManager`s in one process (standing in for two server instances) sharing
a mocked in-memory Redis (pub/sub broadcast + a shared key-value map, wired
in place of the real `redisService` calls) and drives cross-instance
matchmaking, moves, disconnect, and reconnect end-to-end, asserting on the
messages each side actually receives. That validates the routing logic this
change is actually about; it does **not** validate the real `redis` npm
client's wire behavior (pub/sub timing, `GETDEL`/`SET NX` semantics under
real network latency, reconnect-storm behavior). **Before trusting this in
production, run it against a real multi-instance deployment with real Redis**
— ideally two `chess-backend` instances and a few dozen simulated games,
watching for a match or a reconnect that ends up nowhere (the honest failure
mode here is a message silently not delivered, not a crash, so it's worth
specifically looking for "waiting forever" behavior in a manual test, not
just checking that the server stays up).

**Known limitations, called out rather than papered over:**

- **Owning-instance crash mid-game isn't seamlessly recovered.** If the
  process holding a `Game` object dies, that game's clock stops advancing and
  no one is notified until both players separately reconnect (each reconnect
  checks Redis presence and rebuilds if truly nobody is reachable). There's
  no leader election or automatic failover — building that felt like a
  separate, bigger piece of work rather than something to fold in here.
- **Delivery is fire-and-forget pub/sub**, matching the existing at-most-once
  semantics of direct `ws.send()` calls (no worse than before) — Redis pub/sub
  doesn't persist messages for a subscriber that's briefly unreachable. This
  is fine for this app because the actual game state is separately persisted
  after every move (`persistToRedis`); pub/sub only carries the live
  notification, not the source of truth.
- **Vs-computer games are untouched and don't need to be** — they're a single
  human socket talking to a local Stockfish subprocess, so they're inherently
  single-instance already. More instances mainly help this path by giving
  more CPU cores to spread concurrent engine processes across.

## Re-running the tests

```bash
npm run dev            # start the server
npm run loadtest:ws    # WebSocket game-engine test
npm run loadtest:rest  # REST API benchmark
npm run loadtest        # both
```

See `load-tests/README.md` for env vars (`PAIRS`, `MOVE_DELAY_MS`, `WS_URL`, etc).