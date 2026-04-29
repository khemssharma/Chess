import { useEffect, useState, useRef } from "react";
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
export const PLAY_VS_COMPUTER = "play_vs_computer";

const PLAYER_ID_KEY = "chess_player_id";
const GAME_ID_KEY = "chess_game_id";

type Difficulty = "easy" | "medium" | "hard" | "expert";
type GameMode = "online" | "computer" | null;

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

    // Computer game state
    const [gameMode, setGameMode] = useState<GameMode>(null);
    const [selectedDifficulty, setSelectedDifficulty] = useState<Difficulty>("medium");
    const [selectedColor, setSelectedColor] = useState<"white" | "black" | "random">("white");
    const [vsComputer, setVsComputer] = useState(false);
    const [difficulty, setDifficulty] = useState<Difficulty>("medium");

    // Live move list
    const [liveMoves, setLiveMoves] = useState<string[]>([]);
    const moveListRef = useRef<HTMLDivElement>(null);

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
                    setVsComputer(!!message.payload.vsComputer);
                    if (message.payload.difficulty) setDifficulty(message.payload.difficulty);
                    setLiveMoves([]);

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
                    // Rebuild SAN move list from restored history
                    setLiveMoves(restored.history());
                    break;
                }

                case MOVE: {
                    const result = chess.move(message.payload);
                    setBoard(chess.board());
                    setValidMoves([]);
                    if (result) setLiveMoves(prev => [...prev, result.san]);
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
        setVsComputer(false);
        setGameMode(null);
        setLiveMoves([]);
    };

    const startGame = (timeControl: number | null) => {
        setSearching(true);
        setSelectedTimeControl(timeControl);
        const payload: InitGamePayload = { type: INIT_GAME };
        if (timeControl !== null) payload.payload = { timeControl };
        socket?.send(JSON.stringify(payload));
    };

    // Auto-scroll move list to bottom on new move
    useEffect(() => {
        if (moveListRef.current) {
            moveListRef.current.scrollTop = moveListRef.current.scrollHeight;
        }
    }, [liveMoves]);

    const startComputerGame = (timeControl: number | null) => {
        const color = selectedColor === "random"
            ? (Math.random() < 0.5 ? "white" : "black")
            : selectedColor;
        setSelectedTimeControl(timeControl);
        socket?.send(JSON.stringify({
            type: PLAY_VS_COMPUTER,
            payload: {
                difficulty: selectedDifficulty,
                color,
                timeControl,
            },
        }));
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
                                                    : vsComputer
                                                    ? "Computer wins! 🤖"
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
                                    {/* Mode selector */}
                                    {gameMode === null && (
                                        <>
                                            <h2 className="text-white text-xl font-bold mb-4 text-center">Choose Game Mode</h2>
                                            <button
                                                onClick={() => setGameMode("online")}
                                                className="w-full bg-gradient-to-r from-purple-600 to-pink-600 text-white py-4 rounded-xl font-bold text-base hover:from-purple-700 hover:to-pink-700 transition-all flex items-center justify-center gap-2"
                                            >
                                                🌐 Play Online
                                            </button>
                                            <button
                                                onClick={() => setGameMode("computer")}
                                                className="w-full bg-gradient-to-r from-slate-600 to-slate-700 text-white py-4 rounded-xl font-bold text-base border border-slate-500 hover:from-slate-500 hover:to-slate-600 transition-all flex items-center justify-center gap-2"
                                            >
                                                🤖 Play vs Computer
                                            </button>
                                        </>
                                    )}

                                    {/* Online: time control */}
                                    {gameMode === "online" && (
                                        <>
                                            <div className="flex items-center gap-2 mb-2">
                                                <button onClick={() => setGameMode(null)} className="text-gray-400 hover:text-white text-sm">← Back</button>
                                                <h2 className="text-white text-lg font-bold">Choose Time Control</h2>
                                            </div>
                                            <Button onClick={() => startGame(3)}>⚡ 3 Minutes</Button>
                                            <Button onClick={() => startGame(5)}>🕐 5 Minutes</Button>
                                            <Button onClick={() => startGame(10)}>⏱️ 10 Minutes</Button>
                                            <Button onClick={() => startGame(null)}>♾️ No Time Limit</Button>
                                        </>
                                    )}

                                    {/* Computer: settings */}
                                    {gameMode === "computer" && (
                                        <>
                                            <div className="flex items-center gap-2 mb-1">
                                                <button onClick={() => setGameMode(null)} className="text-gray-400 hover:text-white text-sm">← Back</button>
                                                <h2 className="text-white text-lg font-bold">Play vs Computer</h2>
                                            </div>

                                            {/* Difficulty */}
                                            <div>
                                                <p className="text-gray-400 text-xs mb-2 uppercase tracking-wider">Difficulty</p>
                                                <div className="grid grid-cols-2 gap-2">
                                                    {(["easy", "medium", "hard", "expert"] as Difficulty[]).map((d) => (
                                                        <button
                                                            key={d}
                                                            onClick={() => setSelectedDifficulty(d)}
                                                            className={`py-2 px-3 rounded-lg text-sm font-semibold capitalize transition-all border ${
                                                                selectedDifficulty === d
                                                                    ? "bg-purple-600 border-purple-400 text-white"
                                                                    : "bg-slate-700 border-slate-600 text-gray-300 hover:bg-slate-600"
                                                            }`}
                                                        >
                                                            {d === "easy" && "🟢 "}
                                                            {d === "medium" && "🟡 "}
                                                            {d === "hard" && "🔴 "}
                                                            {d === "expert" && "💀 "}
                                                            {d}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>

                                            {/* Color picker */}
                                            <div>
                                                <p className="text-gray-400 text-xs mb-2 uppercase tracking-wider">Play as</p>
                                                <div className="grid grid-cols-3 gap-2">
                                                    {(["white", "black", "random"] as const).map((c) => (
                                                        <button
                                                            key={c}
                                                            onClick={() => setSelectedColor(c)}
                                                            className={`py-2 px-2 rounded-lg text-sm font-semibold capitalize transition-all border ${
                                                                selectedColor === c
                                                                    ? "bg-purple-600 border-purple-400 text-white"
                                                                    : "bg-slate-700 border-slate-600 text-gray-300 hover:bg-slate-600"
                                                            }`}
                                                        >
                                                            {c === "white" && "⚪"}
                                                            {c === "black" && "⚫"}
                                                            {c === "random" && "🎲"}
                                                            <div className="text-xs mt-0.5">{c}</div>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>

                                            {/* Time control */}
                                            <div>
                                                <p className="text-gray-400 text-xs mb-2 uppercase tracking-wider">Time Control</p>
                                                <div className="space-y-2">
                                                    <Button onClick={() => startComputerGame(3)}>⚡ 3 Minutes</Button>
                                                    <Button onClick={() => startComputerGame(5)}>🕐 5 Minutes</Button>
                                                    <Button onClick={() => startComputerGame(10)}>⏱️ 10 Minutes</Button>
                                                    <Button onClick={() => startComputerGame(null)}>♾️ No Time Limit</Button>
                                                </div>
                                            </div>
                                        </>
                                    )}

                                    {!user && gameMode !== null && (
                                        <div className="mt-4 pt-4 border-t border-slate-700 text-center">
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
                                <div className="flex flex-col gap-3 h-full">
                                    {/* Players */}
                                    <div className="bg-slate-800 rounded-xl p-3 border border-slate-700">
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="text-gray-300 flex items-center gap-1">
                                                {playerColor === "black" ? "⚪" : "⚫"}
                                                {vsComputer
                                                    ? <span>🤖 Stockfish <span className="text-xs text-gray-500 capitalize">({difficulty})</span></span>
                                                    : <span className="text-gray-400">Opponent</span>
                                                }
                                            </span>
                                        </div>
                                        <div className="border-t border-slate-700 my-2" />
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="text-white font-medium flex items-center gap-1">
                                                {playerColor === "white" ? "⚪" : "⚫"}
                                                {user?.username ?? "You"}
                                            </span>
                                            {user && !vsComputer && (
                                                <span className="text-xs text-green-400">✓ saving</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Move list */}
                                    <div className="bg-slate-800 rounded-xl border border-slate-700 flex flex-col flex-1 min-h-0">
                                        <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between">
                                            <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Moves</span>
                                            <span className="text-xs text-gray-500">{liveMoves.length > 0 ? `${Math.ceil(liveMoves.length / 2)} played` : "Game starts"}</span>
                                        </div>

                                        <div
                                            ref={moveListRef}
                                            className="overflow-y-auto flex-1 p-1"
                                            style={{ maxHeight: "260px" }}
                                        >
                                            {liveMoves.length === 0 ? (
                                                <div className="text-center text-gray-600 text-xs py-6">No moves yet</div>
                                            ) : (
                                                <table className="w-full text-xs">
                                                    <tbody>
                                                        {Array.from({ length: Math.ceil(liveMoves.length / 2) }, (_, i) => {
                                                            const white = liveMoves[i * 2];
                                                            const black = liveMoves[i * 2 + 1];
                                                            const isLastPair = i === Math.ceil(liveMoves.length / 2) - 1;
                                                            return (
                                                                <tr
                                                                    key={i}
                                                                    className={`${isLastPair ? "bg-purple-600/20" : "hover:bg-white/5"}`}
                                                                >
                                                                    <td className="text-gray-600 w-6 py-1 pl-2 select-none">{i + 1}</td>
                                                                    <td className={`font-mono py-1 px-2 ${!black && isLastPair ? "text-white font-bold" : "text-gray-300"}`}>{white}</td>
                                                                    <td className={`font-mono py-1 px-2 ${black && isLastPair ? "text-white font-bold" : "text-gray-400"}`}>{black ?? ""}</td>
                                                                </tr>
                                                            );
                                                        })}
                                                    </tbody>
                                                </table>
                                            )}
                                        </div>
                                    </div>

                                    {/* Resign / New game */}
                                    {!gameOver && (
                                        <button
                                            onClick={resetGame}
                                            className="w-full text-xs text-gray-500 hover:text-red-400 transition py-1 border border-slate-700 rounded-lg hover:border-red-500/40"
                                        >
                                            Resign / New Game
                                        </button>
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
