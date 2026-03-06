
import { createClient, RedisClientType } from 'redis';
import * as dotenv from 'dotenv';
dotenv.config();

const GAME_TTL = 60 * 60 * 24; // 24 hours in seconds

export interface PersistedGame {
    gameId: string;
    player1Id: string;
    player2Id: string;
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
    timeControl: number | null;
    timestamp: number;
}

class RedisService {
    private client: RedisClientType;
    private ready = false;

    constructor() {
        this.client = createClient({
            username: process.env.REDIS_USERNAME,
            password: process.env.REDIS_PASSWORD,
            socket: {
                host: process.env.REDIS_HOST,
                port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379
            }
        }) as RedisClientType;

        this.client.on('error', err => console.log('Redis Client Error', err));
        this.client.on('connect', () => {
            console.log('Redis connected');
            this.ready = true;
        });
        this.client.on('end', () => {
            this.ready = false;
        });

        this.client.connect().catch(console.error);
    }

    // ── Game persistence ──────────────────────────────────────────────────────

    async saveGame(game: PersistedGame): Promise<void> {
        await this.client.set(`game:${game.gameId}`, JSON.stringify(game), { EX: GAME_TTL });
        await this.client.set(`player_game:${game.player1Id}`, game.gameId, { EX: GAME_TTL });
        await this.client.set(`player_game:${game.player2Id}`, game.gameId, { EX: GAME_TTL });
    }

    async getGame(gameId: string): Promise<PersistedGame | null> {
        const data = await this.client.get(`game:${gameId}`);
        return data ? (JSON.parse(data) as PersistedGame) : null;
    }

    async getGameByPlayerId(playerId: string): Promise<PersistedGame | null> {
        const gameId = await this.client.get(`player_game:${playerId}`);
        if (!gameId) return null;
        return this.getGame(gameId);
    }

    async deleteGame(gameId: string, player1Id: string, player2Id: string): Promise<void> {
        await this.client.del(`game:${gameId}`);
        await this.client.del(`player_game:${player1Id}`);
        await this.client.del(`player_game:${player2Id}`);
    }

    // ── Pending players ───────────────────────────────────────────────────────

    async setPendingPlayer(timeControlKey: string, data: PendingPlayerData): Promise<void> {
        await this.client.set(`pending:${timeControlKey}`, JSON.stringify(data), { EX: 300 });
    }

    async getPendingPlayer(timeControlKey: string): Promise<PendingPlayerData | null> {
        const data = await this.client.get(`pending:${timeControlKey}`);
        return data ? (JSON.parse(data) as PendingPlayerData) : null;
    }

    async deletePendingPlayer(timeControlKey: string): Promise<void> {
        await this.client.del(`pending:${timeControlKey}`);
    }

    async clearPendingByPlayerId(playerId: string): Promise<void> {
        const keys = await this.client.keys('pending:*');
        for (const key of keys) {
            const data = await this.client.get(key);
            if (data) {
                const parsed: PendingPlayerData = JSON.parse(data);
                if (parsed.playerId === playerId) {
                    await this.client.del(key);
                }
            }
        }
    }
}

export const redisService = new RedisService();