/**
 * Verifies the horizontal-scaling refactor (GameManager + Game + RedisService
 * pub/sub relay) WITHOUT a real multi-instance deployment or a real Redis
 * server. This sandbox has no route to either (no root for apt/redis-server,
 * outbound network is allowlisted so a static binary can't be fetched
 * either), so instead:
 *
 *  - Two (later four) independent `GameManager` instances are created in this
 *    one process, standing in for separate Render instances.
 *  - `redisService`'s methods are monkey-patched to run against a plain
 *    in-memory Map + arrays of pub/sub subscriber callbacks, instead of a
 *    real Redis connection. All GameManagers share this same singleton
 *    object — exactly like real processes would share one real Redis.
 *  - Fake WebSocket-like objects record every message sent to them so the
 *    test can assert on exactly what each simulated client received.
 *
 * This validates the actual routing/ownership logic that changed (the risky
 * part) but does NOT validate the real `redis` npm client's wire behavior
 * (pub/sub timing, GETDEL/SET-NX semantics under real network latency). Run
 * this again against a real multi-instance deployment with real Redis before
 * trusting it in production — see SCALABILITY_REPORT.md.
 *
 * Run with: npx ts-node load-tests/simulated-cluster-test.ts
 */

import { WebSocket as WSReal } from "ws";
import { redisService } from "../src/chess/RedisService";
import { GameManager } from "../src/chess/GameManager";
import { INIT_GAME, MOVE, RECONNECT, GAME_STATE, OPPONENT_DISCONNECTED, OPPONENT_RECONNECTED } from "../src/chess/messages";

// Game.ts/StockfishGame.ts import gameHistoryService (for persisting finished
// games), which pulls in the Prisma client. Some Prisma versions start
// loading their query engine binary in the background as soon as the client
// is constructed, independent of whether a query is ever issued. In this
// sandbox that client was generated for Windows and can't load its engine on
// Linux — unrelated to anything under test here (no player in this script is
// ever an authenticated dbUserId, so persistGameResult's DB write is never
// actually reached), but without this handler the background rejection would
// crash the whole process before the test's own assertions get to run.
process.on("unhandledRejection", (err: any) => {
  if (String(err?.message || err).includes("Query Engine")) return; // sandbox-only Prisma binary mismatch, not ours to fix here
  console.error("Unexpected unhandled rejection:", err);
  process.exitCode = 1;
});

// ── Fake in-memory Redis (shared "cluster" state) ───────────────────────────
const kv = new Map<string, string>();
type Handler = (envelope: any) => void;
const toPlayerHandlers: Handler[] = [];
const gameCommandHandlers: Handler[] = [];

const svc = redisService as any;
svc.publishToPlayer = async (playerId: string, gameId: string, message: unknown) => {
  const envelope = { playerId, gameId, message };
  for (const h of toPlayerHandlers) h(envelope);
};
svc.publishGameCommand = async (envelope: any) => {
  for (const h of gameCommandHandlers) h(envelope);
};
svc.onPlayerMessage = async (handler: Handler) => { toPlayerHandlers.push(handler); };
svc.onGameCommand = async (handler: Handler) => { gameCommandHandlers.push(handler); };

svc.setPendingPlayer = async (key: string, data: unknown) => { kv.set(`pending:${key}`, JSON.stringify(data)); };
svc.getPendingPlayer = async (key: string) => { const v = kv.get(`pending:${key}`); return v ? JSON.parse(v) : null; };
svc.deletePendingPlayer = async (key: string) => { kv.delete(`pending:${key}`); };
svc.consumePendingPlayer = async (key: string) => {
  const v = kv.get(`pending:${key}`);
  if (!v) return null;
  kv.delete(`pending:${key}`);
  return JSON.parse(v);
};

svc.claimGameOwnership = async (gameId: string, instanceId: string) => {
  const key = `owner:${gameId}`;
  if (kv.has(key)) return false;
  kv.set(key, instanceId);
  return true;
};
svc.refreshGameOwnership = async (gameId: string, instanceId: string) => { kv.set(`owner:${gameId}`, instanceId); };

svc.saveGame = async (game: any) => {
  kv.set(`game:${game.gameId}`, JSON.stringify(game));
  kv.set(`player_game:${game.player1Id}`, game.gameId);
  kv.set(`player_game:${game.player2Id}`, game.gameId);
};
svc.getGame = async (gameId: string) => { const v = kv.get(`game:${gameId}`); return v ? JSON.parse(v) : null; };
svc.getGameByPlayerId = async (playerId: string) => {
  const gid = kv.get(`player_game:${playerId}`);
  if (!gid) return null;
  const v = kv.get(`game:${gid}`);
  return v ? JSON.parse(v) : null;
};
svc.deleteGame = async (gameId: string, p1: string, p2: string) => {
  kv.delete(`game:${gameId}`);
  kv.delete(`player_game:${p1}`);
  kv.delete(`player_game:${p2}`);
  kv.delete(`owner:${gameId}`);
};

// ── Fake socket ──────────────────────────────────────────────────────────────
class FakeSocket {
  readyState = WSReal.OPEN;
  received: any[] = [];
  private listeners: Record<string, Function[]> = {};
  send(data: string) {
    this.received.push(JSON.parse(data));
  }
  on(event: string, cb: Function) {
    (this.listeners[event] ||= []).push(cb);
  }
  emit(event: string, ...args: any[]) {
    for (const cb of this.listeners[event] || []) cb(...args);
  }
  lastOfType(type: string) {
    return [...this.received].reverse().find((m) => m.type === type);
  }
}

// ── Test harness ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ok — ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL — ${msg}`);
  }
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("\n=== Simulated 2-instance cluster test ===\n");

  const gmA = new GameManager(); // stands in for Render instance A
  const gmB = new GameManager(); // stands in for Render instance B
  // Registration order in the mock arrays matches instantiation order:
  // index 0 = gmA's handlers, index 1 = gmB's. Used later to simulate B crashing.

  // ── 1. Cross-instance matchmaking ─────────────────────────────────────────
  console.log("1. Cross-instance matchmaking");
  const s1 = new FakeSocket();
  const s2 = new FakeSocket();
  gmA.addUser(s1 as any, null); // player 1 connects to instance A
  gmB.addUser(s2 as any, null); // player 2 connects to instance B

  s1.emit("message", Buffer.from(JSON.stringify({ type: INIT_GAME, payload: { timeControl: 5 } })));
  await sleep(5);
  assert(s1.lastOfType("WAITING") !== undefined, "player1 (instance A) is queued while waiting");

  s2.emit("message", Buffer.from(JSON.stringify({ type: INIT_GAME, payload: { timeControl: 5 } })));
  await sleep(5);

  const init1 = s1.lastOfType(INIT_GAME);
  const init2 = s2.lastOfType(INIT_GAME);
  assert(init1 !== undefined, "player1 (on instance A, remote from the game's owner) received INIT_GAME via relay");
  assert(init2 !== undefined, "player2 (on instance B, the game's owner) received INIT_GAME locally");
  assert(init1?.payload.color === "white", "player1 assigned white (was waiting first)");
  assert(init2?.payload.color === "black", "player2 assigned black");
  assert(init1?.payload.gameId === init2?.payload.gameId, "both players agree on gameId");

  const gameId = init1.payload.gameId;
  const player1Id = init1.payload.playerId;
  const player2Id = init2.payload.playerId;

  // ── 2. Moves relayed across instances in both directions ─────────────────
  console.log("\n2. Cross-instance move relay");
  s1.emit("message", Buffer.from(JSON.stringify({ type: MOVE, payload: { move: { from: "e2", to: "e4" } } })));
  await sleep(5);
  const move1 = s2.lastOfType(MOVE);
  assert(
    move1?.payload.from === "e2" && move1?.payload.to === "e4",
    "instance B (owner) applied white's move relayed from instance A and delivered it to player2 locally"
  );

  s2.emit("message", Buffer.from(JSON.stringify({ type: MOVE, payload: { move: { from: "e7", to: "e5" } } })));
  await sleep(5);
  const move2 = s1.lastOfType(MOVE);
  assert(
    move2?.payload.from === "e7" && move2?.payload.to === "e5",
    "instance B (owner) applied black's local move and relayed it back to player1 on instance A"
  );

  // ── 3. Disconnect relayed to the owner instance ───────────────────────────
  console.log("\n3. Cross-instance disconnect");
  gmA.removeUser(s1 as any);
  await sleep(5);
  const disc = s2.lastOfType(OPPONENT_DISCONNECTED);
  assert(disc !== undefined, "instance B's Game object started the disconnect countdown after instance A relayed the DISCONNECT command");

  // ── 4. Reconnect (to a DIFFERENT, non-owner instance) picks the game back up ─
  console.log("\n4. Reconnect to a non-owner instance");
  const s1b = new FakeSocket();
  gmA.addUser(s1b as any, null); // reconnecting through instance A again (still not the owner)
  s1b.emit("message", Buffer.from(JSON.stringify({ type: RECONNECT, payload: { playerId: player1Id } })));
  await sleep(5);

  const state = s1b.lastOfType(GAME_STATE);
  assert(state !== undefined, "reconnecting player got a GAME_STATE reply from the non-owner instance using the Redis snapshot");
  assert(typeof state?.payload.fen === "string" && state.payload.fen.split(" ").length === 6, "fen looks like a real FEN string");
  assert(state?.payload.yourColor === "white", "reconnect payload reports the correct color");

  const reconnNotice = s2.lastOfType(OPPONENT_RECONNECTED);
  assert(reconnNotice !== undefined, "instance B (owner) was told player1 reconnected, via the relayed RECONNECT command");

  // Play should still work post-reconnect, still relayed cross-instance.
  s1b.emit("message", Buffer.from(JSON.stringify({ type: MOVE, payload: { move: { from: "g1", to: "f3" } } })));
  await sleep(5);
  const move3 = s2.lastOfType(MOVE);
  assert(
    move3?.payload.from === "g1" && move3?.payload.to === "f3",
    "post-reconnect move from the non-owner instance still reaches the owner and gets relayed"
  );

  // ── 5. Owner-instance "crash" — both players reconnect concurrently ──────
  console.log("\n5. Concurrent reconnect after simulated owner-instance crash");
  // Simulate instance B (the owner) crashing first: remove its subscriber
  // callbacks so it no longer reacts to anything (registration order was
  // [gmA, gmB], so index 1 is gmB's in each array).
  toPlayerHandlers.splice(1, 1);
  gameCommandHandlers.splice(1, 1);
  // Both players' previous connections drop (a real client only ever holds
  // one live socket — reconnecting elsewhere implies the old one is gone).
  // With B already "gone", this DISCONNECT relay correctly finds no owner.
  gmA.removeUser(s1b as any);
  // Instance B's ownership claim on this game (set back in step 1's match,
  // refreshed periodically while it's alive) lapses once it stops
  // refreshing — this in-memory mock has no real TTL countdown, so model
  // "enough wall-clock time has passed" by clearing it directly. Without
  // this, both reconnects below would correctly keep deferring to B's
  // now-dead claim forever, which is real (documented) behavior, not a bug —
  // see "Known limitations" in SCALABILITY_REPORT.md.
  kv.delete(`owner:${gameId}`);

  const gmC = new GameManager();
  const gmD = new GameManager();
  const s1c = new FakeSocket();
  const s2c = new FakeSocket();
  gmC.addUser(s1c as any, null);
  gmD.addUser(s2c as any, null);

  // Fire both reconnects with no await between them, to race the ownership claim.
  s1c.emit("message", Buffer.from(JSON.stringify({ type: RECONNECT, payload: { playerId: player1Id } })));
  s2c.emit("message", Buffer.from(JSON.stringify({ type: RECONNECT, payload: { playerId: player2Id } })));
  await sleep(20);

  const cOwnsIt = (gmC as any)["gamesById"].has(gameId);
  const dOwnsIt = (gmD as any)["gamesById"].has(gameId);
  const ownerCount = [cOwnsIt, dOwnsIt].filter(Boolean).length;
  assert(ownerCount === 1, `exactly one instance won the ownership race and rebuilt the game locally (got ${ownerCount})`);

  const s1cState = s1c.lastOfType(GAME_STATE);
  const s2cState = s2c.lastOfType(GAME_STATE);
  assert(
    s1cState !== undefined && s2cState !== undefined,
    "both reconnecting players received a GAME_STATE reply despite the owner instance being gone"
  );
  assert(
    s1cState?.payload.moveCount === s2cState?.payload.moveCount,
    "both sides agree on the move count after the crash/rebuild"
  );
  assert(s1cState?.payload.moveCount === 3, "move count reflects all 3 plies played before the crash");

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
