import { WebSocket } from "ws";
import { Chess } from 'chess.js'
import { GAME_OVER, INIT_GAME, MOVE, VALID_MOVES } from "./messages";

export class Game {
    public player1: WebSocket;
    public player2: WebSocket;
    public board: Chess
    private startTime: Date;
    private moveCount = 0;

    constructor(player1: WebSocket, player2: WebSocket) {
        this.player1 = player1;
        this.player2 = player2;
        this.board = new Chess();
        this.startTime = new Date();
        this.player1.send(JSON.stringify({
            type: INIT_GAME,
            payload: {
                color: "white"
            }
        }));
        this.player2.send(JSON.stringify({
            type: INIT_GAME,
            payload: {
                color: "black"
            }
        }));
    }

    makeMove(socket: WebSocket, move: {
        from: string;
        to: string;
    }) {
        // validate the type of move using zod
        if (this.moveCount % 2 === 0 && socket !== this.player1) {
            return
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

        // Increment moveCount immediately after successful move
        this.moveCount++;
        
        if (this.board.isGameOver()) {
            // Send the game over message to both players
            this.player1.send(JSON.stringify({
                type: GAME_OVER,
                payload: {
                    winner: this.board.turn() === "w" ? "black" : "white"
                }
            }))
            this.player2.send(JSON.stringify({
                type: GAME_OVER,
                payload: {
                    winner: this.board.turn() === "w" ? "black" : "white"
                }
            }))
            return;
        }

        // Use moveCount-1 since we already incremented
        if ((this.moveCount - 1) % 2 === 0) {
            this.player2.send(JSON.stringify({
                type: MOVE,
                payload: move
            }))
        } else {
            this.player1.send(JSON.stringify({
                type: MOVE,
                payload: move
            }))
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
}