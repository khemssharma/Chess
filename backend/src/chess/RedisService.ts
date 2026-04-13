import { createClient, RedisClientType } from "redis";
import * as dotenv from "dotenv";
dotenv.config();

const GAME_TTL = 60 * 60 * 24; // 24 hours in seconds

export interface PersistedGame {
  gameId: string;
  player1Id: string;
  player2Id: string;
  // Track which DB user owns each side (null = guest/anonymous)
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

class RedisService {
  private client: RedisClientType;
  private ready = false;
  // Queue of callbacks waiting for the client to be ready
  private readyCallbacks: Array<() => void> = [];

  constructor() {
    this.client = createClient({
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      socket: {
        host: process.env.REDIS_HOST || "localhost",
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
        // Reconnect automatically on dropped connections
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
      },
    }) as RedisClientType;

    this.client.on("error", (err) => console.error("Redis Client Error:", err));
    this.client.on("connect", () => {
      console.log("Redis connected");
      this.ready = true;
      // Flush any callbacks that were waiting for the connection
      this.readyCallbacks.forEach((cb) => cb());
      this.readyCallbacks = [];
    });
    this.client.on("end", () => {
      console.log("Redis connection closed");
      this.ready = false;
    });
    this.client.on("reconnecting", () => {
      console.log("Redis reconnecting...");
    });

    this.client.connect().catch((err) =>
      console.error("Redis initial connect failed:", err)
    );
  }

  /**
   * Returns a promise that resolves once the Redis client is connected.
   * If already connected, resolves immediately.
   * If not connected within 5 s, rejects so callers can handle gracefully.
   */
  private waitReady(): Promise<void> {
    if (this.ready) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Redis not ready: connection timeout"));
      }, 5000);

      this.readyCallbacks.push(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  // ── Game persistence ───────────────────────────────────────────────────────

  async saveGame(game: PersistedGame): Promise<void> {
    await this.waitReady();
    const serialized = JSON.stringify(game);
    // Use a pipeline so all three writes go in one round-trip
    const pipeline = this.client.multi();
    pipeline.set(`game:${game.gameId}`, serialized, { EX: GAME_TTL });
    pipeline.set(`player_game:${game.player1Id}`, game.gameId, { EX: GAME_TTL });
    pipeline.set(`player_game:${game.player2Id}`, game.gameId, { EX: GAME_TTL });
    await pipeline.exec();
  }

  async getGame(gameId: string): Promise<PersistedGame | null> {
    await this.waitReady();
    const data = await this.client.get(`game:${gameId}`);
    return data ? (JSON.parse(data) as PersistedGame) : null;
  }

  async getGameByPlayerId(playerId: string): Promise<PersistedGame | null> {
    await this.waitReady();
    const gameId = await this.client.get(`player_game:${playerId}`);
    if (!gameId) return null;
    return this.getGame(gameId);
  }

  async deleteGame(
    gameId: string,
    player1Id: string,
    player2Id: string
  ): Promise<void> {
    await this.waitReady();
    const pipeline = this.client.multi();
    pipeline.del(`game:${gameId}`);
    pipeline.del(`player_game:${player1Id}`);
    pipeline.del(`player_game:${player2Id}`);
    await pipeline.exec();
  }

  // ── Pending players ────────────────────────────────────────────────────────

  async setPendingPlayer(
    timeControlKey: string,
    data: PendingPlayerData
  ): Promise<void> {
    await this.waitReady();
    await this.client.set(
      `pending:${timeControlKey}`,
      JSON.stringify(data),
      { EX: 300 }
    );
  }

  async getPendingPlayer(
    timeControlKey: string
  ): Promise<PendingPlayerData | null> {
    await this.waitReady();
    const data = await this.client.get(`pending:${timeControlKey}`);
    return data ? (JSON.parse(data) as PendingPlayerData) : null;
  }

  async deletePendingPlayer(timeControlKey: string): Promise<void> {
    await this.waitReady();
    await this.client.del(`pending:${timeControlKey}`);
  }
}

export const redisService = new RedisService();
