import { WebSocket } from "ws";
import { Chess } from "chess.js";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
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
 * Lichess-style difficulty configuration.
 *
 * Lichess uses three levers together:
 *   1. UCI_Elo          - calibrated ELO target
 *   2. movetime (ms)    - maximum time the engine may think per move
 *   3. depth            - maximum search depth (hard cap)
 *
 * Using ONLY depth or ONLY ELO leaves strength poorly controlled:
 *   - Depth alone: engine still chooses the best move at that depth, so easy
 *     levels don't actually blunder on purpose.
 *   - ELO alone without a movetime cap: Stockfish still thinks indefinitely
 *     and plays surprisingly well at low ELO because UCI_Elo error injection
 *     needs enough candidate moves to choose from, which requires real search.
 *
 * The combination is what creates believable human-like play at every level.
 *
 * Stockfish ELO reference:
 *   min supported UCI_Elo = 1320 (Stockfish clamps below this internally)
 *   To go below ~1320 reliably we keep movetime very short (50-100 ms) so
 *   the engine barely searches, guaranteeing genuine blunders.
 */
const DIFFICULTY_CONFIG: Record<
  Difficulty,
  { elo: number; movetime: number; depth: number; limitStrength: boolean }
> = {
  // ~800-1000 ELO: very short think time forces shallow search -> real blunders
  easy: { elo: 1320, movetime: 50, depth: 1, limitStrength: true },
  // ~1300-1500 ELO: Stockfish plays at its minimum rated strength with ~200 ms
  medium: { elo: 1500, movetime: 200, depth: 5, limitStrength: true },
  // ~1800-2000 ELO
  hard: { elo: 2000, movetime: 1000, depth: 12, limitStrength: true },
  // ~2500+ ELO: near full strength
  expert: { elo: 2800, movetime: 3000, depth: 20, limitStrength: false },
};

// Artificial UI delay so moves don't appear instant (separate from think time)
const DIFFICULTY_DELAY: Record<Difficulty, number> = {
  easy: 400,
  medium: 300,
  hard: 150,
  expert: 50,
};

/**
 * Resolve the Stockfish binary path.
 * Priority order:
 *   1. STOCKFISH_PATH env var (set in render.yaml pointing to downloaded binary)
 *   2. ./stockfish-bin  (downloaded by buildCommand in backend root dir)
 *   3. System PATH locations (for local dev where stockfish is installed)
 */
function getStockfishCandidates(): string[] {
  const candidates: string[] = [];

  // Env-var override (Render sets this via render.yaml)
  if (process.env.STOCKFISH_PATH) {
    candidates.push(process.env.STOCKFISH_PATH);
  }

  // Binary downloaded by buildCommand into backend root dir.
  // __dirname is dist/src/chess at runtime, so we go 3 levels up.
  candidates.push(path.join(__dirname, "..", "..", "..", "stockfish-bin"));
  // Also try relative to CWD (process.cwd() = backend/ on Render)
  candidates.push(path.join(process.cwd(), "stockfish-bin"));

  // System-installed fallbacks (local dev / apt)
  candidates.push("stockfish");
  candidates.push("/usr/games/stockfish");
  candidates.push("/usr/bin/stockfish");
  candidates.push("/usr/local/bin/stockfish");

  return candidates;
}

export class StockfishGame {
  public player: WebSocket;
  public board: Chess;
  public gameId: string;
  public playerId: string;
  private playerColor: "white" | "black";
  private difficulty: Difficulty;
  private stockfish: ChildProcessWithoutNullStreams | null = null;
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

    // If AI plays white, make first move
    if (playerColor === "black") {
      setTimeout(() => this.requestStockfishMove(), 500);
    }
  }

  private initStockfish() {
    const candidates = getStockfishCandidates();

    for (const bin of candidates) {
      try {
        const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });

        // Test if the process starts without error
        let started = false;
        proc.on("error", () => {
          // This candidate failed — try next
        });
        proc.stdout.setEncoding("utf8");

        // If we get any stdout, the process started successfully
        const cfg = DIFFICULTY_CONFIG[this.difficulty];

        proc.stdin.write("uci\n");
        proc.stdin.write("setoption name Threads value 1\n");
        proc.stdin.write("setoption name Hash value 16\n");
        proc.stdin.write("setoption name MultiPV value 1\n");

        if (cfg.limitStrength) {
          proc.stdin.write(`setoption name UCI_LimitStrength value true\n`);
          proc.stdin.write(`setoption name UCI_Elo value ${cfg.elo}\n`);
        } else {
          proc.stdin.write(`setoption name UCI_LimitStrength value false\n`);
        }

        proc.stdin.write("ucinewgame\n");
        proc.stdin.write("isready\n");

        this.stockfish = proc;
        console.log(
          `Stockfish started: ${bin} | difficulty: ${this.difficulty} | elo: ${cfg.elo} | movetime: ${cfg.movetime}ms | depth: ${cfg.depth}`
        );
        break;
      } catch {
        // Binary not found or failed to spawn — try next candidate
        console.warn(`Stockfish candidate failed: ${bin}`);
      }
    }

    if (!this.stockfish) {
      console.warn(
        "Stockfish not found in any candidate path — using random-move fallback.\n" +
        `Tried: ${getStockfishCandidates().join(", ")}`
      );
    }
  }

  private requestStockfishMove() {
    if (this.board.isGameOver()) return;

    const fen = this.board.fen();
    const cfg = DIFFICULTY_CONFIG[this.difficulty];
    const delay = DIFFICULTY_DELAY[this.difficulty];

    if (this.stockfish) {
      let responded = false;
      const onData = (data: string) => {
        const lines = data.split("\n");
        for (const line of lines) {
          if (line.startsWith("bestmove") && !responded) {
            responded = true;
            this.stockfish!.stdout.off("data", onData);
            const parts = line.trim().split(" ");
            const moveStr = parts[1];
            if (moveStr && moveStr !== "(none)") {
              setTimeout(() => {
                this.applyAiMove({
                  from: moveStr.slice(0, 2),
                  to: moveStr.slice(2, 4),
                  promotion:
                    moveStr.length > 4 ? moveStr[4] : undefined,
                });
              }, delay);
            }
          }
        }
      };

      this.stockfish.stdout.on("data", onData);
      // Set the position fresh each move
      this.stockfish.stdin.write(`position fen ${fen}\n`);
      // Use BOTH movetime AND depth caps, just like Lichess.
      // Stockfish will stop at whichever limit is hit first.
      this.stockfish.stdin.write(
        `go movetime ${cfg.movetime} depth ${cfg.depth}\n`
      );
    } else {
      // Fallback: random legal move
      setTimeout(() => {
        const moves = this.board.moves({ verbose: true });
        if (moves.length > 0) {
          const m = moves[Math.floor(Math.random() * moves.length)];
          this.applyAiMove({ from: m.from, to: m.to, promotion: (m as any).promotion });
        }
      }, delay);
    }
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
    if (this.dbUserId === null) return; // guest — don't save
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
  }
}
