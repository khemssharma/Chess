import { WebSocket } from "ws";
import { Chess } from "chess.js";
import { spawn, execFileSync, ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import {
  GAME_OVER,
  INIT_GAME,
  MOVE,
  VALID_MOVES,
  TIME_UPDATE,
} from "./messages";
import { gameHistoryService } from "../services/gameHistoryService";
import { v4 as uuidv4 } from "uuid";

export type Difficulty = "easy" | "medium" | "hard" | "expert";

/**
 * Lichess-style difficulty: UCI_Elo + movetime + depth, all three together.
 */
const DIFFICULTY_CONFIG: Record<
  Difficulty,
  { elo: number; movetime: number; depth: number; limitStrength: boolean }
> = {
  easy:   { elo: 1320, movetime: 80,   depth: 1,  limitStrength: true  },
  medium: { elo: 1500, movetime: 300,  depth: 5,  limitStrength: true  },
  hard:   { elo: 2000, movetime: 1500, depth: 12, limitStrength: true  },
  expert: { elo: 2800, movetime: 3000, depth: 20, limitStrength: false },
};

// Visual delay before showing the AI move (separate from thinking time)
const DIFFICULTY_DELAY: Record<Difficulty, number> = {
  easy:   300,
  medium: 200,
  hard:   100,
  expert: 50,
};

/**
 * Validate and return the first working Stockfish binary path.
 * Uses execFileSync with a simple 'uci' command to confirm the binary works.
 */
function resolveStockfishBin(): string | null {
  const candidates: string[] = [];

  if (process.env.STOCKFISH_PATH) {
    candidates.push(process.env.STOCKFISH_PATH);
  }
  // Render deploys to /opt/render/project/src (rootDir = backend)
  candidates.push("/opt/render/project/src/stockfish-bin");
  candidates.push(path.join(process.cwd(), "stockfish-bin"));
  candidates.push(path.join(__dirname, "..", "..", "..", "stockfish-bin"));
  candidates.push("stockfish");
  candidates.push("/usr/games/stockfish");
  candidates.push("/usr/bin/stockfish");
  candidates.push("/usr/local/bin/stockfish");

  for (const bin of candidates) {
    try {
      // Quick validation: run 'uci' and check for 'uciok' in output
      const out = execFileSync(bin, [], {
        input: "uci\nquit\n",
        timeout: 3000,
        encoding: "utf8",
      }) as string;
      if (out.includes("uciok")) {
        console.log(`Stockfish binary validated: ${bin}`);
        return bin;
      }
    } catch {
      // Binary not found or timed out — try next
    }
  }
  return null;
}

export class StockfishGame {
  public player: WebSocket;
  public board: Chess;
  public gameId: string;
  public playerId: string;
  private playerColor: "white" | "black";
  private difficulty: Difficulty;
  private stockfish: ChildProcessWithoutNullStreams | null = null;
  private stockfishReady = false;
  private pendingBuffer = "";
  private moveCount = 0;
  private dbUserId: number | null;

  // Time control
  private timeControl: number | null;
  private playerTime: number | null;
  private aiTime: number | null;
  private lastMoveTime: number = 0;
  private timeUpdateInterval: NodeJS.Timeout | null = null;

  public onGameEnd: ((gameId: string) => void) | null = null;

  constructor(
    player: WebSocket,
    playerColor: "white" | "black",
    difficulty: Difficulty,
    timeControlMinutes: number | null = null,
    dbUserId: number | null = null
  ) {
    this.player = player;
    this.board = new Chess();
    this.gameId = uuidv4();
    this.playerId = uuidv4();
    this.playerColor = playerColor;
    this.difficulty = difficulty;
    this.dbUserId = dbUserId;
    this.timeControl =
      timeControlMinutes !== null ? timeControlMinutes * 60 * 1000 : null;
    this.playerTime = this.timeControl;
    this.aiTime = this.timeControl;

    this.initStockfish();

    player.send(
      JSON.stringify({
        type: INIT_GAME,
        payload: {
          color: playerColor,
          timeControl: timeControlMinutes,
          playerId: this.playerId,
          gameId: this.gameId,
          vsComputer: true,
          difficulty,
        },
      })
    );

    if (this.timeControl !== null) {
      this.lastMoveTime = Date.now();
      this.startTimeTracking();
    }

    // If AI plays white, make first move after engine is ready
    if (playerColor === "black") {
      setTimeout(() => this.requestStockfishMove(), 800);
    }
  }

  private initStockfish() {
    const bin = resolveStockfishBin();
    if (!bin) {
      console.warn("No valid Stockfish binary found — using random-move fallback");
      return;
    }

    try {
      this.stockfish = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      console.error("Failed to spawn Stockfish:", err);
      return;
    }

    const cfg = DIFFICULTY_CONFIG[this.difficulty];
    this.stockfish.stdout.setEncoding("utf8");

    // Accumulate stdout into pendingBuffer for the bestmove listener
    this.stockfish.stdout.on("data", (chunk: string) => {
      this.pendingBuffer += chunk;
      // Mark engine as ready once we see 'readyok'
      if (!this.stockfishReady && this.pendingBuffer.includes("readyok")) {
        this.stockfishReady = true;
        this.pendingBuffer = "";
        console.log(`Stockfish ready: ${bin} | difficulty: ${this.difficulty} | elo: ${cfg.elo} | movetime: ${cfg.movetime}ms | depth: ${cfg.depth}`);
      }
    });

    this.stockfish.on("error", (err) => {
      console.error("Stockfish process error:", err.message);
      this.stockfish = null;
      this.stockfishReady = false;
    });

    this.stockfish.on("exit", (code) => {
      if (code !== 0) {
        console.warn(`Stockfish exited with code ${code}`);
      }
      this.stockfish = null;
      this.stockfishReady = false;
    });

    // Send UCI init sequence
    this.stockfish.stdin.write("uci\n");
    this.stockfish.stdin.write("setoption name Threads value 1\n");
    this.stockfish.stdin.write("setoption name Hash value 16\n");
    this.stockfish.stdin.write("setoption name MultiPV value 1\n");

    if (cfg.limitStrength) {
      this.stockfish.stdin.write("setoption name UCI_LimitStrength value true\n");
      this.stockfish.stdin.write(`setoption name UCI_Elo value ${cfg.elo}\n`);
    } else {
      this.stockfish.stdin.write("setoption name UCI_LimitStrength value false\n");
    }

    this.stockfish.stdin.write("ucinewgame\n");
    this.stockfish.stdin.write("isready\n"); // engine will reply 'readyok' when done
  }

  private requestStockfishMove() {
    if (this.board.isGameOver()) return;

    const fen = this.board.fen();
    const cfg = DIFFICULTY_CONFIG[this.difficulty];
    const delay = DIFFICULTY_DELAY[this.difficulty];

    if (!this.stockfish) {
      this.fallbackRandomMove(delay);
      return;
    }

    // If engine not yet ready, wait up to 3 s then proceed anyway
    const runSearch = () => {
      if (!this.stockfish) {
        this.fallbackRandomMove(delay);
        return;
      }

      let responded = false;

      // Timeout: if Stockfish doesn't respond in movetime + 2s, fall back
      const timeoutId = setTimeout(() => {
        if (!responded) {
          responded = true;
          this.stockfish?.stdout.off("data", onData);
          console.warn(`Stockfish timeout after ${cfg.movetime + 2000}ms — using random move fallback`);
          this.fallbackRandomMove(0);
        }
      }, cfg.movetime + 2000);

      const onData = (chunk: string) => {
        this.pendingBuffer += chunk;
        const lines = this.pendingBuffer.split("\n");
        // Keep the last partial line in the buffer
        this.pendingBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("bestmove") && !responded) {
            responded = true;
            clearTimeout(timeoutId);
            this.stockfish?.stdout.off("data", onData);

            const parts = line.trim().split(" ");
            const moveStr = parts[1];
            console.log(`Stockfish bestmove: ${moveStr} (difficulty: ${this.difficulty})`);

            if (moveStr && moveStr !== "(none)") {
              setTimeout(() => {
                this.applyAiMove({
                  from: moveStr.slice(0, 2),
                  to: moveStr.slice(2, 4),
                  promotion: moveStr.length > 4 ? moveStr[4] : undefined,
                });
              }, delay);
            } else {
              this.fallbackRandomMove(delay);
            }
          }
        }
      };

      this.pendingBuffer = ""; // clear buffer before search
      this.stockfish.stdout.on("data", onData);
      this.stockfish.stdin.write(`position fen ${fen}\n`);
      this.stockfish.stdin.write(`go movetime ${cfg.movetime} depth ${cfg.depth}\n`);
    };

    if (this.stockfishReady) {
      runSearch();
    } else {
      // Wait for readyok, up to 3 seconds
      let waited = 0;
      const interval = setInterval(() => {
        waited += 100;
        if (this.stockfishReady || waited >= 3000) {
          clearInterval(interval);
          runSearch();
        }
      }, 100);
    }
  }

  private fallbackRandomMove(delay: number) {
    setTimeout(() => {
      if (this.board.isGameOver()) return;
      const moves = this.board.moves({ verbose: true });
      if (moves.length > 0) {
        const m = moves[Math.floor(Math.random() * moves.length)];
        console.warn(`Random fallback move: ${m.from}${m.to}`);
        this.applyAiMove({ from: m.from, to: m.to, promotion: (m as any).promotion });
      }
    }, delay);
  }

  private applyAiMove(move: { from: string; to: string; promotion?: string }) {
    if (this.board.isGameOver()) return;
    try {
      this.board.move(move);
    } catch {
      return;
    }
    if (this.timeControl !== null) {
      this.lastMoveTime = Date.now();
    }
    this.moveCount++;
    this.player.send(JSON.stringify({ type: MOVE, payload: move }));
    if (this.timeControl !== null) {
      this.sendTimeUpdate();
    }
    if (this.board.isGameOver()) {
      this.handleGameOver();
    }
  }

  makeMove(
    socket: WebSocket,
    move: { from: string; to: string; promotion?: string }
  ) {
    if (socket !== this.player) return;
    const isPlayerTurn =
      (this.playerColor === "white" && this.board.turn() === "w") ||
      (this.playerColor === "black" && this.board.turn() === "b");
    if (!isPlayerTurn) return;
    try {
      this.board.move(move);
    } catch {
      return;
    }
    if (this.timeControl !== null) {
      this.lastMoveTime = Date.now();
    }
    this.moveCount++;
    if (this.board.isGameOver()) {
      this.handleGameOver();
      return;
    }
    if (this.timeControl !== null) {
      this.sendTimeUpdate();
    }
    this.requestStockfishMove();
  }

  getValidMoves(socket: WebSocket, square: string) {
    const isPlayerTurn =
      (this.playerColor === "white" && this.board.turn() === "w") ||
      (this.playerColor === "black" && this.board.turn() === "b");
    if (!isPlayerTurn) {
      socket.send(
        JSON.stringify({ type: VALID_MOVES, payload: { square, moves: [] } })
      );
      return;
    }
    const moves = this.board.moves({ square: square as any, verbose: true });
    socket.send(
      JSON.stringify({
        type: VALID_MOVES,
        payload: {
          square,
          moves: moves.map((m: any) => ({
            from: m.from,
            to: m.to,
            promotion: m.promotion,
          })),
        },
      })
    );
  }

  private handleGameOver(reason?: string, winner?: string) {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }
    let finalWinner = winner ?? null;
    let finalReason = reason ?? "checkmate";
    if (!reason) {
      const turnWinner = this.board.turn() === "w" ? "black" : "white";
      if (this.board.isDraw()) {
        finalReason = "draw";
        finalWinner = null;
      } else if (this.board.isStalemate()) {
        finalReason = "stalemate";
        finalWinner = null;
      } else if (this.board.isThreefoldRepetition()) {
        finalReason = "repetition";
        finalWinner = null;
      } else if (this.board.isInsufficientMaterial()) {
        finalReason = "insufficient material";
        finalWinner = null;
      } else {
        finalWinner = turnWinner;
      }
    }
    this.player.send(
      JSON.stringify({
        type: GAME_OVER,
        payload: { winner: finalWinner, reason: finalReason },
      })
    );
    this.persistGameResult(finalWinner, finalReason);
    this.cleanup();
    if (this.onGameEnd) this.onGameEnd(this.gameId);
  }

  private async persistGameResult(
    winner: string | null,
    reason: string
  ): Promise<void> {
    if (this.dbUserId === null) return;
    const whiteUserId = this.playerColor === "white" ? this.dbUserId : null;
    const blackUserId = this.playerColor === "black" ? this.dbUserId : null;
    try {
      await gameHistoryService.saveGameResult({
        gameId: this.gameId,
        whiteUserId,
        blackUserId,
        fen: this.board.fen(),
        moveHistory: this.board.history({ verbose: true }).map((m: any) => ({
          from: m.from,
          to: m.to,
          ...(m.promotion ? { promotion: m.promotion } : {}),
        })),
        moveCount: this.moveCount,
        timeControl: this.timeControl ? this.timeControl / 60000 : null,
        winner,
        reason,
        isVsComputer: true,
        computerDifficulty: this.difficulty,
      });
    } catch (err) {
      console.error("Failed to persist computer game result:", err);
    }
  }

  private startTimeTracking() {
    if (this.timeControl === null) return;
    this.timeUpdateInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastMoveTime;
      const isPlayerTurn =
        (this.playerColor === "white" && this.board.turn() === "w") ||
        (this.playerColor === "black" && this.board.turn() === "b");
      if (isPlayerTurn && this.playerTime !== null) {
        this.playerTime -= elapsed;
      } else if (!isPlayerTurn && this.aiTime !== null) {
        this.aiTime -= elapsed;
      }
      this.lastMoveTime = now;
      if (this.playerTime !== null && this.playerTime <= 0) {
        this.endGameByTimeout("computer");
        return;
      }
      if (this.aiTime !== null && this.aiTime <= 0) {
        this.endGameByTimeout(this.playerColor);
        return;
      }
      this.sendTimeUpdate();
    }, 100);
  }

  private sendTimeUpdate() {
    if (this.playerTime === null || this.aiTime === null) return;
    const whiteTime =
      this.playerColor === "white" ? this.playerTime : this.aiTime;
    const blackTime =
      this.playerColor === "black" ? this.playerTime : this.aiTime;
    this.player.send(
      JSON.stringify({
        type: TIME_UPDATE,
        payload: {
          whiteTime: Math.max(0, whiteTime),
          blackTime: Math.max(0, blackTime),
        },
      })
    );
  }

  private endGameByTimeout(winner: string) {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }
    this.handleGameOver("timeout", winner);
  }

  cleanup() {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }
    if (this.stockfish) {
      try {
        this.stockfish.stdin.write("stop\n");
        this.stockfish.stdin.write("quit\n");
        this.stockfish.kill();
      } catch {}
      this.stockfish = null;
    }
    this.stockfishReady = false;
  }
}
