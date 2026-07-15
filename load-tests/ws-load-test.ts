/**
 * WebSocket scalability / load test for the chess game engine.
 *
 * Spins up N concurrent pairs of players against a running server, puts each
 * pair through real matchmaking (INIT_GAME), then plays randomized-but-legal
 * moves back and forth (using chess.js, same as a real client would) until
 * the game ends or a move cap is hit. It measures:
 *
 *   - WebSocket connect latency
 *   - Matchmaking latency (time from requesting a game to being paired)
 *   - Move propagation latency (time from a client sending a move to the
 *     opponent receiving it) — this is the core "does the server keep up
 *     under load" signal
 *   - Error / drop / stall counts
 *   - Aggregate throughput (moves/sec, games/sec)
 *
 * Usage:
 *   npm run loadtest:ws
 *   PAIRS=200 MOVE_DELAY_MS=0 npm run loadtest:ws   # burst / stress mode
 *
 * Env vars:
 *   WS_URL          default ws://localhost:3000
 *   PAIRS           number of concurrent game pairs (2 sockets each). default 50
 *   RAMP_MS         spread connections over this window instead of a thundering
 *                   herd. default 5000
 *   MAX_PLIES       cap on half-moves per game so runs terminate. default 40
 *   MOVE_DELAY_MS   delay between a client receiving its turn and replying.
 *                   0 = max throughput stress test. default 150
 *   TEST_TIMEOUT_MS hard cap for the whole run. default 120000
 */

import WebSocket from "ws";
import { Chess } from "chess.js";

const WS_URL = process.env.WS_URL || "ws://localhost:3000";
const PAIRS = parseInt(process.env.PAIRS || "50", 10);
const RAMP_MS = parseInt(process.env.RAMP_MS || "5000", 10);
const MAX_PLIES = parseInt(process.env.MAX_PLIES || "40", 10);
const MOVE_DELAY_MS = parseInt(process.env.MOVE_DELAY_MS || "150", 10);
const TEST_TIMEOUT_MS = parseInt(process.env.TEST_TIMEOUT_MS || "120000", 10);

interface Metrics {
  connectLatencies: number[];
  matchLatencies: number[];
  moveLatencies: number[];
  gamesCompleted: number;
  gamesStalled: number;
  gamesErrored: number;
  totalMovesSent: number;
  droppedMessages: number;
}

const metrics: Metrics = {
  connectLatencies: [],
  matchLatencies: [],
  moveLatencies: [],
  gamesCompleted: 0,
  gamesStalled: 0,
  gamesErrored: 0,
  totalMovesSent: 0,
  droppedMessages: 0,
};

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function randomLegalMove(board: Chess) {
  const moves = board.moves({ verbose: true });
  if (moves.length === 0) return null;
  return moves[Math.floor(Math.random() * moves.length)];
}

/** One player socket in a pair. Resolves when the game ends, stalls, or errors. */
function runPlayer(label: string): Promise<void> {
  return new Promise((resolve) => {
    const board = new Chess();
    let color: "white" | "black" | null = null;
    let myTurn = false;
    let pliesSeen = 0;
    let movesSentByMe = 0;
    let finished = false;
    let lastMoveSentAt = 0;
    let stallTimer: NodeJS.Timeout | null = null;

    const connectStart = Date.now();
    const ws = new WebSocket(WS_URL);

    const finish = (kind: "ok" | "stall" | "error") => {
      if (finished) return;
      finished = true;
      if (stallTimer) clearTimeout(stallTimer);
      if (kind === "ok") metrics.gamesCompleted++;
      else if (kind === "stall") metrics.gamesStalled++;
      else metrics.gamesErrored++;
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve();
    };

    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      // If we don't see any activity for a long stretch, count it as stalled
      // rather than hanging the whole test run forever.
      stallTimer = setTimeout(() => finish("stall"), 20000);
    };

    const maybeReply = () => {
      if (!myTurn || finished) return;
      if (pliesSeen + movesSentByMe >= MAX_PLIES || board.isGameOver()) {
        // We've reached the bounded move cap (or a natural game end we can see
        // locally) without the server round-tripping a game_over — that's a
        // successful, complete exchange for load-testing purposes, not a stall.
        finish("ok");
        return;
      }
      const mv = randomLegalMove(board);
      if (!mv) return;
      setTimeout(() => {
        if (finished) return;
        board.move(mv);
        lastMoveSentAt = Date.now();
        metrics.totalMovesSent++;
        movesSentByMe++;
        myTurn = false;
        ws.send(
          JSON.stringify({
            type: "move",
            payload: {
              move: { from: mv.from, to: mv.to, promotion: mv.promotion },
            },
          })
        );
        if (movesSentByMe + pliesSeen >= MAX_PLIES) {
          finish("ok");
          return;
        }
        armStallTimer();
      }, MOVE_DELAY_MS);
    };

    ws.on("open", () => {
      metrics.connectLatencies.push(Date.now() - connectStart);
      const matchRequestAt = Date.now();
      ws.send(JSON.stringify({ type: "init_game", payload: { timeControl: null } }));
      armStallTimer();

      // stash on socket for use in message handler
      (ws as any)._matchRequestAt = matchRequestAt;
    });

    ws.on("message", (raw) => {
      armStallTimer();
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        metrics.droppedMessages++;
        return;
      }

      if (msg.type === "init_game") {
        color = msg.payload.color;
        metrics.matchLatencies.push(Date.now() - (ws as any)._matchRequestAt);
        myTurn = color === "white";
        maybeReply();
        return;
      }

      if (msg.type === "move") {
        // Opponent's move arriving — propagation latency measured on the sender's
        // side is not directly observable here, so we measure round-trip proxy:
        // time since we last sent (only meaningful for the responding side).
        if (lastMoveSentAt > 0) {
          metrics.moveLatencies.push(Date.now() - lastMoveSentAt);
        }
        board.move({ from: msg.payload.from, to: msg.payload.to, promotion: msg.payload.promotion });
        pliesSeen++;
        myTurn = true;
        if (pliesSeen + movesSentByMe >= MAX_PLIES || board.isGameOver()) {
          finish("ok");
          return;
        }
        maybeReply();
        return;
      }

      if (msg.type === "game_over") {
        finish("ok");
        return;
      }

      if (msg.type === "WAITING" || msg.type === "time_update") {
        return;
      }

      if (msg.type === "ERROR") {
        finish("error");
        return;
      }
    });

    ws.on("error", () => finish("error"));
    ws.on("close", () => {
      if (!finished) finish("stall");
    });
  });
}

async function main() {
  console.log(`WS scalability test`);
  console.log(`  target:        ${WS_URL}`);
  console.log(`  pairs:         ${PAIRS} (${PAIRS * 2} sockets)`);
  console.log(`  ramp window:   ${RAMP_MS}ms`);
  console.log(`  max plies:     ${MAX_PLIES}`);
  console.log(`  move delay:    ${MOVE_DELAY_MS}ms`);
  console.log("");

  const start = Date.now();
  const tasks: Promise<void>[] = [];

  for (let i = 0; i < PAIRS; i++) {
    const delay = (RAMP_MS * i) / PAIRS;
    // Two players per pair, launched back-to-back so they match each other
    // (matchmaking is FIFO per time-control bucket).
    tasks.push(
      new Promise((res) => setTimeout(res, delay)).then(() => runPlayer(`p${i}-A`))
    );
    tasks.push(
      new Promise((res) => setTimeout(res, delay + 20)).then(() => runPlayer(`p${i}-B`))
    );
  }

  const overallTimeout = new Promise<void>((res) => setTimeout(res, TEST_TIMEOUT_MS));
  await Promise.race([Promise.all(tasks), overallTimeout]);

  const elapsed = (Date.now() - start) / 1000;

  console.log("=== Results ===");
  console.log(`Wall time:            ${elapsed.toFixed(1)}s`);
  console.log(`Games completed:      ${metrics.gamesCompleted} / ${PAIRS * 2} (players)`);
  console.log(`Games stalled:        ${metrics.gamesStalled}`);
  console.log(`Games errored:        ${metrics.gamesErrored}`);
  console.log(`Total moves sent:     ${metrics.totalMovesSent}`);
  console.log(`Moves/sec (avg):      ${(metrics.totalMovesSent / elapsed).toFixed(1)}`);
  console.log(`Dropped/unparsable:   ${metrics.droppedMessages}`);
  console.log("");
  console.log("Connect latency (ms):   p50=%s p95=%s p99=%s max=%s",
    percentile(metrics.connectLatencies, 50).toFixed(0),
    percentile(metrics.connectLatencies, 95).toFixed(0),
    percentile(metrics.connectLatencies, 99).toFixed(0),
    Math.max(0, ...metrics.connectLatencies));
  console.log("Matchmaking latency (ms): p50=%s p95=%s p99=%s max=%s",
    percentile(metrics.matchLatencies, 50).toFixed(0),
    percentile(metrics.matchLatencies, 95).toFixed(0),
    percentile(metrics.matchLatencies, 99).toFixed(0),
    Math.max(0, ...metrics.matchLatencies));
  console.log("Move round-trip (ms):   p50=%s p95=%s p99=%s max=%s",
    percentile(metrics.moveLatencies, 50).toFixed(0),
    percentile(metrics.moveLatencies, 95).toFixed(0),
    percentile(metrics.moveLatencies, 99).toFixed(0),
    Math.max(0, ...metrics.moveLatencies));

  const failureRate = (metrics.gamesStalled + metrics.gamesErrored) / (PAIRS * 2 || 1);
  if (failureRate > 0.05) {
    console.log(`\n⚠ ${(failureRate * 100).toFixed(1)}% of pairs stalled or errored — server likely struggling at this concurrency.`);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ ${((1 - failureRate) * 100).toFixed(1)}% of pairs completed cleanly.`);
  }
}

main().catch((err) => {
  console.error("Load test crashed:", err);
  process.exit(1);
});
