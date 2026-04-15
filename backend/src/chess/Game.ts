import { WebSocket } from "ws";
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
} from "./messages";
import { redisService, PersistedGame } from "./RedisService";
import { gameHistoryService } from "../services/gameHistoryService";
import { v4 as uuidv4 } from "uuid";

export class Game {
  public player1: WebSocket;
  public player2: WebSocket;
  public board: Chess;
  private startTime: Date;
  private moveCount = 0;

  // Persistent identity
  public gameId: string;
  public player1Id: string;  // ephemeral session ID (stored in Redis)
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
    player1: WebSocket,
    player2: WebSocket,
    player1DbUserId: number | null,
    player2DbUserId: number | null,
    timeControlMinutes: number | null = 10,
    restored?: {
      gameId: string;
      player1Id: string;
      player2Id: string;
      moveHistory: { from: string; to: string; promotion?: string }[];
      moveCount: number;
      player1Time: number | null;
      player2Time: number | null;
    }
  ) {
    this.player1 = player1;
    this.player2 = player2;
    this.player1DbUserId = player1DbUserId;
    this.player2DbUserId = player2DbUserId;
    this.board = new Chess();
    this.startTime = new Date();

    if (restored) {
      // ── Reconnection path ─────────────────────────────────────────────────
      this.gameId = restored.gameId;
      this.player1Id = restored.player1Id;
      this.player2Id = restored.player2Id;
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

      player1.send(JSON.stringify({ type: GAME_STATE, payload: { ...basePayload, yourColor: "white" } }));
      player2.send(JSON.stringify({ type: GAME_STATE, payload: { ...basePayload, yourColor: "black" } }));
    } else {
      // ── Fresh game path ───────────────────────────────────────────────────
      this.gameId = uuidv4();
      this.player1Id = uuidv4();
      this.player2Id = uuidv4();

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

      player1.send(
        JSON.stringify({
          type: INIT_GAME,
          payload: {
            color: "white",
            timeControl: timeControlMinutes,
            playerId: this.player1Id,
            gameId: this.gameId,
          },
        })
      );
      player2.send(
        JSON.stringify({
          type: INIT_GAME,
          payload: {
            color: "black",
            timeControl: timeControlMinutes,
            playerId: this.player2Id,
            gameId: this.gameId,
          },
        })
      );

      this.persistToRedis();
    }
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

    this.player1.send(JSON.stringify(timeUpdate));
    this.player2.send(JSON.stringify(timeUpdate));
  }

  private endGameByTimeout(winner: string) {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }

    const gameOverMessage = {
      type: GAME_OVER,
      payload: { winner, reason: "timeout" },
    };
    this.player1.send(JSON.stringify(gameOverMessage));
    this.player2.send(JSON.stringify(gameOverMessage));

    this.persistToRedis("over", winner, "timeout");
    this.persistGameResult(winner, "timeout");
    redisService
      .deleteGame(this.gameId, this.player1Id, this.player2Id)
      .catch(console.error);
  }

  makeMove(socket: WebSocket, move: { from: string; to: string }) {
    if (this.moveCount % 2 === 0 && socket !== this.player1) return;
    if (this.moveCount % 2 === 1 && socket !== this.player2) return;

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

      const gameOverMsg = JSON.stringify({
        type: GAME_OVER,
        payload: { winner: finalWinner, reason },
      });
      this.player1.send(gameOverMsg);
      this.player2.send(gameOverMsg);

      this.persistToRedis("over", finalWinner, reason);
      this.persistGameResult(finalWinner, reason);
      redisService
        .deleteGame(this.gameId, this.player1Id, this.player2Id)
        .catch(console.error);
      return;
    }

    const moveMsg = JSON.stringify({ type: MOVE, payload: move });
    if ((this.moveCount - 1) % 2 === 0) {
      this.player2.send(moveMsg);
    } else {
      this.player1.send(moveMsg);
    }

    if (this.timeControl !== null) {
      this.sendTimeUpdate();
    }

    this.persistToRedis();
  }

  getValidMoves(socket: WebSocket, square: string) {
    const isPlayer1Turn = this.moveCount % 2 === 0;
    if (isPlayer1Turn && socket !== this.player1) {
      socket.send(
        JSON.stringify({ type: VALID_MOVES, payload: { square, moves: [] } })
      );
      return;
    }
    if (!isPlayer1Turn && socket !== this.player2) {
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

  /**
   * Called by GameManager when one player's WebSocket closes.
   * Pauses that player's clock, notifies the staying player with a countdown,
   * and schedules a forfeit if they don't reconnect in time.
   */
  opponentDisconnected(disconnectedSocket: WebSocket) {
    const isPlayer1 = disconnectedSocket === this.player1;
    this.disconnectedPlayerId = isPlayer1 ? this.player1Id : this.player2Id;
    const stayingSocket = isPlayer1 ? this.player2 : this.player1;
    const winnerColor = isPlayer1 ? "black" : "white";

    // Pause the game clock so time doesn't drain while opponent is gone
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }

    let secondsLeft = RECONNECT_TIMEOUT_SECONDS;

    const sendCountdown = () => {
      if (stayingSocket.readyState === stayingSocket.OPEN) {
        stayingSocket.send(
          JSON.stringify({
            type: OPPONENT_DISCONNECTED,
            payload: {
              message: "Opponent disconnected.",
              secondsLeft,
            },
          })
        );
      }
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
   * Called by GameManager when the disconnected player successfully reconnects.
   * Resumes the game clock and notifies the staying player.
   */
  opponentReconnected(reconnectedSocket: WebSocket) {
    this.clearDisconnectTimers();
    this.disconnectedPlayerId = null;

    // Update the socket reference for the reconnected player
    const wasPlayer1 = this.player1Id === this.disconnectedPlayerId ||
      reconnectedSocket !== this.player2;
    if (wasPlayer1) {
      this.player1 = reconnectedSocket;
    } else {
      this.player2 = reconnectedSocket;
    }

    // Notify staying player
    const stayingSocket = wasPlayer1 ? this.player2 : this.player1;
    if (stayingSocket.readyState === stayingSocket.OPEN) {
      stayingSocket.send(
        JSON.stringify({
          type: OPPONENT_RECONNECTED,
          payload: { message: "Opponent reconnected. Game resumes!" },
        })
      );
    }

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

    const gameOverMessage = JSON.stringify({
      type: GAME_OVER,
      payload: { winner: winnerColor, reason: "opponent_left" },
    });

    // Only send to the staying (open) socket — the disconnected one is gone
    [this.player1, this.player2].forEach((s) => {
      if (s.readyState === s.OPEN) {
        s.send(gameOverMessage);
      }
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
