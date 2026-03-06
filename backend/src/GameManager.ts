import { WebSocket } from "ws";
import { INIT_GAME, MOVE, GET_VALID_MOVES, RECONNECT } from "./messages";
import { Game } from "./Game";
import { redisService } from "./RedisService";

interface PendingPlayer {
    socket: WebSocket;
    timeControl: number | null;
    playerId: string;
}

export class GameManager {
    private games: Game[];
    private pendingUsers: Map<string, PendingPlayer>; // key = timeControl string
    private users: WebSocket[];

    // Map playerId → socket for reconnection routing
    private playerSockets: Map<string, WebSocket> = new Map();

    constructor() {
        this.games = [];
        this.pendingUsers = new Map();
        this.users = [];
    }

    addUser(socket: WebSocket) {
        this.users.push(socket);
        this.addHandler(socket);
    }

    removeUser(socket: WebSocket) {
        this.users = this.users.filter(u => u !== socket);

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

        // Notify opponent if in an active game (game state remains in Redis)
        const game = this.games.find(g => g.player1 === socket || g.player2 === socket);
        if (game) {
            game.cleanup();
            const otherPlayer = game.player1 === socket ? game.player2 : game.player1;
            otherPlayer.send(JSON.stringify({
                type: "OPPONENT_DISCONNECTED",
                payload: { message: "Opponent disconnected. They can rejoin to continue." }
            }));
            // Keep the game in Redis; remove it from the in-memory list so a
            // reconnecting player triggers a fresh Game instance.
            this.games = this.games.filter(g => g !== game);
        }
    }

    private addHandler(socket: WebSocket) {
        socket.on("message", async (data) => {
            let message: any;
            try {
                message = JSON.parse(data.toString());
            } catch {
                console.error("Invalid JSON from client");
                return;
            }

            // ── RECONNECT ──────────────────────────────────────────────────
            if (message.type === RECONNECT) {
                await this.handleReconnect(socket, message.payload?.playerId);
                return;
            }

            // ── INIT_GAME ──────────────────────────────────────────────────
            if (message.type === INIT_GAME) {
                let timeControl: number | null = null;
                if (message.payload?.timeControl !== undefined && message.payload.timeControl !== null) {
                    timeControl = message.payload.timeControl;
                }

                const timeControlKey = timeControl === null ? "unlimited" : timeControl.toString();

                console.log("Player requesting game, timeControl:", timeControl);

                // Check Redis for a pending player with matching time control
                let pendingPlayer = this.pendingUsers.get(timeControlKey);

                if (!pendingPlayer) {
                    // Fall back to Redis (handles server restarts)
                    const redisPending = await redisService.getPendingPlayer(timeControlKey);
                    if (redisPending) {
                        // The pending player's socket might still be in-memory
                        const pendingSocket = this.playerSockets.get(redisPending.playerId);
                        if (pendingSocket && pendingSocket !== socket) {
                            pendingPlayer = { socket: pendingSocket, timeControl, playerId: redisPending.playerId };
                        } else if (!pendingSocket) {
                            // Stale Redis entry, clean it up
                            await redisService.deletePendingPlayer(timeControlKey);
                        }
                    }
                }

                if (pendingPlayer && pendingPlayer.socket !== socket) {
                    console.log("Match found, creating game with timeControl:", timeControl);

                    this.pendingUsers.delete(timeControlKey);
                    await redisService.deletePendingPlayer(timeControlKey);

                    const game = new Game(pendingPlayer.socket, socket, timeControl);
                    this.games.push(game);

                    // Index the sockets by their new player IDs
                    this.playerSockets.set(game.player1Id, pendingPlayer.socket);
                    this.playerSockets.set(game.player2Id, socket);
                } else {
                    console.log("No match, adding to pending queue, timeControl:", timeControl);

                    // Clear any previous pending entry for this socket
                    for (const [key, pending] of this.pendingUsers.entries()) {
                        if (pending.socket === socket) {
                            this.pendingUsers.delete(key);
                            await redisService.deletePendingPlayer(key);
                        }
                    }

                    const playerId = message.payload?.playerId || this.generateId();
                    this.pendingUsers.set(timeControlKey, { socket, timeControl, playerId });
                    this.playerSockets.set(playerId, socket);

                    await redisService.setPendingPlayer(timeControlKey, { playerId, timeControl, timestamp: Date.now() });

                    socket.send(JSON.stringify({
                        type: "WAITING",
                        payload: { message: "Waiting for opponent with same time control...", timeControl }
                    }));
                }
                return;
            }

            // ── MOVE ───────────────────────────────────────────────────────
            if (message.type === MOVE) {
                const game = this.games.find(g => g.player1 === socket || g.player2 === socket);
                if (game) {
                    game.makeMove(socket, message.payload.move);
                }
                return;
            }

            // ── GET_VALID_MOVES ────────────────────────────────────────────
            if (message.type === GET_VALID_MOVES) {
                const game = this.games.find(g => g.player1 === socket || g.player2 === socket);
                if (game) {
                    game.getValidMoves(socket, message.payload.square);
                }
                return;
            }
        });
    }

    private async handleReconnect(socket: WebSocket, playerId: string | undefined) {
        if (!playerId) {
            socket.send(JSON.stringify({ type: "ERROR", payload: { message: "No playerId provided for reconnect" } }));
            return;
        }

        console.log("Reconnect attempt for playerId:", playerId);

        const persisted = await redisService.getGameByPlayerId(playerId);
        if (!persisted || persisted.status !== "active") {
            socket.send(JSON.stringify({ type: "NO_GAME", payload: { message: "No active game found to resume." } }));
            return;
        }

        const isPlayer1 = persisted.player1Id === playerId;
        const otherPlayerId = isPlayer1 ? persisted.player2Id : persisted.player1Id;
        const otherSocket = this.playerSockets.get(otherPlayerId);

        // Update socket index
        this.playerSockets.set(playerId, socket);

        if (otherSocket && (otherSocket.readyState === WebSocket.OPEN)) {
            // Both players are now online — restore the game
            const player1Socket = isPlayer1 ? socket : otherSocket;
            const player2Socket = isPlayer1 ? otherSocket : socket;

            // Remove old in-memory game instance if any
            this.games = this.games.filter(g => g.gameId !== persisted.gameId);

            const game = new Game(player1Socket, player2Socket, persisted.timeControl, {
                gameId: persisted.gameId,
                player1Id: persisted.player1Id,
                player2Id: persisted.player2Id,
                moveHistory: persisted.moveHistory,
                moveCount: persisted.moveCount,
                player1Time: persisted.player1Time,
                player2Time: persisted.player2Time,
            });

            this.games.push(game);
            this.playerSockets.set(game.player1Id, player1Socket);
            this.playerSockets.set(game.player2Id, player2Socket);

            console.log("Game restored for gameId:", persisted.gameId);
        } else {
            // Opponent not yet connected — notify this player to wait
            socket.send(JSON.stringify({
                type: "WAITING_FOR_OPPONENT",
                payload: { message: "Reconnected. Waiting for your opponent to rejoin..." }
            }));
        }
    }

    private generateId(): string {
        return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
}