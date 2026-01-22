import { WebSocket } from "ws";
import { INIT_GAME, MOVE, GET_VALID_MOVES } from "./messages";
import { Game } from "./Game";

export class GameManager {
    private games: Game[];
    private pendingUser: WebSocket | null;
    private pendingUserTimeControl: number | null;
    private users: WebSocket[];

    constructor() {
        this.games = [];
        this.pendingUser = null;
        this.pendingUserTimeControl = null;
        this.users = [];
    }

    addUser(socket: WebSocket) {
        this.users.push(socket);
        this.addHandler(socket);
    }

    removeUser(socket: WebSocket) {
        this.users = this.users.filter(user => user !== socket);
        
        // If the pending user disconnects, clear them
        if (this.pendingUser === socket) {
            this.pendingUser = null;
            this.pendingUserTimeControl = null;
        }
        
        // Find and cleanup any game this user was in
        const game = this.games.find(game => game.player1 === socket || game.player2 === socket);
        if (game) {
            game.cleanup();
            // Notify the other player
            const otherPlayer = game.player1 === socket ? game.player2 : game.player1;
            otherPlayer.send(JSON.stringify({
                type: "GAME_OVER",
                payload: {
                    winner: game.player1 === socket ? "black" : "white",
                    reason: "opponent_disconnected"
                }
            }));
            // Remove the game
            this.games = this.games.filter(g => g !== game);
        }
    }

    private addHandler(socket: WebSocket) {
        socket.on("message", (data) => {
            const message = JSON.parse(data.toString());

            if (message.type === INIT_GAME) {
                // Get time control from message payload
                // If timeControl is explicitly null or undefined, use null (no time limit)
                // Otherwise use the provided value or default to 10
                let timeControl: number | null = null;
                if (message.payload && message.payload.timeControl !== undefined && message.payload.timeControl !== null) {
                    timeControl = message.payload.timeControl;
                } else if (!message.payload || message.payload.timeControl === undefined) {
                    // Default to 10 minutes if no payload provided at all
                    timeControl = 10;
                }
                
                console.log("Player requesting game with time control:", timeControl);
                
                if (this.pendingUser) {
                    // Create game with the requested time control (use the first player's preference)
                    const pendingTimeControl = this.pendingUserTimeControl;
                    console.log("Creating game with time control:", pendingTimeControl);
                    
                    const game = new Game(this.pendingUser, socket, pendingTimeControl);
                    this.games.push(game);
                    this.pendingUser = null;
                    this.pendingUserTimeControl = null;
                } else {
                    this.pendingUser = socket;
                    this.pendingUserTimeControl = timeControl;
                    
                    // Optionally send a waiting message
                    socket.send(JSON.stringify({
                        type: "WAITING",
                        payload: {
                            message: "Waiting for opponent...",
                            timeControl: timeControl
                        }
                    }));
                }
            }

            if (message.type === MOVE) {
                console.log("inside move");
                const game = this.games.find(game => game.player1 === socket || game.player2 === socket);
                if (game) {
                    console.log("inside makemove");
                    game.makeMove(socket, message.payload.move);
                }
            }

            if (message.type === GET_VALID_MOVES) {
                const game = this.games.find(game => game.player1 === socket || game.player2 === socket);
                if (game) {
                    game.getValidMoves(socket, message.payload.square);
                }
            }
        });
    }
}