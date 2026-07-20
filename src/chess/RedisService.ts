import { createClient, RedisClientType } from "redis";
import * as dotenv from "dotenv";
dotenv.config();

const GAME_TTL = 60 * 60 * 24; // 24 hours in seconds

export interface PersistedGame {
  gameId: string;
  player1Id: string;
  player2Id: string;
  player1DbUserId: number | null;
  player2DbUserId: number | null;
  fen: string;
  moveHistory: { from: string; to: string; promotion?: string }[];
  moveCount: number;
  timeControl: number | null;
  player1Time: number | null;
  player2Time: number | null;
  lastMoveTimestamp: number;
  status: "active" | "over";
  winner: string | null;
  reason: string | null;
}

export interface PendingPlayerData {
  playerId: string;
  dbUserId: number | null;
  timeControl: number | null;
  timestamp: number;
}

// ── Cross-instance messaging ────────────────────────────────────────────────
// These channels are what make horizontal scaling possible: any server
// instance can hold either half of a game's two WebSocket connections, since
// state lives in Redis and messages are relayed through pub/sub rather than
// requiring both sockets to live in the same process.
const CHANNEL_TO_PLAYER = "chess:to-player";
const CHANNEL_GAME_COMMAND = "chess:game-command";

/** Envelope published on CHANNEL_TO_PLAYER: deliver `message` to `playerId`. */
export interface ToPlayerEnvelope {
  playerId: string;
  gameId: string;
  message: unknown;
}

/**
 * Envelope published on CHANNEL_GAME_COMMAND: a client action that arrived on
 * an instance which doesn't own the Game object locally, forwarded to
 * whichever instance does (every instance subscribes; only the owner acts).
 */
export interface GameCommandEnvelope {
  gameId: string;
  playerId: string;
  type: "MOVE" | "GET_VALID_MOVES" | "DISCONNECT" | "RECONNECT";
  payload?: any;
}

class RedisService {
  private client: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;
  private subscriberConnect: Promise<unknown> | null = null;
  private ready = false;
  private readyCallbacks: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor() {
    const host = process.env.REDIS_HOST;
    if (!host) {
      console.warn(
        "REDIS_HOST not set — Redis disabled. Matchmaking, reconnection, and " +
        "cross-instance game routing all require Redis; without it this " +
        "process can only run as a single, non-horizontally-scaled instance."
      );
      return;
    }

    const socketOpts = {
      host,
      port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
      reconnectStrategy: (retries: number) => Math.min(retries * 100, 3000),
    };

    const redisConfig: any = {
      socket: socketOpts,
    };
    if (process.env.REDIS_PASSWORD) {
      redisConfig.password = process.env.REDIS_PASSWORD;
      if (process.env.REDIS_USERNAME) {
        redisConfig.username = process.env.REDIS_USERNAME;
      }
    }

    this.client = createClient(redisConfig) as RedisClientType;

    // Pub/sub requires a dedicated connection in node-redis — a client in
    // subscribe mode can't also run normal commands. `duplicate()` shares the
    // same connection options.
    this.subscriber = this.client.duplicate() as RedisClientType;

    this.client.on("error", (err) => console.error("Redis Client Error:", err));
    this.client.on("connect", () => {
      console.log("Redis connected");
      this.ready = true;
      this.readyCallbacks.forEach(({ resolve, timer }) => { clearTimeout(timer); resolve(); });
      this.readyCallbacks = [];
    });
    this.client.on("end", () => {
      console.log("Redis connection closed");
      this.ready = false;
    });
    this.client.on("reconnecting", () => console.log("Redis reconnecting..."));

    this.subscriber.on("error", (err) => console.error("Redis subscriber error:", err));

    this.client.connect().catch((err) =>
      console.error("Redis initial connect failed:", err)
    );
    this.subscriberConnect = this.subscriber.connect().catch((err) => {
      console.error("Redis subscriber connect failed:", err);
      throw err;
    });
  }

  get isAvailable(): boolean {
    return this.ready && this.client !== null;
  }

  private waitReady(): Promise<void> {
    if (this.client === null) return Promise.reject(new Error("Redis not configured"));
    if (this.ready) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Redis not ready: connection timeout"));
      }, 5000);
      this.readyCallbacks.push({ resolve, reject, timer });
    });
  }

  // ── Game persistence ───────────────────────────────────────────────────────

  async saveGame(game: PersistedGame): Promise<void> {
    try {
      await this.waitReady();
      const serialized = JSON.stringify(game);
      const pipeline = this.client!.multi();
      pipeline.set(`game:${game.gameId}`, serialized, { EX: GAME_TTL });
      pipeline.set(`player_game:${game.player1Id}`, game.gameId, { EX: GAME_TTL });
      pipeline.set(`player_game:${game.player2Id}`, game.gameId, { EX: GAME_TTL });
      await pipeline.exec();
    } catch (err) {
      console.error("Redis saveGame failed (non-fatal):", err);
    }
  }

  async getGame(gameId: string): Promise<PersistedGame | null> {
    try {
      await this.waitReady();
      const data = await this.client!.get(`game:${gameId}`);
      return data ? (JSON.parse(data) as PersistedGame) : null;
    } catch {
      return null;
    }
  }

  async getGameByPlayerId(playerId: string): Promise<PersistedGame | null> {
    try {
      await this.waitReady();
      const gameId = await this.client!.get(`player_game:${playerId}`);
      if (!gameId) return null;
      return this.getGame(gameId);
    } catch {
      return null;
    }
  }

  async deleteGame(gameId: string, player1Id: string, player2Id: string): Promise<void> {
    try {
      await this.waitReady();
      const pipeline = this.client!.multi();
      pipeline.del(`game:${gameId}`);
      pipeline.del(`player_game:${player1Id}`);
      pipeline.del(`player_game:${player2Id}`);
      pipeline.del(`game_owner:${gameId}`);
      await pipeline.exec();
    } catch (err) {
      console.error("Redis deleteGame failed (non-fatal):", err);
    }
  }

  // ── Game ownership (crash-recovery mutex) ───────────────────────────────────
  // Not needed for routing (pub/sub broadcast + local-map filtering handles
  // that regardless of which instance owns what). This exists only to stop
  // two instances from both resurrecting the *same* gameId into two
  // independent, competing Game objects if both players happen to reconnect
  // at the same moment right after the original owner instance crashed.

  /** Atomically claim ownership of gameId. False if another instance already holds it. */
  async claimGameOwnership(gameId: string, instanceId: string, ttlSeconds: number): Promise<boolean> {
    try {
      await this.waitReady();
      const res = await this.client!.set(`game_owner:${gameId}`, instanceId, {
        NX: true,
        EX: ttlSeconds,
      });
      return res === "OK";
    } catch (err) {
      console.error("Redis claimGameOwnership failed (failing closed):", err);
      return false; // don't risk a duplicate owner if we can't confirm exclusivity
    }
  }

  /** Slide the TTL forward on a claim this instance already holds, so a live owner never expires out. */
  async refreshGameOwnership(gameId: string, instanceId: string, ttlSeconds: number): Promise<void> {
    try {
      await this.waitReady();
      await this.client!.set(`game_owner:${gameId}`, instanceId, { EX: ttlSeconds });
    } catch (err) {
      console.error("Redis refreshGameOwnership failed (non-fatal):", err);
    }
  }

  // ── Pending players ────────────────────────────────────────────────────────

  async setPendingPlayer(timeControlKey: string, data: PendingPlayerData): Promise<void> {
    try {
      await this.waitReady();
      await this.client!.set(`pending:${timeControlKey}`, JSON.stringify(data), { EX: 300 });
    } catch (err) {
      console.error("Redis setPendingPlayer failed (non-fatal):", err);
    }
  }

  async getPendingPlayer(timeControlKey: string): Promise<PendingPlayerData | null> {
    try {
      await this.waitReady();
      const data = await this.client!.get(`pending:${timeControlKey}`);
      return data ? (JSON.parse(data) as PendingPlayerData) : null;
    } catch {
      return null;
    }
  }

  async deletePendingPlayer(timeControlKey: string): Promise<void> {
    try {
      await this.waitReady();
      await this.client!.del(`pending:${timeControlKey}`);
    } catch (err) {
      console.error("Redis deletePendingPlayer failed (non-fatal):", err);
    }
  }

  /**
   * Atomically read-and-remove a pending player entry (GETDEL). Two instances
   * racing to match the same waiting player must not both succeed — without
   * this, a plain GET-then-DEL (what this replaces) lets both instances see
   * the same pending player and each create a separate game with them,
   * double-booking that player. Returns null if nobody was waiting (or on
   * Redis errors — callers already treat null as "no match", so failing
   * closed here is safe).
   */
  async consumePendingPlayer(timeControlKey: string): Promise<PendingPlayerData | null> {
    try {
      await this.waitReady();
      const data = await this.client!.getDel(`pending:${timeControlKey}`);
      return data ? (JSON.parse(data) as PendingPlayerData) : null;
    } catch (err) {
      console.error("Redis consumePendingPlayer failed (treating as no match):", err);
      return null;
    }
  }

  // ── Cross-instance pub/sub ──────────────────────────────────────────────────

  /** Deliver `message` to whichever instance (if any) holds playerId's live socket. */
  async publishToPlayer(playerId: string, gameId: string, message: unknown): Promise<void> {
    if (!this.client) return; // no Redis = single instance, nothing to relay
    try {
      const envelope: ToPlayerEnvelope = { playerId, gameId, message };
      await this.client.publish(CHANNEL_TO_PLAYER, JSON.stringify(envelope));
    } catch (err) {
      console.error("Redis publishToPlayer failed (non-fatal):", err);
    }
  }

  /** Forward a client command (move, disconnect, etc.) to whichever instance owns the Game object. */
  async publishGameCommand(envelope: GameCommandEnvelope): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.publish(CHANNEL_GAME_COMMAND, JSON.stringify(envelope));
    } catch (err) {
      console.error("Redis publishGameCommand failed (non-fatal):", err);
    }
  }

  /** Subscribe once for the lifetime of the process. Safe to call multiple times (no-ops after the first). */
  private subscribedToPlayerMsgs = false;
  async onPlayerMessage(handler: (envelope: ToPlayerEnvelope) => void): Promise<void> {
    if (!this.subscriber || this.subscribedToPlayerMsgs) return;
    this.subscribedToPlayerMsgs = true;
    try {
      await this.subscriberConnect;
      await this.subscriber.subscribe(CHANNEL_TO_PLAYER, (raw) => {
        try {
          handler(JSON.parse(raw) as ToPlayerEnvelope);
        } catch (err) {
          console.error("Bad chess:to-player payload:", err);
        }
      });
    } catch (err) {
      console.error("Failed to subscribe to chess:to-player:", err);
      this.subscribedToPlayerMsgs = false;
    }
  }

  private subscribedToGameCommands = false;
  async onGameCommand(handler: (envelope: GameCommandEnvelope) => void): Promise<void> {
    if (!this.subscriber || this.subscribedToGameCommands) return;
    this.subscribedToGameCommands = true;
    try {
      await this.subscriberConnect;
      await this.subscriber.subscribe(CHANNEL_GAME_COMMAND, (raw) => {
        try {
          handler(JSON.parse(raw) as GameCommandEnvelope);
        } catch (err) {
          console.error("Bad chess:game-command payload:", err);
        }
      });
    } catch (err) {
      console.error("Failed to subscribe to chess:game-command:", err);
      this.subscribedToGameCommands = false;
    }
  }
}

export const redisService = new RedisService();
