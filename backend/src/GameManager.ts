import { WebSocket } from "ws";
import { INIT_GAME, MOVE, GET_VALID_MOVES } from "./messages";
import { Game } from "./Game";

interface PendingPlayer {
    socket: WebSocket;
    timeControl: number | null;
}

export class GameManager {
    private games: Game[];
    private pendingUsers: Map<string, PendingPlayer>; // Key is timeControl as string
    private users: WebSocket[];

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
        this.users = this.users.filter(user => user !== socket);
        
        // Remove from pending users if they were waiting
        for (const [key, pending] of this.pendingUsers.entries()) {
            if (pending.socket === socket) {
                this.pendingUsers.delete(key);
                console.log(`Removed pending user with time control: ${key}`);
                break;
            }
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
                let timeControl: number | null = null;
                if (message.payload && message.payload.timeControl !== undefined && message.payload.timeControl !== null) {
                    timeControl = message.payload.timeControl;
                }
                
                console.log("Player requesting game with time control:", timeControl);
                
                // Create a key for this time control (convert to string for Map key)
                const timeControlKey = timeControl === null ? "unlimited" : timeControl.toString();
                
                console.log("Looking for pending player with key:", timeControlKey);
                console.log("Current pending users:", Array.from(this.pendingUsers.keys()));
                
                // Check if there's a pending user with the same time control
                const pendingPlayer = this.pendingUsers.get(timeControlKey);
                
                if (pendingPlayer && pendingPlayer.socket !== socket) {
                    // Match found! Create game with matching time control
                    console.log("Match found! Creating game with time control:", timeControl);
                    
                    // Remove from pending BEFORE creating game
                    this.pendingUsers.delete(timeControlKey);
                    
                    const game = new Game(pendingPlayer.socket, socket, timeControl);
                    this.games.push(game);
                    
                    console.log("Game created successfully");
                } else {
                    // No match found, add this player to pending users
                    console.log("No match found. Adding to pending users with time control:", timeControl);
                    
                    // Make sure to remove this socket from any other pending queues first
                    for (const [key, pending] of this.pendingUsers.entries()) {
                        if (pending.socket === socket) {
                            this.pendingUsers.delete(key);
                            console.log(`Removed socket from previous queue: ${key}`);
                        }
                    }
                    
                    this.pendingUsers.set(timeControlKey, {
                        socket: socket,
                        timeControl: timeControl
                    });
                    
                    console.log("Added to pending users. Total pending:", this.pendingUsers.size);
                    
                    // Send waiting message
                    socket.send(JSON.stringify({
                        type: "WAITING",
                        payload: {
                            message: "Waiting for opponent with same time control...",
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