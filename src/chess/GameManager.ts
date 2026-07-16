import { WebSocket } from "ws";
import { INIT_GAME, MOVE, GET_VALID_MOVES, RECONNECT, PLAY_VS_COMPUTER } from "./messages";
import { Game } from "./Game";
import { StockfishGame, Difficulty } from "./StockfishGame";
import { redisService } from "./RedisService";

interface PendingPlayer {
  socket: WebSocket;
  timeControl: number | null;
  playerId: string;
  dbUserId: number | null; // null = anonymous
}

/**
 * Routes WebSocket messages to the right Game / StockfishGame / matchmaking
 * queue.
 *
 * Lookups here used to be linear `Array.find()` scans over every active game
 * on every single incoming message (move, valid-moves request, disconnect).
 * That's O(n) per message with n = concurrent games, all competing for one
 * event loop — under load-testing this was the dominant cause of latency
 * growth (see SCALABILITY_REPORT.md). Everything below is now backed by Maps
 * keyed by socket / gameId / playerId so routing a message is O(1) regardless
 * of how many games are running concurrently.
 */
export class GameManager {
  // gameId -> Game (for reconnect-by-gameId lookups)
  private gamesById: Map<string, Game> = new Map();
  // socket -> Game (for routing move / get_valid_moves / disconnect by socket)
  private gameBySocket: Map<WebSocket, Game> = new Map();

  // socket -> StockfishGame (1:1, human socket -> its computer opponent game)
  private computerGamesBySocket: Map<WebSocket, StockfishGame> = new Map();

  // timeControl bucket -> the one player currently waiting in that bucket
  private pendingUsers: Map<string, PendingPlayer> = new Map();
  // reverse index so we can find (and cancel) a socket's pending queue entry
  // without scanning every bucket
  private pendingKeyBySocket: Map<WebSocket, string> = new Map();

  private users: Set<WebSocket> = new Set();

  // playerId → socket for reconnection routing
  private playerSockets: Map<string, WebSocket> = new Map();
  // reverse index so disconnect cleanup doesn't have to scan playerSockets
  private socketToPlayerId: Map<WebSocket, string> = new Map();

  /**
   * Called from the WebSocket server after the JWT has been verified.
   * dbUserId is the authenticated user's database ID, or null for guests.
   */
  addUser(socket: WebSocket, dbUserId: number | null) {
    this.users.add(socket);
    this.addHandler(socket, dbUserId);
  }

  removeUser(socket: WebSocket) {
    this.users.delete(socket);

    // Remove from playerSockets index
    const playerId = this.socketToPlayerId.get(socket);
    if (playerId) {
      this.playerSockets.delete(playerId);
      this.socketToPlayerId.delete(socket);
    }

    // Remove from pending queue
    const pendingKey = this.pendingKeyBySocket.get(socket);
    if (pendingKey) {
      this.pendingUsers.delete(pendingKey);
      this.pendingKeyBySocket.delete(socket);
      redisService.deletePendingPlayer(pendingKey).catch(console.error);
    }

    // Clean up computer game if this player had one
    const computerGame = this.computerGamesBySocket.get(socket);
    if (computerGame) {
      computerGame.cleanup();
      this.computerGamesBySocket.delete(socket);
    }

    // Notify opponent if in active game — start reconnect countdown instead of destroying game
    const game = this.gameBySocket.get(socket);
    if (game) {
      // Don't remove the game yet — keep it alive for potential reconnection
      game.opponentDisconnected(socket);
    }
  }

  /** Track a pending-queue entry in both directions. */
  private setPendingLocal(timeControlKey: string, pending: PendingPlayer) {
    this.pendingUsers.set(timeControlKey, pending);
    this.pendingKeyBySocket.set(pending.socket, timeControlKey);
  }

  private clearPendingLocal(timeControlKey: string) {
    const pending = this.pendingUsers.get(timeControlKey);
    if (pending) {
      this.pendingKeyBySocket.delete(pending.socket);
    }
    this.pendingUsers.delete(timeControlKey);
  }

  /** Track a playerId <-> socket link in both directions. */
  private linkPlayerSocket(playerId: string, socket: WebSocket) {
    this.playerSockets.set(playerId, socket);
    this.socketToPlayerId.set(socket, playerId);
  }

  /** Register a freshly created/restored game under both its sockets and its id. */
  private registerGame(game: Game) {
    this.gamesById.set(game.gameId, game);
    this.gameBySocket.set(game.player1, game);
    this.gameBySocket.set(game.player2, game);

    game.onGameEnd = (gameId) => {
      this.gamesById.delete(gameId);
      this.gameBySocket.delete(game.player1);
      this.gameBySocket.delete(game.player2);
    };
  }

  private addHandler(socket: WebSocket, dbUserId: number | null) {
    socket.on("message", async (data) => {
      let message: any;
      try {
        message = JSON.parse(data.toString());
      } catch {
        console.error("Invalid JSON from client");
        return;
      }

      // ── RECONNECT ────────────────────────────────────────────────────────
      if (message.type === RECONNECT) {
        await this.handleReconnect(socket, message.payload?.playerId, dbUserId);
        return;
      }

      // ── INIT_GAME ────────────────────────────────────────────────────────
      if (message.type === INIT_GAME) {
        let timeControl: number | null = null;
        if (
          message.payload?.timeControl !== undefined &&
          message.payload.timeControl !== null
        ) {
          timeControl = message.payload.timeControl;
        }

        const timeControlKey =
          timeControl === null ? "unlimited" : timeControl.toString();

        console.log(
          `Player (dbUserId=${dbUserId}) requesting game, timeControl:`,
          timeControl
        );

        let pendingPlayer = this.pendingUsers.get(timeControlKey);

        if (!pendingPlayer) {
          const redisPending = await redisService.getPendingPlayer(timeControlKey);
          if (redisPending) {
            const pendingSocket = this.playerSockets.get(redisPending.playerId);
            if (pendingSocket && pendingSocket !== socket) {
              pendingPlayer = {
                socket: pendingSocket,
                timeControl,
                playerId: redisPending.playerId,
                dbUserId: redisPending.dbUserId,
              };
            } else if (!pendingSocket) {
              await redisService.deletePendingPlayer(timeControlKey);
            }
          }
        }

        if (pendingPlayer && pendingPlayer.socket !== socket) {
          console.log("Match found, creating game with timeControl:", timeControl);

          this.clearPendingLocal(timeControlKey);
          await redisService.deletePendingPlayer(timeControlKey);

          // pendingPlayer is white (player1), incoming socket is black (player2)
          const game = new Game(
            pendingPlayer.socket,
            socket,
            pendingPlayer.dbUserId,
            dbUserId,
            timeControl
          );
          this.registerGame(game);

          this.linkPlayerSocket(game.player1Id, pendingPlayer.socket);
          this.linkPlayerSocket(game.player2Id, socket);
        } else {
          console.log("No match, adding to pending queue");

          // A socket can only ever have one pending-queue entry at a time.
          const existingKey = this.pendingKeyBySocket.get(socket);
          if (existingKey) {
            this.clearPendingLocal(existingKey);
            await redisService.deletePendingPlayer(existingKey);
          }

          const playerId =
            message.payload?.playerId || this.generateId();
          this.setPendingLocal(timeControlKey, {
            socket,
            timeControl,
            playerId,
            dbUserId,
          });
          this.linkPlayerSocket(playerId, socket);

          await redisService.setPendingPlayer(timeControlKey, {
            playerId,
            dbUserId,
            timeControl,
            timestamp: Date.now(),
          });

          socket.send(
            JSON.stringify({
              type: "WAITING",
              payload: {
                message: "Waiting for opponent with same time control...",
                timeControl,
              },
            })
          );
        }
        return;
      }

      // ── PLAY_VS_COMPUTER ─────────────────────────────────────────────────
      if (message.type === PLAY_VS_COMPUTER) {
        const difficulty: Difficulty = message.payload?.difficulty || "medium";
        const playerColor: "white" | "black" = message.payload?.color || "white";
        const timeControl: number | null = message.payload?.timeControl ?? null;

        // Clean up any existing computer game for this socket
        const existingCG = this.computerGamesBySocket.get(socket);
        if (existingCG) {
          existingCG.cleanup();
          this.computerGamesBySocket.delete(socket);
        }

        console.log(`Starting computer game: difficulty=${difficulty}, color=${playerColor}, timeControl=${timeControl}`);

        const cg = new StockfishGame(socket, playerColor, difficulty, timeControl, dbUserId);
        cg.onGameEnd = () => {
          this.computerGamesBySocket.delete(socket);
        };
        this.computerGamesBySocket.set(socket, cg);
        this.linkPlayerSocket(cg.playerId, socket);
        return;
      }

      // ── MOVE ─────────────────────────────────────────────────────────────
      if (message.type === MOVE) {
        const game = this.gameBySocket.get(socket);
        if (game) {
          game.makeMove(socket, message.payload.move);
          return;
        }
        const cg = this.computerGamesBySocket.get(socket);
        if (cg) {
          cg.makeMove(socket, message.payload.move);
        }
        return;
      }

      // ── GET_VALID_MOVES ───────────────────────────────────────────────────
      if (message.type === GET_VALID_MOVES) {
        const game = this.gameBySocket.get(socket);
        if (game) {
          game.getValidMoves(socket, message.payload.square);
          return;
        }
        const cg = this.computerGamesBySocket.get(socket);
        if (cg) {
          cg.getValidMoves(socket, message.payload.square);
        }
        return;
      }
    });
  }

  private async handleReconnect(
    socket: WebSocket,
    playerId: string | undefined,
    dbUserId: number | null
  ) {
    if (!playerId) {
      socket.send(
        JSON.stringify({
          type: "ERROR",
          payload: { message: "No playerId provided for reconnect" },
        })
      );
      return;
    }

    console.log("Reconnect attempt for playerId:", playerId);

    const persisted = await redisService.getGameByPlayerId(playerId);
    if (!persisted || persisted.status !== "active") {
      socket.send(
        JSON.stringify({
          type: "NO_GAME",
          payload: { message: "No active game found to resume." },
        })
      );
      return;
    }

    const isPlayer1 = persisted.player1Id === playerId;
    const otherPlayerId = isPlayer1
      ? persisted.player2Id
      : persisted.player1Id;
    const otherSocket = this.playerSockets.get(otherPlayerId);

    this.linkPlayerSocket(playerId, socket);

    // Check if the game is still alive in memory (opponent is still connected)
    const liveGame = this.gamesById.get(persisted.gameId);

    if (liveGame && otherSocket && otherSocket.readyState === WebSocket.OPEN) {
      // Drop the stale socket->game mapping for whichever socket is being replaced
      const oldSocket = isPlayer1 ? liveGame.player1 : liveGame.player2;
      this.gameBySocket.delete(oldSocket);

      // Update the socket on the live game object
      if (isPlayer1) {
        liveGame.player1 = socket;
      } else {
        liveGame.player2 = socket;
      }
      this.gameBySocket.set(socket, liveGame);
      this.linkPlayerSocket(playerId, socket);

      // Resume the game and notify both players
      liveGame.opponentReconnected(socket);

      // Resend full game state to the reconnecting player
      const basePayload = {
        fen: liveGame.board.fen(),
        moveCount: liveGame["moveCount"],
        whiteTime: liveGame["player1Time"] !== null ? Math.max(0, liveGame["player1Time"]) : null,
        blackTime: liveGame["player2Time"] !== null ? Math.max(0, liveGame["player2Time"]) : null,
        timeControl: persisted.timeControl,
        yourColor: isPlayer1 ? "white" : "black",
      };
      socket.send(JSON.stringify({ type: "game_state", payload: basePayload }));

      console.log("Player reconnected to live game:", persisted.gameId);
      return;
    }

    if (otherSocket && otherSocket.readyState === WebSocket.OPEN) {
      const player1Socket = isPlayer1 ? socket : otherSocket;
      const player2Socket = isPlayer1 ? otherSocket : socket;

      if (liveGame) {
        this.gamesById.delete(liveGame.gameId);
        this.gameBySocket.delete(liveGame.player1);
        this.gameBySocket.delete(liveGame.player2);
      }

      const game = new Game(
        player1Socket,
        player2Socket,
        persisted.player1DbUserId,
        persisted.player2DbUserId,
        persisted.timeControl,
        {
          gameId: persisted.gameId,
          player1Id: persisted.player1Id,
          player2Id: persisted.player2Id,
          moveHistory: persisted.moveHistory,
          moveCount: persisted.moveCount,
          player1Time: persisted.player1Time,
          player2Time: persisted.player2Time,
        }
      );
      this.registerGame(game);

      this.linkPlayerSocket(game.player1Id, player1Socket);
      this.linkPlayerSocket(game.player2Id, player2Socket);

      console.log("Game restored for gameId:", persisted.gameId);
    } else {
      socket.send(
        JSON.stringify({
          type: "WAITING_FOR_OPPONENT",
          payload: {
            message: "Reconnected. Waiting for your opponent to rejoin...",
          },
        })
      );
    }
  }

  private generateId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
