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
export const TIME_UPDATE = "time_update";

interface InitGamePayload {
    type: string;
    payload?: {
        timeControl: number;
    };
}

export const Game = () => {
    const socket = useSocket();
    const [chess] = useState(new Chess());
    const [board, setBoard] = useState(chess.board());
    const [started, setStarted] = useState(false);
    const [validMoves, setValidMoves] = useState<Array<{from: string, to: string, promotion?: string}>>([]);
    const [playerColor, setPlayerColor] = useState<"white" | "black">("white");
    const [gameOver, setGameOver] = useState(false);
    const [winner, setWinner] = useState<string | null>(null);
    const [gameOverReason, setGameOverReason] = useState<string | null>(null);
    const [searching, setSearching] = useState(false);
    const [selectedTimeControl, setSelectedTimeControl] = useState<number | null>(null);
    
    // Time control state
    const [whiteTime, setWhiteTime] = useState<number | null>(null);
    const [blackTime, setBlackTime] = useState<number | null>(null);

    useEffect(() => {
        if (!socket) {
            return;
        }
        socket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            console.log("Received message:", message.type, message.payload);

            switch (message.type) {
                case INIT_GAME:
                    setBoard(chess.board());
                    setStarted(true);
                    setSearching(false);
                    setPlayerColor(message.payload.color);
                    console.log("Player color:", message.payload.color);
                    console.log("Time control:", message.payload.timeControl);
                    
                    // Initialize time if time control is set
                    if (message.payload.timeControl) {
                        const timeInMs = message.payload.timeControl * 60 * 1000;
                        console.log("Setting initial time:", timeInMs, "ms");
                        setWhiteTime(timeInMs);
                        setBlackTime(timeInMs);
                    } else {
                        // No time control - set to null to hide timers
                        setWhiteTime(null);
                        setBlackTime(null);
                    }
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
                    setGameOverReason(message.payload.reason || "checkmate");
                    break;
                case VALID_MOVES:
                    console.log("Received valid moves for", message.payload.square, ":", message.payload.moves);
                    setValidMoves(message.payload.moves);
                    break;
                case TIME_UPDATE:
                    console.log("Time update - White:", message.payload.whiteTime, "Black:", message.payload.blackTime);
                    setWhiteTime(message.payload.whiteTime);
                    setBlackTime(message.payload.blackTime);
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

    // Format time in MM:SS format
    const formatTime = (timeInMs: number | null): string => {
        if (timeInMs === null) return "";
        const totalSeconds = Math.max(0, Math.floor(timeInMs / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    // Start game with selected time control
    const startGame = (timeControl: number | null) => {
        setSearching(true);
        setSelectedTimeControl(timeControl);
        
        const payload: InitGamePayload = {
            type: INIT_GAME
        };
        
        if (timeControl !== null) {
            payload.payload = { timeControl };
        }
        
        socket?.send(JSON.stringify(payload));
    };

    if (!socket) return <div className="text-white">Connecting To Server. Please wait...</div>

    return <div className="justify-center flex min-h-screen bg-slate-800 overflow-x-hidden">
        <div className="pt-4 md:pt-8 w-full px-2 md:px-4 max-w-screen-lg">
            <div className="grid grid-cols-1 md:grid-cols-6 gap-4 w-full">
                <div className="md:col-span-4 w-full flex justify-center">
                    <div className="w-full max-w-md flex flex-col gap-3">
                        {/* Top Timer - Opponent */}
                        {started && whiteTime !== null && blackTime !== null && (
                            <div className="flex justify-center">
                                <div className={`px-6 py-3 rounded-lg font-mono text-2xl font-bold shadow-lg ${
                                    (playerColor === 'white' && chess.turn() === 'b') || (playerColor === 'black' && chess.turn() === 'w')
                                        ? 'bg-green-600 text-white' 
                                        : 'bg-slate-700 text-white'
                                }`}>
                                    {playerColor === 'white' ? '⚫' : '⚪'} {playerColor === 'white' ? formatTime(blackTime) : formatTime(whiteTime)}
                                </div>
                            </div>
                        )}
                        
                        {/* Chess Board */}
                        <div className="relative">
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
                                <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
                                    <div className="bg-white text-black p-4 md:p-8 rounded-lg text-center mx-4">
                                        <h2 className="text-2xl md:text-3xl font-bold mb-2 md:mb-4">
                                            {gameOverReason === "timeout" ? "Time's Up!" : "Checkmate!"}
                                        </h2>
                                        <p className="text-lg md:text-xl mb-3 md:mb-4">
                                            {winner === playerColor ? "You won! 🎉" : `${winner?.charAt(0).toUpperCase()}${winner?.slice(1)} wins!`}
                                        </p>
                                        {gameOverReason && gameOverReason !== "checkmate" && (
                                            <p className="text-sm text-gray-600 mb-3">
                                                {gameOverReason === "timeout" ? "by timeout" : `by ${gameOverReason}`}
                                            </p>
                                        )}
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
                        
                        {/* Bottom Timer - Your Timer */}
                        {started && whiteTime !== null && blackTime !== null && (
                            <div className="flex justify-center">
                                <div className={`px-6 py-3 rounded-lg font-mono text-2xl font-bold shadow-lg ${
                                    (playerColor === 'white' && chess.turn() === 'w') || (playerColor === 'black' && chess.turn() === 'b')
                                        ? 'bg-green-600 text-white' 
                                        : 'bg-slate-700 text-white'
                                }`}>
                                    {playerColor === 'white' ? '⚪' : '⚫'} {playerColor === 'white' ? formatTime(whiteTime) : formatTime(blackTime)}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                
                <div className="md:col-span-2 bg-slate-900 w-full flex justify-center py-4 md:py-0">
                    <div className="md:pt-8 px-4">
                        {!started && !searching && (
                            <div className="space-y-4">
                                <h2 className="text-white text-xl font-bold mb-4 text-center">Choose Time Control</h2>
                                
                                <Button onClick={() => startGame(3)}>
                                    ⚡ 3 Minutes
                                </Button>
                                
                                <Button onClick={() => startGame(5)}>
                                    🕐 5 Minutes
                                </Button>
                                
                                <Button onClick={() => startGame(10)}>
                                    ⏱️ 10 Minutes
                                </Button>
                                
                                <Button onClick={() => startGame(null)}>
                                    ♾️ No Time Limit
                                </Button>
                            </div>
                        )}
                        {searching && (
                            <div className="text-white text-center">
                                <div className="mb-4 text-lg">Looking for opponent...</div>
                                {selectedTimeControl && (
                                    <div className="mb-2 text-sm text-gray-400">
                                        {selectedTimeControl} minute game
                                    </div>
                                )}
                                <div className="animate-pulse">⏳</div>
                            </div>
                        )}
                        {started && (
                            <div className="text-white text-center space-y-4">
                                <div className="text-lg font-bold">
                                    You are playing as
                                </div>
                                <div className="text-2xl">
                                    {playerColor === "white" ? "⚪ White" : "⚫ Black"}
                                </div>
                                {whiteTime !== null && blackTime !== null && (
                                    <div className="mt-4 text-sm text-gray-400">
                                        {selectedTimeControl} min • Bullet
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    </div>
}