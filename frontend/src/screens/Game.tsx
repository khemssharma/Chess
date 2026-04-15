import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/Button";
import { ChessBoard } from "../components/ChessBoard";
import { useSocket } from "../hooks/useSocket";
import { useAuth } from "../context/AuthContext";
import { Chess } from "chess.js";

export const INIT_GAME = "init_game";
export const MOVE = "move";
export const GAME_OVER = "game_over";
export const GET_VALID_MOVES = "get_valid_moves";
export const VALID_MOVES = "valid_moves";
export const TIME_UPDATE = "time_update";
export const RECONNECT = "reconnect";
export const GAME_STATE = "game_state";

const PLAYER_ID_KEY = "chess_player_id";
const GAME_ID_KEY = "chess_game_id";

interface InitGamePayload {
    type: string;
    payload?: { timeControl: number };
}

export const Game = () => {
    const socket = useSocket();
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    const [chess, setChess] = useState(new Chess());
    const [board, setBoard] = useState(chess.board());
    const [started, setStarted] = useState(false);
    const [validMoves, setValidMoves] = useState<Array<{ from: string; to: string; promotion?: string }>>([]);
    const [playerColor, setPlayerColor] = useState<"white" | "black">("white");
    const [gameOver, setGameOver] = useState(false);
    const [winner, setWinner] = useState<string | null>(null);
    const [gameOverReason, setGameOverReason] = useState<string | null>(null);
    const [searching, setSearching] = useState(false);
    const [selectedTimeControl, setSelectedTimeControl] = useState<number | null>(null);
    const [reconnecting, setReconnecting] = useState(false);
    const [whiteTime, setWhiteTime] = useState<number | null>(null);
    const [blackTime, setBlackTime] = useState<number | null>(null);
    const [opponentDisconnected, setOpponentDisconnected] = useState(false);
    const [disconnectSecondsLeft, setDisconnectSecondsLeft] = useState<number | null>(null);

    // Attempt reconnect on socket connect if we have a stored session
    useEffect(() => {
        if (!socket) return;
        const storedPlayerId = localStorage.getItem(PLAYER_ID_KEY);
        if (storedPlayerId) {
            setReconnecting(true);
            socket.send(JSON.stringify({ type: RECONNECT, payload: { playerId: storedPlayerId } }));
        }
    }, [socket]);

    useEffect(() => {
        if (!socket) return;

        socket.onmessage = (event) => {
            const message = JSON.parse(event.data);

            switch (message.type) {
                case INIT_GAME: {
                    if (message.payload.playerId) localStorage.setItem(PLAYER_ID_KEY, message.payload.playerId);
                    if (message.payload.gameId) localStorage.setItem(GAME_ID_KEY, message.payload.gameId);

                    const newChess = new Chess();
                    setChess(newChess);
                    setBoard(newChess.board());
                    setStarted(true);
                    setSearching(false);
                    setReconnecting(false);
                    setPlayerColor(message.payload.color);

                    if (message.payload.timeControl) {
                        const ms = message.payload.timeControl * 60 * 1000;
                        setWhiteTime(ms);
                        setBlackTime(ms);
                        setSelectedTimeControl(message.payload.timeControl);
                    } else {
                        setWhiteTime(null);
                        setBlackTime(null);
                    }
                    break;
                }

                case GAME_STATE: {
                    const restored = new Chess(message.payload.fen);
                    setChess(restored);
                    setBoard(restored.board());
                    setStarted(true);
                    setSearching(false);
                    setReconnecting(false);
                    setPlayerColor(message.payload.yourColor);
                    setSelectedTimeControl(message.payload.timeControl);
                    setWhiteTime(message.payload.whiteTime ?? null);
                    setBlackTime(message.payload.blackTime ?? null);
                    break;
                }

                case MOVE: {
                    chess.move(message.payload);
                    setBoard(chess.board());
                    setValidMoves([]);
                    break;
                }

                case GAME_OVER:
                    localStorage.removeItem(PLAYER_ID_KEY);
                    localStorage.removeItem(GAME_ID_KEY);
                    setGameOver(true);
                    setWinner(message.payload.winner);
                    setGameOverReason(message.payload.reason || "checkmate");
                    setOpponentDisconnected(false);
                    setDisconnectSecondsLeft(null);
                    break;

                case VALID_MOVES:
                    setValidMoves(message.payload.moves);
                    break;

                case TIME_UPDATE:
                    setWhiteTime(message.payload.whiteTime);
                    setBlackTime(message.payload.blackTime);
                    break;

                case "WAITING":
                    setSearching(true);
                    setReconnecting(false);
                    break;

                case "WAITING_FOR_OPPONENT":
                    setReconnecting(true);
                    setStarted(false);
                    break;

                case "NO_GAME":
                    localStorage.removeItem(PLAYER_ID_KEY);
                    localStorage.removeItem(GAME_ID_KEY);
                    setReconnecting(false);
                    break;

                case "OPPONENT_DISCONNECTED":
                    setOpponentDisconnected(true);
                    setDisconnectSecondsLeft(message.payload?.secondsLeft ?? null);
                    break;

                case "OPPONENT_RECONNECTED":
                    setOpponentDisconnected(false);
                    setDisconnectSecondsLeft(null);
                    break;
            }
        };
    }, [socket, chess]);

    const requestValidMoves = (square: string) => {
        if (!socket) return;
        if (!square) { setValidMoves([]); return; }
        socket.send(JSON.stringify({ type: GET_VALID_MOVES, payload: { square } }));
    };

    const formatTime = (ms: number | null) => {
        if (ms === null) return "";
        const total = Math.max(0, Math.floor(ms / 1000));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${m}:${s.toString().padStart(2, "0")}`;
    };

    const resetGame = () => {
        localStorage.removeItem(PLAYER_ID_KEY);
        localStorage.removeItem(GAME_ID_KEY);
        setChess(new Chess());
        setBoard(new Chess().board());
        setStarted(false);
        setValidMoves([]);
        setPlayerColor("white");
        setGameOver(false);
        setWinner(null);
        setGameOverReason(null);
        setSearching(false);
        setSelectedTimeControl(null);
        setWhiteTime(null);
        setBlackTime(null);
        setReconnecting(false);
        setOpponentDisconnected(false);
        setDisconnectSecondsLeft(null);
    };

    const startGame = (timeControl: number | null) => {
        setSearching(true);
        setSelectedTimeControl(timeControl);
        const payload: InitGamePayload = { type: INIT_GAME };
        if (timeControl !== null) payload.payload = { timeControl };
        socket?.send(JSON.stringify(payload));
    };

    if (!socket) return (
        <div className="min-h-screen bg-slate-800 flex items-center justify-center text-white text-lg">
            Connecting to server...
        </div>
    );

    return (
        <div className="justify-center flex min-h-screen bg-slate-800 overflow-x-hidden">
            <div className="pt-4 md:pt-8 w-full px-2 md:px-4 max-w-screen-lg">

                {/* Top bar */}
                <div className="flex justify-between items-center mb-4 px-1">
                    <div
                        className="flex items-center gap-2 cursor-pointer"
                        onClick={() => navigate("/")}
                    >
                        <span className="text-2xl">♔</span>
                        <span className="text-white font-bold text-lg">ChessMaster</span>
                    </div>
                    <div className="flex items-center gap-3">
                        {user ? (
                            <>
                                <button
                                    onClick={() => navigate("/history")}
                                    className="text-gray-400 hover:text-white text-sm transition"
                                >
                                    My Games
                                </button>
                                <span className="text-gray-500 text-sm">{user.username}</span>
                                <button
                                    onClick={() => { logout(); navigate("/"); }}
                                    className="text-gray-500 hover:text-white text-xs transition"
                                >
                                    Sign out
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={() => navigate("/login")}
                                className="text-purple-400 hover:text-purple-300 text-sm font-medium transition"
                            >
                                Sign in to save games
                            </button>
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-6 gap-4 w-full">
                    {/* Board column */}
                    <div className="md:col-span-4 w-full flex justify-center">
                        <div className="w-full max-w-md flex flex-col gap-3">
                            {/* Opponent timer */}
                            {started && whiteTime !== null && blackTime !== null && (
                                <div className="flex justify-center">
                                    <div className={`px-6 py-3 rounded-lg font-mono text-2xl font-bold shadow-lg ${
                                        (playerColor === "white" && chess.turn() === "b") || (playerColor === "black" && chess.turn() === "w")
                                            ? "bg-green-600 text-white"
                                            : "bg-slate-700 text-white"
                                    }`}>
                                        {playerColor === "white" ? "⚫" : "⚪"}{" "}
                                        {playerColor === "white" ? formatTime(blackTime) : formatTime(whiteTime)}
                                    </div>
                                </div>
                            )}

                            {/* Opponent disconnected banner */}
                            {opponentDisconnected && !gameOver && (
                                <div className="flex justify-center">
                                    <div className="w-full px-4 py-3 rounded-lg bg-yellow-600 text-white text-center shadow-lg">
                                        <p className="font-bold text-sm">⚠️ Opponent disconnected</p>
                                        {disconnectSecondsLeft !== null && (
                                            <p className="text-xs mt-1">
                                                They have <span className="font-mono font-bold">{disconnectSecondsLeft}s</span> to reconnect or you win!
                                            </p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Board */}
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

                                {/* Game Over overlay */}
                                {gameOver && (
                                    <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
                                        <div className="bg-white text-black p-4 md:p-8 rounded-lg text-center mx-4">
                                            <h2 className="text-2xl md:text-3xl font-bold mb-2 md:mb-4">
                                                {gameOverReason === "timeout" ? "Time's Up!" : gameOverReason === "opponent_left" ? "Opponent Left" : "Game Over!"}
                                            </h2>
                                            <p className="text-lg md:text-xl mb-3 md:mb-4">
                                                {winner === playerColor
                                                    ? "You won! 🎉"
                                                    : winner === null
                                                    ? "It's a draw!"
                                                    : `${winner?.charAt(0).toUpperCase()}${winner?.slice(1)} wins!`}
                                            </p>
                                            {gameOverReason && gameOverReason !== "checkmate" && (
                                                <p className="text-sm text-gray-600 mb-3">
                                                    {gameOverReason === "opponent_left"
                                                        ? "Your opponent failed to reconnect in time."
                                                        : `by ${gameOverReason}`}
                                                </p>
                                            )}
                                            <div className="flex gap-3 justify-center flex-wrap">
                                                <button
                                                    onClick={resetGame}
                                                    className="bg-green-500 hover:bg-green-600 text-white font-bold py-2 px-4 rounded"
                                                >
                                                    Play Again
                                                </button>
                                                {user && (
                                                    <button
                                                        onClick={() => navigate("/history")}
                                                        className="bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded"
                                                    >
                                                        View History
                                                    </button>
                                                )}
                                            </div>
                                            {!user && (
                                                <p className="text-xs text-gray-400 mt-3">
                                                    <button onClick={() => navigate("/register")} className="underline">
                                                        Create an account
                                                    </button>{" "}
                                                    to save your games
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* My timer */}
                            {started && whiteTime !== null && blackTime !== null && (
                                <div className="flex justify-center">
                                    <div className={`px-6 py-3 rounded-lg font-mono text-2xl font-bold shadow-lg ${
                                        (playerColor === "white" && chess.turn() === "w") || (playerColor === "black" && chess.turn() === "b")
                                            ? "bg-green-600 text-white"
                                            : "bg-slate-700 text-white"
                                    }`}>
                                        {playerColor === "white" ? "⚪" : "⚫"}{" "}
                                        {playerColor === "white" ? formatTime(whiteTime) : formatTime(blackTime)}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Sidebar */}
                    <div className="md:col-span-2 bg-slate-900 w-full flex justify-center py-4 md:py-0">
                        <div className="md:pt-8 px-4 w-full">

                            {reconnecting && (
                                <div className="text-white text-center">
                                    <div className="mb-4 text-lg">Reconnecting to game...</div>
                                    <div className="animate-pulse text-2xl">♟️</div>
                                    <button
                                        onClick={resetGame}
                                        className="mt-6 text-sm text-gray-400 underline hover:text-white"
                                    >
                                        Cancel & start new game
                                    </button>
                                </div>
                            )}

                            {!started && !searching && !reconnecting && (
                                <div className="space-y-4">
                                    <h2 className="text-white text-xl font-bold mb-4 text-center">Choose Time Control</h2>
                                    <Button onClick={() => startGame(3)}>⚡ 3 Minutes</Button>
                                    <Button onClick={() => startGame(5)}>🕐 5 Minutes</Button>
                                    <Button onClick={() => startGame(10)}>⏱️ 10 Minutes</Button>
                                    <Button onClick={() => startGame(null)}>♾️ No Time Limit</Button>

                                    {!user && (
                                        <div className="mt-6 pt-4 border-t border-slate-700 text-center">
                                            <p className="text-gray-500 text-xs mb-2">Games won't be saved</p>
                                            <button
                                                onClick={() => navigate("/login")}
                                                className="text-purple-400 hover:text-purple-300 text-sm underline"
                                            >
                                                Sign in to track history
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}

                            {searching && (
                                <div className="text-white text-center">
                                    <div className="mb-4 text-lg">Looking for opponent...</div>
                                    {selectedTimeControl && (
                                        <div className="mb-2 text-sm text-gray-400">{selectedTimeControl} minute game</div>
                                    )}
                                    <div className="animate-pulse">⏳</div>
                                </div>
                            )}

                            {started && !reconnecting && (
                                <div className="text-white text-center space-y-4">
                                    <div className="text-lg font-bold">You are playing as</div>
                                    <div className="text-2xl">
                                        {playerColor === "white" ? "⚪ White" : "⚫ Black"}
                                    </div>
                                    {whiteTime !== null && (
                                        <div className="text-sm text-gray-400">
                                            {selectedTimeControl} min game
                                        </div>
                                    )}
                                    {user && (
                                        <div className="mt-4 pt-4 border-t border-slate-700">
                                            <p className="text-xs text-green-400">
                                                ✓ Game will be saved to your profile
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
