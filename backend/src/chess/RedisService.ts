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

class RedisService {
  private client: RedisClientType | null = null;
  private ready = false;
  private readyCallbacks: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor() {
    const host = process.env.REDIS_HOST;
    if (!host) {
      console.warn("REDIS_HOST not set — Redis disabled. Matchmaking will use in-memory only.");
      return;
    }

    this.client = createClient({
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      socket: {
        host,
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
      },
    }) as RedisClientType;

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

    this.client.connect().catch((err) =>
      console.error("Redis initial connect failed:", err)
    );
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
      await pipeline.exec();
    } catch (err) {
      console.error("Redis deleteGame failed (non-fatal):", err);
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
}

export const redisService = new RedisService();
