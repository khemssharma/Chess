import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Chess } from "chess.js";

const API_URL = (import.meta.env.VITE_API_URL as string) || "http://localhost:3000";

interface Move { from: string; to: string; promotion?: string; }

interface FullGame {
  id: string;
  whiteUser: { id: number; username: string } | null;
  blackUser: { id: number; username: string } | null;
  moveHistory: Move[];
  moveCount: number;
  timeControl: number | null;
  winner: string | null;
  reason: string | null;
  isVsComputer: boolean;
  computerDifficulty: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = [8, 7, 6, 5, 4, 3, 2, 1];

export const GameReplay = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const { token, user } = useAuth();
  const navigate = useNavigate();

  const [game, setGame] = useState<FullGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Replay state
  const [stepIndex, setStepIndex] = useState(0); // 0 = starting position
  const [boards, setBoards] = useState<ReturnType<Chess["board"]>[]>([]);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(800);

  // Build all board snapshots upfront
  useEffect(() => {
    if (!game) return;
    const chess = new Chess();
    const snapshots: ReturnType<Chess["board"]>[] = [chess.board()];
    const moves: Move[] = (game.moveHistory as Move[]);
    for (const move of moves) {
      try {
        chess.move(move);
        snapshots.push(chess.board());
      } catch { break; }
    }
    setBoards(snapshots);
    setStepIndex(0);
  }, [game]);

  useEffect(() => {
    if (!token) { navigate("/login"); return; }
    fetch(`${API_URL}/api/games/${gameId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        if (data.game) setGame(data.game);
        else setError(data.message || "Game not found");
      })
      .catch(() => setError("Failed to load game"))
      .finally(() => setLoading(false));
  }, [gameId, token]);

  // Auto-play
  useEffect(() => {
    if (!isPlaying) return;
    if (stepIndex >= boards.length - 1) { setIsPlaying(false); return; }
    const t = setTimeout(() => setStepIndex(i => i + 1), playSpeed);
    return () => clearTimeout(t);
  }, [isPlaying, stepIndex, boards.length, playSpeed]);

  const goTo = useCallback((idx: number) => {
    setIsPlaying(false);
    const clamped = Math.max(0, Math.min(idx, boards.length - 1));
    setStepIndex(clamped);
    if (clamped > 0 && game) {
      const m = (game.moveHistory as Move[])[clamped - 1];
      setLastMove(m ? { from: m.from, to: m.to } : null);
    } else {
      setLastMove(null);
    }
  }, [boards.length, game]);

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") goTo(stepIndex + 1);
      if (e.key === "ArrowLeft") goTo(stepIndex - 1);
      if (e.key === " ") { e.preventDefault(); setIsPlaying(p => !p); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [stepIndex, goTo]);

  const board = boards[stepIndex] ?? [];
  const moves: Move[] = game ? (game.moveHistory as Move[]) : [];

  const myColor = game?.whiteUser?.id === user?.id ? "white" : "black";
  const viewFromWhite = myColor === "white";

  const displayBoard = viewFromWhite
    ? board
    : [...board].reverse().map(row => [...row].reverse());

  const opponentName = game
    ? game.isVsComputer
      ? `🤖 Stockfish${game.computerDifficulty ? ` (${game.computerDifficulty})` : ""}`
      : myColor === "white"
        ? (game.blackUser?.username ?? "Guest")
        : (game.whiteUser?.username ?? "Guest")
    : "";

  const resultLabel = () => {
    if (!game) return "";
    if (!game.winner) return "Draw";
    return game.winner === myColor ? "Victory" : "Defeat";
  };

  const resultColor = () => {
    if (!game?.winner) return "text-yellow-400";
    return game.winner === myColor ? "text-green-400" : "text-red-400";
  };

  // Move list — split into pairs
  const movePairs: [Move, Move | null][] = [];
  for (let i = 0; i < moves.length; i += 2) {
    movePairs.push([moves[i], moves[i + 1] ?? null]);
  }

  const getMoveLabel = (m: Move) =>
    `${m.from}${m.to}${m.promotion ? m.promotion.toUpperCase() : ""}`;

  if (loading) return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center text-white text-lg animate-pulse">
      Loading game...
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center">
      <div className="text-center">
        <div className="text-red-400 text-xl mb-4">{error}</div>
        <button onClick={() => navigate("/history")} className="text-purple-400 underline">← Back to History</button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white">
      {/* Nav */}
      <header className="border-b border-white/10 px-4 py-4">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-3xl">♔</span>
            <span className="text-xl font-bold">ChessMaster</span>
          </Link>
          <button
            onClick={() => navigate("/history")}
            className="text-gray-400 hover:text-white text-sm transition flex items-center gap-1"
          >
            ← Game History
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Game header */}
        {game && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">
                {user?.username} <span className="text-gray-400">vs</span> {opponentName}
              </h1>
              <p className="text-sm text-gray-400 mt-1">
                {game.timeControl ? `${game.timeControl} min` : "Unlimited"} ·{" "}
                {game.moveCount} moves ·{" "}
                {game.reason ?? "—"} ·{" "}
                {game.finishedAt ? formatDate(game.finishedAt) : formatDate(game.startedAt)}
              </p>
            </div>
            <div className={`text-3xl font-bold ${resultColor()}`}>
              {resultLabel()}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Board + controls */}
          <div className="lg:col-span-2">
            {/* Board */}
            <div className="w-full max-w-lg mx-auto">
              {/* Rank labels + board */}
              <div className="flex">
                {/* Rank labels */}
                <div className="flex flex-col justify-around pr-1 text-xs text-gray-500 select-none">
                  {(viewFromWhite ? RANKS : [...RANKS].reverse()).map(r => (
                    <div key={r} className="h-0 flex items-center" style={{ height: `${100 / 8}%` }}>{r}</div>
                  ))}
                </div>

                {/* Board squares */}
                <div className="flex-1 aspect-square">
                  {displayBoard.map((row, i) => (
                    <div key={i} className="flex w-full" style={{ height: `${100 / 8}%` }}>
                      {row.map((sq, j) => {
                        const file = viewFromWhite ? j : 7 - j;
                        const rank = viewFromWhite ? 8 - i : i + 1;
                        const squareName = FILES[file] + rank;
                        const isLight = (i + j) % 2 === 0;
                        const isLastFrom = lastMove?.from === squareName;
                        const isLastTo = lastMove?.to === squareName;

                        let bg = isLight ? "bg-green-500" : "bg-slate-500";
                        if (isLastFrom || isLastTo) bg = isLight ? "bg-yellow-400" : "bg-yellow-600";

                        return (
                          <div key={j} className={`${bg} relative flex-1 aspect-square flex items-center justify-center`}>
                            {sq && (
                              <img
                                src={`/${sq.color === "b" ? sq.type : `${sq.type.toUpperCase()} copy`}.png`}
                                className="w-3/5 h-3/5 object-contain select-none"
                                draggable={false}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              {/* File labels */}
              <div className="flex pl-5 text-xs text-gray-500 select-none mt-0.5">
                {(viewFromWhite ? FILES : [...FILES].reverse()).map(f => (
                  <div key={f} className="flex-1 text-center">{f}</div>
                ))}
              </div>
            </div>

            {/* Step counter */}
            <div className="text-center mt-3 text-gray-400 text-sm">
              {stepIndex === 0
                ? "Starting position"
                : `Move ${stepIndex} of ${moves.length}`}
            </div>

            {/* Controls */}
            <div className="flex items-center justify-center gap-3 mt-4">
              <button
                onClick={() => goTo(0)}
                disabled={stepIndex === 0}
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-lg transition"
                title="Start (Home)"
              >⏮</button>

              <button
                onClick={() => goTo(stepIndex - 1)}
                disabled={stepIndex === 0}
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-lg transition"
                title="Previous (←)"
              >◀</button>

              <button
                onClick={() => setIsPlaying(p => !p)}
                disabled={boards.length === 0}
                className="w-14 h-10 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-30 flex items-center justify-center text-xl transition"
                title="Play/Pause (Space)"
              >
                {isPlaying ? "⏸" : "▶"}
              </button>

              <button
                onClick={() => goTo(stepIndex + 1)}
                disabled={stepIndex >= boards.length - 1}
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-lg transition"
                title="Next (→)"
              >▶</button>

              <button
                onClick={() => goTo(boards.length - 1)}
                disabled={stepIndex >= boards.length - 1}
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-lg transition"
                title="End"
              >⏭</button>

              {/* Speed selector */}
              <select
                value={playSpeed}
                onChange={e => setPlaySpeed(Number(e.target.value))}
                className="ml-2 bg-slate-700 text-white text-xs rounded-lg px-2 py-2 border border-slate-600 focus:outline-none"
              >
                <option value={1500}>0.5×</option>
                <option value={800}>1×</option>
                <option value={400}>2×</option>
                <option value={150}>5×</option>
              </select>
            </div>

            {/* Keyboard hint */}
            <p className="text-center text-xs text-gray-600 mt-2">
              ← → arrow keys to step · Space to play/pause
            </p>
          </div>

          {/* Move list panel */}
          <div className="lg:col-span-1">
            <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 bg-white/5">
                <h2 className="font-semibold text-sm text-gray-300 uppercase tracking-wider">Move List</h2>
              </div>
              <div className="overflow-y-auto max-h-96 lg:max-h-[520px]">
                {/* Start row */}
                <div
                  onClick={() => goTo(0)}
                  className={`px-4 py-2 text-xs cursor-pointer transition ${
                    stepIndex === 0
                      ? "bg-purple-600/40 text-white"
                      : "text-gray-500 hover:bg-white/5"
                  }`}
                >
                  Start
                </div>

                {movePairs.map(([white, black], pairIdx) => {
                  const whiteStep = pairIdx * 2 + 1;
                  const blackStep = pairIdx * 2 + 2;
                  return (
                    <div key={pairIdx} className="flex text-sm border-t border-white/5">
                      {/* Move number */}
                      <div className="w-8 text-center py-2 text-gray-600 text-xs shrink-0 bg-white/3">
                        {pairIdx + 1}
                      </div>

                      {/* White move */}
                      <div
                        onClick={() => goTo(whiteStep)}
                        className={`flex-1 px-2 py-2 cursor-pointer font-mono text-xs transition ${
                          stepIndex === whiteStep
                            ? "bg-purple-600/40 text-white font-bold"
                            : "hover:bg-white/5 text-gray-300"
                        }`}
                      >
                        {getMoveLabel(white)}
                      </div>

                      {/* Black move */}
                      <div
                        onClick={() => black ? goTo(blackStep) : undefined}
                        className={`flex-1 px-2 py-2 font-mono text-xs transition ${
                          black
                            ? stepIndex === blackStep
                              ? "bg-purple-600/40 text-white font-bold cursor-pointer"
                              : "hover:bg-white/5 text-gray-300 cursor-pointer"
                            : "text-gray-700"
                        }`}
                      >
                        {black ? getMoveLabel(black) : ""}
                      </div>
                    </div>
                  );
                })}

                {/* Result row */}
                {game && (
                  <div className="px-4 py-3 border-t border-white/10 text-center text-xs text-gray-400">
                    {game.winner
                      ? `${game.winner.charAt(0).toUpperCase() + game.winner.slice(1)} wins by ${game.reason}`
                      : `Draw by ${game.reason}`}
                  </div>
                )}
              </div>
            </div>

            {/* Scrubber */}
            <div className="mt-4">
              <input
                type="range"
                min={0}
                max={boards.length - 1}
                value={stepIndex}
                onChange={e => goTo(Number(e.target.value))}
                className="w-full accent-purple-500"
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
