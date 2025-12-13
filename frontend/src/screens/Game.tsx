import { useEffect, useState } from "react";
import { Button } from "../components/Button"
import { ChessBoard } from "../components/ChessBoard"
import { useSocket } from "../hooks/useSocket";
import { Chess } from 'chess.js'

// TODO: Move together, there's code repetition here
export const INIT_GAME = "init_game";
export const MOVE = "move";
export const GAME_OVER = "game_over";
export const GET_VALID_MOVES = "get_valid_moves";
export const VALID_MOVES = "valid_moves";

export const Game = () => {
    const socket = useSocket();
    const [chess] = useState(new Chess());
    const [board, setBoard] = useState(chess.board());
    const [started, setStarted] = useState(false);
    const [validMoves, setValidMoves] = useState<Array<{from: string, to: string, promotion?: string}>>([]);
    const [playerColor, setPlayerColor] = useState<"white" | "black">("white");
    const [gameOver, setGameOver] = useState(false);
    const [winner, setWinner] = useState<string | null>(null);
    const [searching, setSearching] = useState(false);

    useEffect(() => {
        if (!socket) {
            return;
        }
        socket.onmessage = (event) => {
            const message = JSON.parse(event.data);

            switch (message.type) {
                case INIT_GAME:
                    setBoard(chess.board());
                    setStarted(true);
                    setSearching(false);
                    setPlayerColor(message.payload.color);
                    console.log("Player color:", message.payload.color);
                    break;
                case MOVE: {
                    const move = message.payload;
                    chess.move(move);
                    setBoard(chess.board());
                    setValidMoves([]); // Clear valid moves after a move is made
                    console.log("Move made");
                    break;
                }
                case GAME_OVER:
                    console.log("Game over");
                    setGameOver(true);
                    setWinner(message.payload.winner);
                    break;
                case VALID_MOVES:
                    console.log("Received valid moves for", message.payload.square, ":", message.payload.moves);
                    setValidMoves(message.payload.moves);
                    break;
            }
        }
    }, [socket, chess]);

    // Function to request valid moves for a square
    const requestValidMoves = (square: string) => {
        if (socket) {
            // Clear valid moves if empty square clicked
            if (!square) {
                setValidMoves([]);
                return;
            }
            
            console.log("Requesting valid moves for square:", square);
            socket.send(JSON.stringify({
                type: GET_VALID_MOVES,
                payload: {
                    square: square
                }
            }));
        }
    };

    if (!socket) return <div>Connecting...</div>

    return <div className="justify-center flex min-h-screen bg-slate-800 overflow-x-hidden">
        <div className="pt-4 md:pt-8 w-full px-2 md:px-4 max-w-screen-lg">
            <div className="grid grid-cols-1 md:grid-cols-6 gap-4 w-full">
                <div className="md:col-span-4 w-full flex justify-center overflow-hidden">
                    <div className="relative w-full max-w-md">
                        <ChessBoard 
                            chess={chess} 
                            setBoard={setBoard} 
                            socket={socket} 
                            board={board}
                            validMoves={validMoves}
                            onSquareClick={requestValidMoves}
                            playerColor={playerColor}
                            disabled={!started}
                        />
                        
                        {/* Game Over Overlay */}
                        {gameOver && (
                            <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center">
                                <div className="bg-white text-black p-4 md:p-8 rounded-lg text-center mx-4">
                                    <h2 className="text-2xl md:text-3xl font-bold mb-2 md:mb-4">Checkmate!</h2>
                                    <p className="text-lg md:text-xl mb-3 md:mb-4">
                                        {winner === playerColor ? "You won! 🎉" : `${winner?.charAt(0).toUpperCase()}${winner?.slice(1)} wins!`}
                                    </p>
                                    <button 
                                        onClick={() => window.location.reload()} 
                                        className="bg-green-500 hover:bg-green-600 text-white font-bold py-2 px-4 rounded"
                                    >
                                        Play Again
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                <div className="md:col-span-2 bg-slate-900 w-full flex justify-center py-4 md:py-0">
                    <div className="md:pt-8">
                        {!started && !searching && (
                            <Button onClick={() => {
                                setSearching(true);
                                socket.send(JSON.stringify({
                                    type: INIT_GAME
                                }))
                            }}>
                                Play
                            </Button>
                        )}
                        {searching && (
                            <div className="text-white text-center">
                                <div className="mb-4 text-lg">Looking for opponent...</div>
                                <div className="animate-pulse">⏳</div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    </div>
}