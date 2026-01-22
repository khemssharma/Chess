import { WebSocket } from "ws";
import { Chess } from 'chess.js'
import { GAME_OVER, INIT_GAME, MOVE, VALID_MOVES, TIME_UPDATE } from "./messages";

export class Game {
    public player1: WebSocket;
    public player2: WebSocket;
    public board: Chess;
    private startTime: Date;
    private moveCount = 0;
    
    // Time control properties
    private timeControl: number | null; // in milliseconds, null for no time limit
    private player1Time: number | null; // remaining time in milliseconds
    private player2Time: number | null; // remaining time in milliseconds
    private lastMoveTime: number; // timestamp of last move
    private timeUpdateInterval: NodeJS.Timeout | null = null;

    constructor(player1: WebSocket, player2: WebSocket, timeControlMinutes: number | null = 10) {
        this.player1 = player1;
        this.player2 = player2;
        this.board = new Chess();
        this.startTime = new Date();
        
        // Initialize time control (convert minutes to milliseconds)
        if (timeControlMinutes !== null) {
            this.timeControl = timeControlMinutes * 60 * 1000;
            this.player1Time = this.timeControl;
            this.player2Time = this.timeControl;
            this.lastMoveTime = Date.now();
            
            // Start time tracking only if time control is enabled
            this.startTimeTracking();
        } else {
            this.timeControl = null;
            this.player1Time = null;
            this.player2Time = null;
            this.lastMoveTime = 0;
        }
        
        this.player1.send(JSON.stringify({
            type: INIT_GAME,
            payload: {
                color: "white",
                timeControl: timeControlMinutes
            }
        }));
        this.player2.send(JSON.stringify({
            type: INIT_GAME,
            payload: {
                color: "black",
                timeControl: timeControlMinutes
            }
        }));
    }

    private startTimeTracking() {
        // Only start tracking if time control is enabled
        if (this.timeControl === null) {
            return;
        }
        
        // Update time every 100ms for smooth countdown
        this.timeUpdateInterval = setInterval(() => {
            const now = Date.now();
            const elapsed = now - this.lastMoveTime;
            
            // Deduct time from current player
            if (this.moveCount % 2 === 0 && this.player1Time !== null) {
                this.player1Time -= elapsed;
            } else if (this.player2Time !== null) {
                this.player2Time -= elapsed;
            }
            
            this.lastMoveTime = now;
            
            // Check for timeout
            if (this.player1Time !== null && this.player1Time <= 0) {
                this.endGameByTimeout("black");
                return;
            }
            if (this.player2Time !== null && this.player2Time <= 0) {
                this.endGameByTimeout("white");
                return;
            }
            
            // Send time updates to both players
            this.sendTimeUpdate();
        }, 100);
    }

    private sendTimeUpdate() {
        // Only send updates if time control is enabled
        if (this.player1Time === null || this.player2Time === null) {
            return;
        }
        
        const timeUpdate = {
            type: TIME_UPDATE,
            payload: {
                whiteTime: Math.max(0, this.player1Time),
                blackTime: Math.max(0, this.player2Time)
            }
        };
        
        this.player1.send(JSON.stringify(timeUpdate));
        this.player2.send(JSON.stringify(timeUpdate));
    }

    private endGameByTimeout(winner: string) {
        if (this.timeUpdateInterval) {
            clearInterval(this.timeUpdateInterval);
            this.timeUpdateInterval = null;
        }
        
        const gameOverMessage = {
            type: GAME_OVER,
            payload: {
                winner: winner,
                reason: "timeout"
            }
        };
        
        this.player1.send(JSON.stringify(gameOverMessage));
        this.player2.send(JSON.stringify(gameOverMessage));
    }

    makeMove(socket: WebSocket, move: {
        from: string;
        to: string;
    }) {
        // validate the type of move using zod
        if (this.moveCount % 2 === 0 && socket !== this.player1) {
            return;
        }
        if (this.moveCount % 2 === 1 && socket !== this.player2) {
            return;
        }

        try {
            this.board.move(move);
        } catch(e) {
            console.log(e);
            return;
        }

        // Update the last move time (only if time control is enabled)
        if (this.timeControl !== null) {
            this.lastMoveTime = Date.now();
        }
        
        // Increment moveCount immediately after successful move
        this.moveCount++;
        
        if (this.board.isGameOver()) {
            // Stop time tracking
            if (this.timeUpdateInterval) {
                clearInterval(this.timeUpdateInterval);
                this.timeUpdateInterval = null;
            }
            
            // Send the game over message to both players
            const winner = this.board.turn() === "w" ? "black" : "white";
            let reason = "checkmate";
            
            if (this.board.isCheckmate()) {
                reason = "checkmate";
            } else if (this.board.isDraw()) {
                reason = "draw";
            } else if (this.board.isStalemate()) {
                reason = "stalemate";
            } else if (this.board.isThreefoldRepetition()) {
                reason = "repetition";
            } else if (this.board.isInsufficientMaterial()) {
                reason = "insufficient material";
            }
            
            this.player1.send(JSON.stringify({
                type: GAME_OVER,
                payload: {
                    winner: this.board.isDraw() ? null : winner,
                    reason: reason
                }
            }));
            this.player2.send(JSON.stringify({
                type: GAME_OVER,
                payload: {
                    winner: this.board.isDraw() ? null : winner,
                    reason: reason
                }
            }));
            return;
        }

        // Use moveCount-1 since we already incremented
        if ((this.moveCount - 1) % 2 === 0) {
            this.player2.send(JSON.stringify({
                type: MOVE,
                payload: move
            }));
        } else {
            this.player1.send(JSON.stringify({
                type: MOVE,
                payload: move
            }));
        }
        
        // Send time update after move (only if time control is enabled)
        if (this.timeControl !== null) {
            this.sendTimeUpdate();
        }
    }

    getValidMoves(socket: WebSocket, square: string) {
        // Check if it's the player's turn
        if (this.moveCount % 2 === 0 && socket !== this.player1) {
            socket.send(JSON.stringify({
                type: VALID_MOVES,
                payload: {
                    square: square,
                    moves: []
                }
            }));
            return;
        }
        if (this.moveCount % 2 === 1 && socket !== this.player2) {
            socket.send(JSON.stringify({
                type: VALID_MOVES,
                payload: {
                    square: square,
                    moves: []
                }
            }));
            return;
        }

        // Get all valid moves for the piece at the given square
        const moves = this.board.moves({ square: square as any, verbose: true });
        
        socket.send(JSON.stringify({
            type: VALID_MOVES,
            payload: {
                square: square,
                moves: moves.map((move: any) => ({
                    from: move.from,
                    to: move.to,
                    promotion: move.promotion
                }))
            }
        }));
    }

    // Cleanup method to stop timers when game is destroyed
    cleanup() {
        if (this.timeUpdateInterval) {
            clearInterval(this.timeUpdateInterval);
            this.timeUpdateInterval = null;
        }
    }
}