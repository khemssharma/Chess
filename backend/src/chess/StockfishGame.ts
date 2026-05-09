import { WebSocket } from "ws";
import { Chess } from "chess.js";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
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

const DIFFICULTY_ELO: Record<Difficulty, number> = {
  easy: 1320,
  medium: 1600,
  hard: 2200,
  expert: 3000,
};

const DIFFICULTY_SKILL_LEVEL: Record<Difficulty, number> = {
  easy: 0,
  medium: 7,
  hard: 14,
  expert: 20,
};

const DIFFICULTY_DEPTH: Record<Difficulty, number> = {
  easy: 1,
  medium: 5,
  hard: 12,
  expert: 20,
};

const DIFFICULTY_DELAY: Record<Difficulty, number> = {
  easy: 1000,
  medium: 600,
  hard: 300,
  expert: 100,
};

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

    this.timeControl = timeControlMinutes !== null ? timeControlMinutes * 60 * 1000 : null;
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
    const candidates = [
      "stockfish",
      "/usr/games/stockfish",
      "/usr/bin/stockfish",
      "/usr/local/bin/stockfish",
    ];

    for (const bin of candidates) {
      try {
        this.stockfish = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
        this.stockfish.on("error", () => { this.stockfish = null; });
        this.stockfish.stdout.setEncoding("utf8");

        this.stockfish.stdin.write("uci\n");
        this.stockfish.stdin.write(`setoption name Skill Level value ${DIFFICULTY_SKILL_LEVEL[this.difficulty]}\n`);
        this.stockfish.stdin.write(`setoption name UCI_LimitStrength value true\n`);
        this.stockfish.stdin.write(`setoption name UCI_Elo value ${DIFFICULTY_ELO[this.difficulty]}\n`);
        this.stockfish.stdin.write("isready\n");

        console.log(`Stockfish started: ${bin}`);
        break;
      } catch {
        this.stockfish = null;
      }
    }

    if (!this.stockfish) {
      console.warn("Stockfish not found — using random-move fallback");
    }
  }

  private requestStockfishMove() {
    if (this.board.isGameOver()) return;

    const fen = this.board.fen();
    const depth = DIFFICULTY_DEPTH[this.difficulty];
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
                  promotion: moveStr.length > 4 ? moveStr[4] : undefined,
                });
              }, delay);
            }
          }
        }
      };

      this.stockfish.stdout.on("data", onData);
      this.stockfish.stdin.write(`position fen ${fen}\n`);
      this.stockfish.stdin.write(`go depth ${depth}\n`);
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

  makeMove(socket: WebSocket, move: { from: string; to: string; promotion?: string }) {
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
      socket.send(JSON.stringify({ type: VALID_MOVES, payload: { square, moves: [] } }));
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
      if (this.board.isDraw()) { finalReason = "draw"; finalWinner = null; }
      else if (this.board.isStalemate()) { finalReason = "stalemate"; finalWinner = null; }
      else if (this.board.isThreefoldRepetition()) { finalReason = "repetition"; finalWinner = null; }
      else if (this.board.isInsufficientMaterial()) { finalReason = "insufficient material"; finalWinner = null; }
      else { finalWinner = turnWinner; }
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

  private async persistGameResult(winner: string | null, reason: string): Promise<void> {
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

    const whiteTime = this.playerColor === "white" ? this.playerTime : this.aiTime;
    const blackTime = this.playerColor === "black" ? this.playerTime : this.aiTime;

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
        this.stockfish.stdin.write("quit\n");
        this.stockfish.kill();
      } catch {}
      this.stockfish = null;
    }
  }
}
