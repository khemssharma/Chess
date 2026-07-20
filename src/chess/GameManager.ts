import { WebSocket } from "ws";
import { INIT_GAME, MOVE, GET_VALID_MOVES, RECONNECT, PLAY_VS_COMPUTER, GAME_STATE } from "./messages.js";
import { Game } from "./Game.js";
import { StockfishGame, Difficulty } from "./StockfishGame.js";
import { redisService, GameCommandEnvelope, ToPlayerEnvelope } from "./RedisService.js";
import { v4 as uuidv4 } from "uuid";

interface PendingPlayer {
  socket: WebSocket;
  timeControl: number | null;
  playerId: string;
  dbUserId: number | null; // null = anonymous
}

const OWNERSHIP_TTL_SECONDS = 60;
const OWNERSHIP_REFRESH_MS = 20_000;

/**
 * Routes WebSocket messages to the right Game / StockfishGame / matchmaking
 * queue.
 *
 * ── Horizontal scaling ──────────────────────────────────────────────────────
 * Render assigns each incoming WebSocket connection to a random instance —
 * there's no sticky-session option for WS here — so the two players in a
 * game can easily end up on two different processes. Every process runs its
 * own GameManager with its own local Maps; a Game object physically lives in
 * exactly one instance's memory (whichever instance created or rebuilt it —
 * its "owner"), and Game itself no longer touches WebSocket objects at all
 * (see Game.ts). Two Redis pub/sub channels bridge the gap:
 *
 *  - `chess:to-player`   (RedisService.publishToPlayer / onPlayerMessage)
 *      Game -> client delivery. Every instance subscribes; each one checks
 *      whether it holds that playerId's live local socket and, if so,
 *      forwards the message. Instances that don't own the Game use this to
 *      learn (opportunistically, on the first delivery) which gameId a local
 *      player belongs to — see `remoteGameByPlayerId` below.
 *
 *  - `chess:game-command` (RedisService.publishGameCommand / onGameCommand)
 *      client -> Game delivery, the reverse direction. When a MOVE (etc.)
 *      arrives on an instance that doesn't own the Game locally, it's
 *      forwarded here; every instance subscribes, and only the one with a
 *      matching entry in `gamesById` (the owner) actually acts on it.
 *
 * Matchmaking's pending-player queue was already Redis-backed for
 * persistence, but the old code required the *other* player's socket to be
 * present in this same instance's local map to complete a match — which
 * silently failed (and just re-queued) whenever the waiting player was
 * connected to a different instance. That's fixed below: matches complete
 * using playerId identity alone, and `chess:to-player` handles delivering
 * INIT_GAME to whichever instance actually holds that player's socket.
 * Matching itself now goes through `consumePendingPlayer` (Redis GETDEL),
 * which is atomic — the old GET-then-DELETE pair could let two instances
 * both match against the same waiting player at once.
 */
export class GameManager {
  private readonly instanceId = uuidv4();

  get id(): string {
    return this.instanceId;
  }

  // gameId -> Game, for games this instance owns (created or rebuilt here).
  private gamesById: Map<string, Game> = new Map();
  // socket -> Game, local fast path for owned games (no Redis round-trip).
  private gameBySocket: Map<WebSocket, Game> = new Map();
  // gameId -> (playerId -> local socket), so ended/rebuilt/reconnected games
  // can clean up or replace exactly the right gameBySocket entries.
  private socketsForGame: Map<string, Map<string, WebSocket>> = new Map();

  // playerId -> gameId, for local sockets whose Game is owned by *another*
  // instance. Populated opportunistically whenever a chess:to-player message
  // is delivered to a socket this instance doesn't own a Game for.
  private remoteGameByPlayerId: Map<string, string> = new Map();

  // socket -> StockfishGame (1:1, human socket -> its computer opponent game)
  // Always fully local — no cross-instance concerns for vs-computer games.
  private computerGamesBySocket: Map<WebSocket, StockfishGame> = new Map();

  // timeControl bucket -> the one player currently waiting in that bucket,
  // *if* they're connected to this instance. The authoritative copy (which
  // may belong to a waiter on a different instance) lives in Redis.
  private pendingUsers: Map<string, PendingPlayer> = new Map();
  private pendingKeyBySocket: Map<WebSocket, string> = new Map();

  private users: Set<WebSocket> = new Set();

  // playerId -> socket, only for sockets actually connected to this instance.
  private playerSockets: Map<string, WebSocket> = new Map();
  private socketToPlayerId: Map<WebSocket, string> = new Map();

  constructor() {
    redisService.onPlayerMessage((envelope) => this.handleToPlayerMessage(envelope));
    redisService.onGameCommand((envelope) => this.handleGameCommand(envelope));

    // Keep this instance's ownership claim on its live games fresh so a
    // healthy owner is never mistaken for a crashed one (see
    // RedisService.claimGameOwnership).
    setInterval(() => {
      for (const gameId of this.gamesById.keys()) {
        redisService
          .refreshGameOwnership(gameId, this.instanceId, OWNERSHIP_TTL_SECONDS)
          .catch(console.error);
      }
    }, OWNERSHIP_REFRESH_MS);
  }

  // ── Cross-instance message handlers ─────────────────────────────────────────

  /** A Game (wherever it lives) wants to deliver `message` to `playerId`. */
  private handleToPlayerMessage({ playerId, gameId, message }: ToPlayerEnvelope) {
    const socket = this.playerSockets.get(playerId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));

    // If we don't own this game locally, remember where to forward this
    // player's future commands.
    if (!this.gameBySocket.has(socket)) {
      this.remoteGameByPlayerId.set(playerId, gameId);
    }
  }

  /** A client action was forwarded here from an instance that doesn't own the Game. */
  private handleGameCommand(envelope: GameCommandEnvelope) {
    const game = this.gamesById.get(envelope.gameId);
    if (!game) return; // not ours — some other instance (or nobody) owns it

    switch (envelope.type) {
      case "MOVE":
        game.makeMove(envelope.playerId, envelope.payload?.move);
        break;
      case "GET_VALID_MOVES":
        game.getValidMoves(envelope.playerId, envelope.payload?.square);
        break;
      case "DISCONNECT":
        game.opponentDisconnected(envelope.playerId);
        break;
      case "RECONNECT":
        game.opponentReconnected(envelope.playerId);
        break;
    }
  }

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

    const playerId = this.socketToPlayerId.get(socket);
    if (playerId) {
      this.playerSockets.delete(playerId);
      this.socketToPlayerId.delete(socket);
    }

    // Remove from pending queue
    const pendingKey = this.pendingKeyBySocket.get(socket);
    if (pendingKey) {
      this.clearPendingLocal(pendingKey);
      redisService.deletePendingPlayer(pendingKey).catch(console.error);
    }

    // Clean up computer game if this player had one
    const computerGame = this.computerGamesBySocket.get(socket);
    if (computerGame) {
      computerGame.cleanup();
      this.computerGamesBySocket.delete(socket);
    }

    if (!playerId) return;

    // Notify the game (local or remote) that this player disconnected, so it
    // can start the reconnect countdown instead of dying immediately.
    const localGame = this.gameBySocket.get(socket);
    if (localGame) {
      localGame.opponentDisconnected(playerId);
      return;
    }
    const remoteGameId = this.remoteGameByPlayerId.get(playerId);
    if (remoteGameId) {
      redisService
        .publishGameCommand({ gameId: remoteGameId, playerId, type: "DISCONNECT" })
        .catch(console.error);
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

  /** Track a playerId <-> socket link in both directions (local instance only). */
  private linkPlayerSocket(playerId: string, socket: WebSocket) {
    this.playerSockets.set(playerId, socket);
    this.socketToPlayerId.set(socket, playerId);
  }

  /**
   * Point a game's playerId at the local socket that currently represents it
   * (used both at creation and on reconnect-to-the-owner-instance). Replaces
   * any previous local socket registered for that playerId/game.
   */
  private setLocalGameSocket(gameId: string, playerId: string, socket: WebSocket, game: Game) {
    let bySlot = this.socketsForGame.get(gameId);
    if (!bySlot) {
      bySlot = new Map();
      this.socketsForGame.set(gameId, bySlot);
    }
    const prev = bySlot.get(playerId);
    if (prev) this.gameBySocket.delete(prev);
    bySlot.set(playerId, socket);
    this.gameBySocket.set(socket, game);
    this.remoteGameByPlayerId.delete(playerId); // we own it locally now
  }

  /** Register a freshly created/rebuilt game that THIS instance owns. */
  private registerGame(
    game: Game,
    locals: { player1Socket?: WebSocket; player2Socket?: WebSocket }
  ) {
    this.gamesById.set(game.gameId, game);
    if (locals.player1Socket) {
      this.setLocalGameSocket(game.gameId, game.player1Id, locals.player1Socket, game);
    }
    if (locals.player2Socket) {
      this.setLocalGameSocket(game.gameId, game.player2Id, locals.player2Socket, game);
    }

    game.onGameEnd = (gameId) => {
      this.gamesById.delete(gameId);
      const bySlot = this.socketsForGame.get(gameId);
      if (bySlot) {
        for (const s of bySlot.values()) this.gameBySocket.delete(s);
        this.socketsForGame.delete(gameId);
      }
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
        await this.handleInitGame(socket, message, dbUserId);
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
        const playerId = this.socketToPlayerId.get(socket);
        if (game && playerId) {
          game.makeMove(playerId, message.payload.move);
          return;
        }
        const cg = this.computerGamesBySocket.get(socket);
        if (cg) {
          cg.makeMove(socket, message.payload.move);
          return;
        }
        if (playerId) {
          const remoteGameId = this.remoteGameByPlayerId.get(playerId);
          if (remoteGameId) {
            redisService
              .publishGameCommand({
                gameId: remoteGameId,
                playerId,
                type: "MOVE",
                payload: { move: message.payload.move },
              })
              .catch(console.error);
          }
        }
        return;
      }

      // ── GET_VALID_MOVES ───────────────────────────────────────────────────
      if (message.type === GET_VALID_MOVES) {
        const game = this.gameBySocket.get(socket);
        const playerId = this.socketToPlayerId.get(socket);
        if (game && playerId) {
          game.getValidMoves(playerId, message.payload.square);
          return;
        }
        const cg = this.computerGamesBySocket.get(socket);
        if (cg) {
          cg.getValidMoves(socket, message.payload.square);
          return;
        }
        if (playerId) {
          const remoteGameId = this.remoteGameByPlayerId.get(playerId);
          if (remoteGameId) {
            redisService
              .publishGameCommand({
                gameId: remoteGameId,
                playerId,
                type: "GET_VALID_MOVES",
                payload: { square: message.payload.square },
              })
              .catch(console.error);
          }
        }
        return;
      }
    });
  }

  private async handleInitGame(socket: WebSocket, message: any, dbUserId: number | null) {
    let timeControl: number | null = null;
    if (message.payload?.timeControl !== undefined && message.payload.timeControl !== null) {
      timeControl = message.payload.timeControl;
    }

    const timeControlKey = timeControl === null ? "unlimited" : timeControl.toString();

    console.log(`Player (dbUserId=${dbUserId}) requesting game, timeControl:`, timeControl);

    let matchedPlayerId: string | null = null;
    let matchedDbUserId: number | null = null;
    let matchedLocalSocket: WebSocket | undefined;

    const localPending = this.pendingUsers.get(timeControlKey);
    if (localPending && localPending.socket !== socket) {
      // Both players are on this instance — resolve without touching Redis.
      this.clearPendingLocal(timeControlKey);
      redisService.deletePendingPlayer(timeControlKey).catch(console.error);
      matchedPlayerId = localPending.playerId;
      matchedDbUserId = localPending.dbUserId;
      matchedLocalSocket = localPending.socket;
    } else {
      // Ask Redis — this is how we discover a player waiting on a *different*
      // instance. Atomic GETDEL: exactly one instance can win this match.
      const redisPending = await redisService.consumePendingPlayer(timeControlKey);
      if (redisPending && redisPending.playerId !== this.socketToPlayerId.get(socket)) {
        matchedPlayerId = redisPending.playerId;
        matchedDbUserId = redisPending.dbUserId;
        matchedLocalSocket = this.playerSockets.get(redisPending.playerId); // defined only if they're ALSO local to this instance
      } else if (redisPending) {
        // We consumed our own pending entry — put it back, it wasn't a real match.
        await redisService.setPendingPlayer(timeControlKey, redisPending);
      }
    }

    if (matchedPlayerId) {
      console.log("Match found, creating game with timeControl:", timeControl);

      const player2Id = uuidv4();

      // Link identities BEFORE constructing the Game: its constructor sends
      // INIT_GAME immediately, and delivery (local or via chess:to-player)
      // depends on playerSockets already knowing which local socket owns
      // which playerId. Getting this order backwards is a real race, not
      // just a theoretical one — Redis pub/sub delivery (including an
      // instance receiving its own publish back) happens over the network,
      // so there's no guarantee it'd lose a race against a later, separate
      // await elsewhere in this function.
      if (matchedLocalSocket) {
        this.linkPlayerSocket(matchedPlayerId, matchedLocalSocket);
      }
      this.linkPlayerSocket(player2Id, socket);

      const game = new Game(matchedPlayerId, player2Id, matchedDbUserId, dbUserId, timeControl);

      await redisService.claimGameOwnership(game.gameId, this.instanceId, OWNERSHIP_TTL_SECONDS);
      this.registerGame(game, { player1Socket: matchedLocalSocket, player2Socket: socket });
    } else {
      console.log("No match, adding to pending queue");

      // A socket can only ever have one pending-queue entry at a time.
      const existingKey = this.pendingKeyBySocket.get(socket);
      if (existingKey) {
        this.clearPendingLocal(existingKey);
        await redisService.deletePendingPlayer(existingKey);
      }

      const playerId = message.payload?.playerId || this.generateId();
      this.setPendingLocal(timeControlKey, { socket, timeControl, playerId, dbUserId });
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

    this.linkPlayerSocket(playerId, socket);

    const liveGame = this.gamesById.get(persisted.gameId);

    if (liveGame) {
      // We already own this Game object locally — fully local, fast path.
      this.setLocalGameSocket(persisted.gameId, playerId, socket, liveGame);
      liveGame.opponentReconnected(playerId);

      const basePayload = {
        fen: liveGame.board.fen(),
        moveCount: liveGame.moveNumber,
        whiteTime:
          liveGame.player1TimeRemaining !== null ? Math.max(0, liveGame.player1TimeRemaining) : null,
        blackTime:
          liveGame.player2TimeRemaining !== null ? Math.max(0, liveGame.player2TimeRemaining) : null,
        timeControl: persisted.timeControl,
        yourColor: isPlayer1 ? "white" : "black",
      };
      socket.send(JSON.stringify({ type: GAME_STATE, payload: basePayload }));
      console.log("Player reconnected to live game (local):", persisted.gameId);
      return;
    }

    // Not owned locally. The `game_owner:{gameId}` claim (SET NX, refreshed
    // periodically by whoever holds it — see the constructor's interval and
    // handleInitGame) is the single source of truth for "is a live owner
    // still out there," so try to claim it ourselves rather than relying on
    // a second, separately-racy signal like player presence:
    //
    //  - Claim succeeds  → nobody's actively holding it (either this is the
    //    first reconnect after the owner crashed and its claim's TTL has
    //    lapsed, or — vanishingly likely — the claim key was never set).
    //    We become the new owner and rebuild from the last snapshot.
    //  - Claim fails     → someone else holds it (still the healthy original
    //    owner, or another instance that won this same race a moment ago).
    //    Defer to them via the command channel instead of duplicating.
    const claimed = await redisService.claimGameOwnership(
      persisted.gameId,
      this.instanceId,
      OWNERSHIP_TTL_SECONDS
    );

    if (!claimed) {
      this.remoteGameByPlayerId.set(playerId, persisted.gameId);
      redisService
        .publishGameCommand({ gameId: persisted.gameId, playerId, type: "RECONNECT" })
        .catch(console.error);

      const basePayload = {
        fen: persisted.fen,
        moveCount: persisted.moveCount,
        whiteTime: persisted.player1Time !== null ? Math.max(0, persisted.player1Time) : null,
        blackTime: persisted.player2Time !== null ? Math.max(0, persisted.player2Time) : null,
        timeControl: persisted.timeControl,
        yourColor: isPlayer1 ? "white" : "black",
      };
      socket.send(JSON.stringify({ type: GAME_STATE, payload: basePayload }));
      console.log("Game owned elsewhere (or by a concurrent claimant); deferring:", persisted.gameId);
      return;
    }

    const game = new Game(
      persisted.player1Id,
      persisted.player2Id,
      persisted.player1DbUserId,
      persisted.player2DbUserId,
      persisted.timeControl,
      {
        gameId: persisted.gameId,
        moveHistory: persisted.moveHistory,
        moveCount: persisted.moveCount,
        player1Time: persisted.player1Time,
        player2Time: persisted.player2Time,
      }
    );
    this.registerGame(game, isPlayer1 ? { player1Socket: socket } : { player2Socket: socket });

    console.log("Game rebuilt on this instance for gameId:", persisted.gameId);
  }

  private generateId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
