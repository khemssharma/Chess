import { Chess } from "chess.js";
import {
  GAME_OVER,
  INIT_GAME,
  MOVE,
  VALID_MOVES,
  TIME_UPDATE,
  GAME_STATE,
  OPPONENT_DISCONNECTED,
  OPPONENT_RECONNECTED,
  RECONNECT_TIMEOUT_SECONDS,
} from "./messages.js";
import { redisService, PersistedGame } from "./RedisService.js";
import { gameHistoryService } from "../services/gameHistoryService.js";
import { v4 as uuidv4 } from "uuid";

/**
 * A Game no longer holds direct WebSocket references. That's the key change
 * that makes horizontal scaling possible: player1 and player2 can be
 * connected to two *different* server processes (Render's load balancer
 * assigns each WebSocket connection to a random instance — there's no
 * sticky-session option for WS on Render). All delivery to a player goes
 * through `redisService.publishToPlayer`, which every instance subscribes to
 * and only actually delivers if it holds that playerId's live socket. All
 * identity/turn checks are by playerId (a stable string) instead of `===` on
 * a socket object that only exists in one process's memory.
 *
 * Exactly one instance — whichever created or last rebuilt this Game object
 * — owns it and runs its clock/timers. Client actions that arrive on a
 * *different* instance are forwarded here via `chess:game-command` (see
 * GameManager); this class doesn't need to know or care where a message
 * originated, only which playerId sent it.
 */
export class Game {
  public board: Chess;
  private startTime: Date;
  private moveCount = 0;

  // Persistent identity
  public gameId: string;
  public player1Id: string; // ephemeral session ID (stored in Redis)
  public player2Id: string;

  // Link to authenticated DB users (null = anonymous/guest)
  public player1DbUserId: number | null;
  public player2DbUserId: number | null;

  // Time control
  private timeControl: number | null;
  private player1Time: number | null;
  private player2Time: number | null;
  private lastMoveTime: number;
  private timeUpdateInterval: NodeJS.Timeout | null = null;

  // Disconnect / reconnect timeout
  private disconnectTimeout: NodeJS.Timeout | null = null;
  private disconnectCountdownInterval: NodeJS.Timeout | null = null;
  private disconnectedPlayerId: string | null = null;

  /** Called by GameManager so it can remove this game from its list when it ends by forfeit */
  public onGameEnd: ((gameId: string) => void) | null = null;

  constructor(
    player1Id: string,
    player2Id: string,
    player1DbUserId: number | null,
    player2DbUserId: number | null,
    timeControlMinutes: number | null = 10,
    restored?: {
      gameId: string;
      moveHistory: { from: string; to: string; promotion?: string }[];
      moveCount: number;
      player1Time: number | null;
      player2Time: number | null;
    }
  ) {
    this.player1Id = player1Id;
    this.player2Id = player2Id;
    this.player1DbUserId = player1DbUserId;
    this.player2DbUserId = player2DbUserId;
    this.board = new Chess();
    this.startTime = new Date();

    if (restored) {
      // ── Reconnection path ─────────────────────────────────────────────────
      this.gameId = restored.gameId;
      this.moveCount = restored.moveCount;

      for (const move of restored.moveHistory) {
        this.board.move(move);
      }

      this.timeControl =
        timeControlMinutes !== null ? timeControlMinutes * 60 * 1000 : null;
      this.player1Time = restored.player1Time;
      this.player2Time = restored.player2Time;
      this.lastMoveTime = Date.now();

      if (this.timeControl !== null) {
        this.startTimeTracking();
      }

      const basePayload = {
        fen: this.board.fen(),
        moveCount: this.moveCount,
        whiteTime: this.player1Time !== null ? Math.max(0, this.player1Time) : null,
        blackTime: this.player2Time !== null ? Math.max(0, this.player2Time) : null,
        timeControl: timeControlMinutes,
      };

      this.sendTo(this.player1Id, { type: GAME_STATE, payload: { ...basePayload, yourColor: "white" } });
      this.sendTo(this.player2Id, { type: GAME_STATE, payload: { ...basePayload, yourColor: "black" } });
    } else {
      // ── Fresh game path ───────────────────────────────────────────────────
      this.gameId = uuidv4();

      if (timeControlMinutes !== null) {
        this.timeControl = timeControlMinutes * 60 * 1000;
        this.player1Time = this.timeControl;
        this.player2Time = this.timeControl;
        this.lastMoveTime = Date.now();
        this.startTimeTracking();
      } else {
        this.timeControl = null;
        this.player1Time = null;
        this.player2Time = null;
        this.lastMoveTime = 0;
      }

      this.sendTo(this.player1Id, {
        type: INIT_GAME,
        payload: {
          color: "white",
          timeControl: timeControlMinutes,
          playerId: this.player1Id,
          gameId: this.gameId,
        },
      });
      this.sendTo(this.player2Id, {
        type: INIT_GAME,
        payload: {
          color: "black",
          timeControl: timeControlMinutes,
          playerId: this.player2Id,
          gameId: this.gameId,
        },
      });

      this.persistToRedis();
    }
  }

  // ── Read-only accessors (used by GameManager to build reconnect payloads) ──
  get moveNumber(): number {
    return this.moveCount;
  }
  get player1TimeRemaining(): number | null {
    return this.player1Time;
  }
  get player2TimeRemaining(): number | null {
    return this.player2Time;
  }

  /** Deliver a message to one player, wherever their socket currently lives. */
  private sendTo(playerId: string, message: unknown) {
    redisService.publishToPlayer(playerId, this.gameId, message).catch(console.error);
  }

  private broadcast(message: unknown) {
    this.sendTo(this.player1Id, message);
    this.sendTo(this.player2Id, message);
  }

  private buildSnapshot(
    status: "active" | "over" = "active",
    winner: string | null = null,
    reason: string | null = null
  ): PersistedGame {
    return {
      gameId: this.gameId,
      player1Id: this.player1Id,
      player2Id: this.player2Id,
      player1DbUserId: this.player1DbUserId,
      player2DbUserId: this.player2DbUserId,
      fen: this.board.fen(),
      moveHistory: this.board.history({ verbose: true }).map((m: any) => ({
        from: m.from,
        to: m.to,
        ...(m.promotion ? { promotion: m.promotion } : {}),
      })),
      moveCount: this.moveCount,
      timeControl: this.timeControl ? this.timeControl / 60000 : null,
      player1Time: this.player1Time,
      player2Time: this.player2Time,
      lastMoveTimestamp: this.lastMoveTime,
      status,
      winner,
      reason,
    };
  }

  private persistToRedis(
    status: "active" | "over" = "active",
    winner: string | null = null,
    reason: string | null = null
  ) {
    redisService
      .saveGame(this.buildSnapshot(status, winner, reason))
      .catch(console.error);
  }

  /**
   * Persists the completed game to PostgreSQL so it appears in player histories.
   * Only saves if at least one player is an authenticated user.
   */
  private async persistGameResult(
    winner: string | null,
    reason: string
  ): Promise<void> {
    if (this.player1DbUserId === null && this.player2DbUserId === null) return;

    try {
      await gameHistoryService.saveGameResult({
        gameId: this.gameId,
        whiteUserId: this.player1DbUserId,
        blackUserId: this.player2DbUserId,
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
      });
    } catch (err) {
      console.error("Failed to persist game result to DB:", err);
    }
  }

  private startTimeTracking() {
    if (this.timeControl === null) return;

    this.timeUpdateInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastMoveTime;

      if (this.moveCount % 2 === 0 && this.player1Time !== null) {
        this.player1Time -= elapsed;
      } else if (this.player2Time !== null) {
        this.player2Time -= elapsed;
      }

      this.lastMoveTime = now;

      if (this.player1Time !== null && this.player1Time <= 0) {
        this.endGameByTimeout("black");
        return;
      }
      if (this.player2Time !== null && this.player2Time <= 0) {
        this.endGameByTimeout("white");
        return;
      }

      this.sendTimeUpdate();
    }, 100);
  }

  private sendTimeUpdate() {
    if (this.player1Time === null || this.player2Time === null) return;

    const timeUpdate = {
      type: TIME_UPDATE,
      payload: {
        whiteTime: Math.max(0, this.player1Time),
        blackTime: Math.max(0, this.player2Time),
      },
    };

    this.broadcast(timeUpdate);
  }

  private endGameByTimeout(winner: string) {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }

    this.broadcast({ type: GAME_OVER, payload: { winner, reason: "timeout" } });

    this.persistToRedis("over", winner, "timeout");
    this.persistGameResult(winner, "timeout");
    redisService
      .deleteGame(this.gameId, this.player1Id, this.player2Id)
      .catch(console.error);

    if (this.onGameEnd) this.onGameEnd(this.gameId);
  }

  /** `callerPlayerId` is whichever player sent the move — resolved by GameManager from the socket (local) or from a relayed game-command (remote). */
  makeMove(callerPlayerId: string, move: { from: string; to: string; promotion?: string }) {
    if (this.moveCount % 2 === 0 && callerPlayerId !== this.player1Id) return;
    if (this.moveCount % 2 === 1 && callerPlayerId !== this.player2Id) return;

    try {
      this.board.move(move);
    } catch (e) {
      console.log(e);
      return;
    }

    if (this.timeControl !== null) {
      this.lastMoveTime = Date.now();
    }

    this.moveCount++;

    if (this.board.isGameOver()) {
      if (this.timeUpdateInterval) {
        clearInterval(this.timeUpdateInterval);
        this.timeUpdateInterval = null;
      }

      const winner = this.board.turn() === "w" ? "black" : "white";
      let reason = "checkmate";
      if (this.board.isDraw()) reason = "draw";
      else if (this.board.isStalemate()) reason = "stalemate";
      else if (this.board.isThreefoldRepetition()) reason = "repetition";
      else if (this.board.isInsufficientMaterial()) reason = "insufficient material";

      const finalWinner = this.board.isDraw() ? null : winner;

      this.broadcast({ type: GAME_OVER, payload: { winner: finalWinner, reason } });

      this.persistToRedis("over", finalWinner, reason);
      this.persistGameResult(finalWinner, reason);
      redisService
        .deleteGame(this.gameId, this.player1Id, this.player2Id)
        .catch(console.error);

      if (this.onGameEnd) this.onGameEnd(this.gameId);
      return;
    }

    const moveMsg = { type: MOVE, payload: move };
    if ((this.moveCount - 1) % 2 === 0) {
      this.sendTo(this.player2Id, moveMsg);
    } else {
      this.sendTo(this.player1Id, moveMsg);
    }

    if (this.timeControl !== null) {
      this.sendTimeUpdate();
    }

    this.persistToRedis();
  }

  getValidMoves(callerPlayerId: string, square: string) {
    const isPlayer1Turn = this.moveCount % 2 === 0;
    if (isPlayer1Turn && callerPlayerId !== this.player1Id) {
      this.sendTo(callerPlayerId, { type: VALID_MOVES, payload: { square, moves: [] } });
      return;
    }
    if (!isPlayer1Turn && callerPlayerId !== this.player2Id) {
      this.sendTo(callerPlayerId, { type: VALID_MOVES, payload: { square, moves: [] } });
      return;
    }

    const moves = this.board.moves({ square: square as any, verbose: true });
    this.sendTo(callerPlayerId, {
      type: VALID_MOVES,
      payload: {
        square,
        moves: moves.map((m: any) => ({
          from: m.from,
          to: m.to,
          promotion: m.promotion,
        })),
      },
    });
  }

  /**
   * Called by GameManager when one player's WebSocket closes — whether that
   * socket lives on this instance (owner) or was relayed here from another
   * instance via a DISCONNECT game-command.
   */
  opponentDisconnected(disconnectedPlayerId: string) {
    const isPlayer1 = disconnectedPlayerId === this.player1Id;
    this.disconnectedPlayerId = disconnectedPlayerId;
    const stayingPlayerId = isPlayer1 ? this.player2Id : this.player1Id;
    const winnerColor = isPlayer1 ? "black" : "white";

    // Pause the game clock so time doesn't drain while opponent is gone
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }

    let secondsLeft = RECONNECT_TIMEOUT_SECONDS;

    const sendCountdown = () => {
      this.sendTo(stayingPlayerId, {
        type: OPPONENT_DISCONNECTED,
        payload: { message: "Opponent disconnected.", secondsLeft },
      });
    };

    sendCountdown();

    // Tick every second so the frontend can show a live countdown
    this.disconnectCountdownInterval = setInterval(() => {
      secondsLeft--;
      sendCountdown();
    }, 1000);

    // Forfeit after the timeout window
    this.disconnectTimeout = setTimeout(() => {
      this.clearDisconnectTimers();
      this.endGameByForfeit(winnerColor);
    }, RECONNECT_TIMEOUT_SECONDS * 1000);
  }

  /**
   * Called by GameManager when the disconnected player successfully
   * reconnects — anywhere. Since players are identified by playerId (not a
   * live socket reference this class holds), there's nothing to "swap" here
   * beyond clearing timers and resuming the clock; delivery already resolves
   * to wherever the reconnected socket actually is.
   */
  opponentReconnected(reconnectedPlayerId: string) {
    this.clearDisconnectTimers();
    this.disconnectedPlayerId = null;

    const isPlayer1 = reconnectedPlayerId === this.player1Id;
    const stayingPlayerId = isPlayer1 ? this.player2Id : this.player1Id;

    this.sendTo(stayingPlayerId, {
      type: OPPONENT_RECONNECTED,
      payload: { message: "Opponent reconnected. Game resumes!" },
    });

    // Resume clock
    if (this.timeControl !== null) {
      this.lastMoveTime = Date.now();
      this.startTimeTracking();
    }
  }

  private clearDisconnectTimers() {
    if (this.disconnectTimeout) {
      clearTimeout(this.disconnectTimeout);
      this.disconnectTimeout = null;
    }
    if (this.disconnectCountdownInterval) {
      clearInterval(this.disconnectCountdownInterval);
      this.disconnectCountdownInterval = null;
    }
  }

  private endGameByForfeit(winnerColor: string) {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }

    this.broadcast({
      type: GAME_OVER,
      payload: { winner: winnerColor, reason: "opponent_left" },
    });

    this.persistToRedis("over", winnerColor, "opponent_left");
    this.persistGameResult(winnerColor, "opponent_left");
    redisService
      .deleteGame(this.gameId, this.player1Id, this.player2Id)
      .catch(console.error);

    // Notify GameManager to remove this game from its active list
    if (this.onGameEnd) this.onGameEnd(this.gameId);
  }

  cleanup() {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }
    this.clearDisconnectTimers();
  }
}
