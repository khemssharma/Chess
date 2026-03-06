import { WebSocket } from "ws";
import { Chess } from "chess.js";
import { GAME_OVER, INIT_GAME, MOVE, VALID_MOVES, TIME_UPDATE, GAME_STATE } from "./messages";
import { redisService, PersistedGame } from "./RedisService";
import { v4 as uuidv4 } from "uuid";

export class Game {
    public player1: WebSocket;
    public player2: WebSocket;
    public board: Chess;
    private startTime: Date;
    private moveCount = 0;

    // Persistent identity
    public gameId: string;
    public player1Id: string;
    public player2Id: string;

    // Time control
    private timeControl: number | null;
    private player1Time: number | null;
    private player2Time: number | null;
    private lastMoveTime: number;
    private timeUpdateInterval: NodeJS.Timeout | null = null;

    constructor(
        player1: WebSocket,
        player2: WebSocket,
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
        this.board = new Chess();
        this.startTime = new Date();

        if (restored) {
            // ── Reconnection path ──────────────────────────────────────────
            this.gameId = restored.gameId;
            this.player1Id = restored.player1Id;
            this.player2Id = restored.player2Id;
            this.moveCount = restored.moveCount;

            for (const move of restored.moveHistory) {
                this.board.move(move);
            }

            this.timeControl = timeControlMinutes !== null ? timeControlMinutes * 60 * 1000 : null;
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
            // ── Fresh game path ────────────────────────────────────────────
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

            player1.send(JSON.stringify({
                type: INIT_GAME,
                payload: {
                    color: "white",
                    timeControl: timeControlMinutes,
                    playerId: this.player1Id,
                    gameId: this.gameId,
                },
            }));
            player2.send(JSON.stringify({
                type: INIT_GAME,
                payload: {
                    color: "black",
                    timeControl: timeControlMinutes,
                    playerId: this.player2Id,
                    gameId: this.gameId,
                },
            }));

            this.persistToRedis();
        }
    }

    private buildSnapshot(status: "active" | "over" = "active", winner: string | null = null, reason: string | null = null): PersistedGame {
        return {
            gameId: this.gameId,
            player1Id: this.player1Id,
            player2Id: this.player2Id,
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

    private persistToRedis(status: "active" | "over" = "active", winner: string | null = null, reason: string | null = null) {
        redisService.saveGame(this.buildSnapshot(status, winner, reason)).catch(console.error);
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

        const gameOverMessage = { type: GAME_OVER, payload: { winner, reason: "timeout" } };
        this.player1.send(JSON.stringify(gameOverMessage));
        this.player2.send(JSON.stringify(gameOverMessage));

        this.persistToRedis("over", winner, "timeout");
        redisService.deleteGame(this.gameId, this.player1Id, this.player2Id).catch(console.error);
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

            const gameOverMsg = JSON.stringify({
                type: GAME_OVER,
                payload: { winner: this.board.isDraw() ? null : winner, reason },
            });
            this.player1.send(gameOverMsg);
            this.player2.send(gameOverMsg);

            this.persistToRedis("over", this.board.isDraw() ? null : winner, reason);
            redisService.deleteGame(this.gameId, this.player1Id, this.player2Id).catch(console.error);
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

        // Persist after every move
        this.persistToRedis();
    }

    getValidMoves(socket: WebSocket, square: string) {
        const isPlayer1Turn = this.moveCount % 2 === 0;
        if (isPlayer1Turn && socket !== this.player1) {
            socket.send(JSON.stringify({ type: VALID_MOVES, payload: { square, moves: [] } }));
            return;
        }
        if (!isPlayer1Turn && socket !== this.player2) {
            socket.send(JSON.stringify({ type: VALID_MOVES, payload: { square, moves: [] } }));
            return;
        }

        const moves = this.board.moves({ square: square as any, verbose: true });
        socket.send(JSON.stringify({
            type: VALID_MOVES,
            payload: {
                square,
                moves: moves.map((m: any) => ({ from: m.from, to: m.to, promotion: m.promotion })),
            },
        }));
    }

    cleanup() {
        if (this.timeUpdateInterval) {
            clearInterval(this.timeUpdateInterval);
            this.timeUpdateInterval = null;
        }
    }
}