import { WebSocket } from "ws";
import { INIT_GAME, MOVE, GET_VALID_MOVES, RECONNECT } from "./messages";
import { Game } from "./Game";
import { redisService } from "./RedisService";

interface PendingPlayer {
  socket: WebSocket;
  timeControl: number | null;
  playerId: string;
  dbUserId: number | null; // null = anonymous
}

export class GameManager {
  private games: Game[];
  private pendingUsers: Map<string, PendingPlayer>; // key = timeControl string
  private users: WebSocket[];

  // playerId → socket for reconnection routing
  private playerSockets: Map<string, WebSocket> = new Map();

  constructor() {
    this.games = [];
    this.pendingUsers = new Map();
    this.users = [];
  }

  /**
   * Called from the WebSocket server after the JWT has been verified.
   * dbUserId is the authenticated user's database ID, or null for guests.
   */
  addUser(socket: WebSocket, dbUserId: number | null) {
    this.users.push(socket);
    this.addHandler(socket, dbUserId);
  }

  removeUser(socket: WebSocket) {
    this.users = this.users.filter((u) => u !== socket);

    // Remove from playerSockets index
    for (const [id, sock] of this.playerSockets.entries()) {
      if (sock === socket) {
        this.playerSockets.delete(id);
        break;
      }
    }

    // Remove from pending queue
    for (const [key, pending] of this.pendingUsers.entries()) {
      if (pending.socket === socket) {
        this.pendingUsers.delete(key);
        redisService.deletePendingPlayer(key).catch(console.error);
        break;
      }
    }

    // Notify opponent if in active game (state stays in Redis for reconnect)
    const game = this.games.find(
      (g) => g.player1 === socket || g.player2 === socket
    );
    if (game) {
      game.cleanup();
      const otherPlayer =
        game.player1 === socket ? game.player2 : game.player1;
      otherPlayer.send(
        JSON.stringify({
          type: "OPPONENT_DISCONNECTED",
          payload: {
            message: "Opponent disconnected. They can rejoin to continue.",
          },
        })
      );
      this.games = this.games.filter((g) => g !== game);
    }
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

          this.pendingUsers.delete(timeControlKey);
          await redisService.deletePendingPlayer(timeControlKey);

          // pendingPlayer is white (player1), incoming socket is black (player2)
          const game = new Game(
            pendingPlayer.socket,
            socket,
            pendingPlayer.dbUserId,
            dbUserId,
            timeControl
          );
          this.games.push(game);

          this.playerSockets.set(game.player1Id, pendingPlayer.socket);
          this.playerSockets.set(game.player2Id, socket);
        } else {
          console.log("No match, adding to pending queue");

          for (const [key, pending] of this.pendingUsers.entries()) {
            if (pending.socket === socket) {
              this.pendingUsers.delete(key);
              await redisService.deletePendingPlayer(key);
            }
          }

          const playerId =
            message.payload?.playerId || this.generateId();
          this.pendingUsers.set(timeControlKey, {
            socket,
            timeControl,
            playerId,
            dbUserId,
          });
          this.playerSockets.set(playerId, socket);

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

      // ── MOVE ─────────────────────────────────────────────────────────────
      if (message.type === MOVE) {
        const game = this.games.find(
          (g) => g.player1 === socket || g.player2 === socket
        );
        if (game) {
          game.makeMove(socket, message.payload.move);
        }
        return;
      }

      // ── GET_VALID_MOVES ───────────────────────────────────────────────────
      if (message.type === GET_VALID_MOVES) {
        const game = this.games.find(
          (g) => g.player1 === socket || g.player2 === socket
        );
        if (game) {
          game.getValidMoves(socket, message.payload.square);
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

    this.playerSockets.set(playerId, socket);

    if (otherSocket && otherSocket.readyState === WebSocket.OPEN) {
      const player1Socket = isPlayer1 ? socket : otherSocket;
      const player2Socket = isPlayer1 ? otherSocket : socket;

      this.games = this.games.filter((g) => g.gameId !== persisted.gameId);

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

      this.games.push(game);
      this.playerSockets.set(game.player1Id, player1Socket);
      this.playerSockets.set(game.player2Id, player2Socket);

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
