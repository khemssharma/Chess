import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Chess } from "chess.js";
import ChessAIAssistant from "../components/ChessAIAssistant";

const API_URL = (import.meta.env.VITE_API_URL as string) || "http://localhost:3000";

interface Move { from: string; to: string; promotion?: string; }

interface MoveAnalysis {
  moveIndex: number;
  move: string;
  san: string;
  color: "white" | "black";
  evalBefore: number;
  evalAfter: number;
  evalDelta: number;
  bestMove: string;
  classification: "brilliant" | "great" | "good" | "book" | "inaccuracy" | "mistake" | "blunder" | "forced";
  comment: string;
  isMate: boolean;
  mateIn?: number;
}

interface GameAnalysis {
  moves: MoveAnalysis[];
  whiteAccuracy: number;
  blackAccuracy: number;
  whiteMistakes: number;
  whiteBlunders: number;
  blackMistakes: number;
  blackBlunders: number;
  whiteInaccuracies: number;
  blackInaccuracies: number;
}

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

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

const CLASS_META: Record<string, { label: string; color: string; bg: string; emoji: string }> = {
  brilliant: { label: "Brilliant", color: "text-cyan-300",   bg: "bg-cyan-500",   emoji: "✨" },
  great:     { label: "Great",     color: "text-blue-300",   bg: "bg-blue-500",   emoji: "🔵" },
  good:      { label: "Good",      color: "text-green-300",  bg: "bg-green-500",  emoji: "✅" },
  book:      { label: "Book",      color: "text-gray-300",   bg: "bg-gray-500",   emoji: "📖" },
  inaccuracy:{ label: "Inaccuracy",color: "text-yellow-300", bg: "bg-yellow-500", emoji: "⚠️" },
  mistake:   { label: "Mistake",   color: "text-orange-300", bg: "bg-orange-500", emoji: "❌" },
  blunder:   { label: "Blunder",   color: "text-red-400",    bg: "bg-red-500",    emoji: "??"},
  forced:    { label: "Forced",    color: "text-gray-300",   bg: "bg-gray-500",   emoji: "→" },
};

// Clamp eval to ±1000cp for display, convert to bar percentage (0–100, 50=equal)
function evalToPercent(cp: number, isMate: boolean, mateIn?: number): number {
  if (isMate) return mateIn && mateIn > 0 ? 95 : 5;
  const clamped = Math.max(-1000, Math.min(1000, cp));
  return 50 + (clamped / 1000) * 45;
}

function evalLabel(cp: number, isMate: boolean, mateIn?: number): string {
  if (isMate) return mateIn ? `M${Math.abs(mateIn)}` : "Mate";
  const pawns = cp / 100;
  return (pawns >= 0 ? "+" : "") + pawns.toFixed(1);
}

export const GameReplay = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const moveListRef = useRef<HTMLDivElement>(null);

  const [game, setGame] = useState<FullGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Replay state
  const [stepIndex, setStepIndex] = useState(0);
  const [boards, setBoards] = useState<ReturnType<Chess["board"]>[]>([]);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(800);

  // Analysis state
  const [analysis, setAnalysis] = useState<GameAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");

  // Build board snapshots
  useEffect(() => {
    if (!game) return;
    const chess = new Chess();
    const snapshots: ReturnType<Chess["board"]>[] = [chess.board()];
    for (const move of game.moveHistory as Move[]) {
      try { chess.move(move); snapshots.push(chess.board()); } catch { break; }
    }
    setBoards(snapshots);
    setStepIndex(0);
  }, [game]);

  useEffect(() => {
    if (!token) { navigate("/login"); return; }
    fetch(`${API_URL}/api/games/${gameId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { if (data.game) setGame(data.game); else setError(data.message || "Game not found"); })
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

  // Scroll active move into view
  useEffect(() => {
    if (!moveListRef.current) return;
    const active = moveListRef.current.querySelector("[data-active='true']");
    if (active) active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [stepIndex]);

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

  const requestAnalysis = async () => {
    if (!token || analyzing) return;
    setAnalyzing(true);
    setAnalysisError("");
    try {
      const res = await fetch(`${API_URL}/api/games/${gameId}/analyze`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      const data = await res.json();
      if (data.analysis) {
        setAnalysis(data.analysis);
      } else {
        setAnalysisError(data.message || "Analysis failed");
      }
    } catch {
      setAnalysisError("Analysis request failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const board = boards[stepIndex] ?? [];
  const moves = game ? (game.moveHistory as Move[]) : [];
  const myColor = game?.whiteUser?.id === user?.id ? "white" : "black";
  const viewFromWhite = myColor === "white";

  const displayBoard = viewFromWhite
    ? board
    : [...board].reverse().map(row => [...row].reverse());

  const opponentName = game
    ? game.isVsComputer
      ? `🤖 Stockfish${game.computerDifficulty ? ` (${game.computerDifficulty})` : ""}`
      : myColor === "white" ? (game.blackUser?.username ?? "Guest") : (game.whiteUser?.username ?? "Guest")
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

  // Current move analysis (stepIndex 1-based in analysis array)
  const currentMoveAnalysis: MoveAnalysis | null =
    analysis && stepIndex > 0 ? analysis.moves[stepIndex - 1] ?? null : null;

  // Eval bar value at current step
  const currentEval = stepIndex === 0
    ? 0
    : analysis
      ? analysis.moves[stepIndex - 1]?.evalAfter ?? 0
      : 0;
  const currentIsMate = stepIndex > 0 && !!analysis?.moves[stepIndex - 1]?.isMate;
  const currentMateIn = analysis?.moves[stepIndex - 1]?.mateIn;
  const evalPct = evalToPercent(currentEval, currentIsMate, currentMateIn);

  // Move pairs for move list
  const movePairs: [Move, Move | null][] = [];
  for (let i = 0; i < moves.length; i += 2) movePairs.push([moves[i], moves[i + 1] ?? null]);

  const getMoveLabel = (m: Move) => `${m.from}${m.to}${m.promotion ? m.promotion.toUpperCase() : ""}`;

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
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-3xl">♔</span>
            <span className="text-xl font-bold">ChessMaster</span>
          </Link>
          <button onClick={() => navigate("/history")} className="text-gray-400 hover:text-white text-sm transition flex items-center gap-1">
            ← Game History
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Game header */}
        {game && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">
                {user?.username} <span className="text-gray-400">vs</span> {opponentName}
              </h1>
              <p className="text-sm text-gray-400 mt-1">
                {game.timeControl ? `${game.timeControl} min` : "Unlimited"} · {game.moveCount} moves · {game.reason ?? "—"} · {game.finishedAt ? formatDate(game.finishedAt) : formatDate(game.startedAt)}
              </p>
            </div>
            <div className="flex items-center gap-4">
              <div className={`text-2xl font-bold ${resultColor()}`}>{resultLabel()}</div>
              {!analysis && !analyzing && (
                <button
                  onClick={requestAnalysis}
                  className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-bold px-5 py-2 rounded-xl text-sm transition-all flex items-center gap-2"
                >
                  🔍 Analyse Game
                </button>
              )}
              {analyzing && (
                <div className="flex items-center gap-2 text-purple-300 text-sm animate-pulse">
                  <span>⚙️</span> Analysing... (this may take a minute)
                </div>
              )}
            </div>
          </div>
        )}

        {analysisError && (
          <div className="mb-4 bg-red-500/20 border border-red-500/40 text-red-300 rounded-lg px-4 py-3 text-sm">
            {analysisError}
          </div>
        )}

        {/* Analysis summary bar */}
        {analysis && (
          <div className="mb-5 bg-white/5 border border-white/10 rounded-xl p-4">
            <div className="grid grid-cols-2 gap-6">
              {/* White accuracy */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-sm font-semibold text-white flex items-center gap-1">⚪ {game?.whiteUser?.username ?? (myColor === "white" ? user?.username : "Computer")}</span>
                  <span className="text-lg font-bold text-white">{analysis.whiteAccuracy}%</span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-2 mb-2">
                  <div className="bg-gradient-to-r from-red-500 via-yellow-500 to-green-500 h-2 rounded-full transition-all" style={{ width: `${analysis.whiteAccuracy}%` }} />
                </div>
                <div className="flex gap-3 text-xs text-gray-400">
                  <span className="text-cyan-400">✨ {analysis.moves.filter(m => m.color === "white" && m.classification === "brilliant").length} brilliant</span>
                  <span className="text-yellow-400">⚠️ {analysis.whiteInaccuracies} inaccuracy</span>
                  <span className="text-orange-400">❌ {analysis.whiteMistakes} mistake</span>
                  <span className="text-red-400">?? {analysis.whiteBlunders} blunder</span>
                </div>
              </div>
              {/* Black accuracy */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-sm font-semibold text-white flex items-center gap-1">⚫ {game?.blackUser?.username ?? (myColor === "black" ? user?.username : opponentName)}</span>
                  <span className="text-lg font-bold text-white">{analysis.blackAccuracy}%</span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-2 mb-2">
                  <div className="bg-gradient-to-r from-red-500 via-yellow-500 to-green-500 h-2 rounded-full transition-all" style={{ width: `${analysis.blackAccuracy}%` }} />
                </div>
                <div className="flex gap-3 text-xs text-gray-400">
                  <span className="text-cyan-400">✨ {analysis.moves.filter(m => m.color === "black" && m.classification === "brilliant").length} brilliant</span>
                  <span className="text-yellow-400">⚠️ {analysis.blackInaccuracies} inaccuracy</span>
                  <span className="text-orange-400">❌ {analysis.blackMistakes} mistake</span>
                  <span className="text-red-400">?? {analysis.blackBlunders} blunder</span>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* ── Left: Eval bar + Board + Controls ─────────────────────────── */}
          <div className="lg:col-span-2 flex flex-col gap-4">

            {/* Opponent label */}
            <div className="flex items-center justify-between px-1">
              <span className="text-sm text-gray-400">{viewFromWhite ? opponentName : user?.username}</span>
              {analysis && (
                <span className={`text-xs font-mono ${viewFromWhite ? "text-gray-300" : "text-gray-300"}`}>
                  {viewFromWhite ? `${analysis.blackAccuracy}%` : `${analysis.whiteAccuracy}%`}
                </span>
              )}
            </div>

            {/* Board + eval bar row */}
            <div className="flex gap-3 items-stretch">

              {/* Vertical eval bar */}
              <div className="flex flex-col w-4 rounded-lg overflow-hidden relative shrink-0" style={{ minHeight: "320px" }}>
                {/* White section (top = black winning, bottom = white winning) */}
                <div
                  className="w-full bg-slate-800 transition-all duration-500"
                  style={{ height: `${100 - evalPct}%` }}
                />
                <div
                  className="w-full bg-white transition-all duration-500"
                  style={{ height: `${evalPct}%` }}
                />
              </div>

              {/* Eval label */}
              <div className="flex flex-col justify-center w-8 shrink-0">
                <span className="text-xs font-mono text-gray-400 text-center">
                  {stepIndex > 0 || analysis ? evalLabel(currentEval, currentIsMate, currentMateIn) : "0.0"}
                </span>
              </div>

              {/* Board */}
              <div className="flex-1">
                {/* File labels top */}
                <div className="flex pl-0 text-xs text-gray-500 select-none mb-0.5">
                  {(viewFromWhite ? FILES : [...FILES].reverse()).map(f => (
                    <div key={f} className="flex-1 text-center">{f}</div>
                  ))}
                </div>

                <div className="flex">
                  {/* Rank labels */}
                  <div className="flex flex-col justify-around pr-1 text-xs text-gray-500 select-none">
                    {(viewFromWhite ? [8,7,6,5,4,3,2,1] : [1,2,3,4,5,6,7,8]).map(r => (
                      <div key={r} style={{ height: `${100/8}%` }} className="flex items-center">{r}</div>
                    ))}
                  </div>

                  {/* Squares */}
                  <div className="flex-1 aspect-square">
                    {displayBoard.map((row, i) => (
                      <div key={i} className="flex w-full" style={{ height: `${100/8}%` }}>
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
                              {/* Classification dot overlay on last move destination */}
                              {isLastTo && currentMoveAnalysis && (
                                <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full ${CLASS_META[currentMoveAnalysis.classification]?.bg ?? ""} border border-black/30 text-[8px] flex items-center justify-center`} />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex pl-0 text-xs text-gray-500 select-none mt-0.5">
                  {(viewFromWhite ? FILES : [...FILES].reverse()).map(f => (
                    <div key={f} className="flex-1 text-center">{f}</div>
                  ))}
                </div>
              </div>
            </div>

            {/* My label */}
            <div className="flex items-center justify-between px-1">
              <span className="text-sm text-gray-400">{viewFromWhite ? user?.username : opponentName}</span>
              {analysis && (
                <span className="text-xs font-mono text-gray-300">
                  {viewFromWhite ? `${analysis.whiteAccuracy}%` : `${analysis.blackAccuracy}%`}
                </span>
              )}
            </div>

            {/* Step label */}
            <div className="text-center text-gray-400 text-sm">
              {stepIndex === 0 ? "Starting position" : `Move ${stepIndex} of ${moves.length}`}
            </div>

            {/* Controls */}
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => goTo(0)} disabled={stepIndex === 0}
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-lg transition">⏮</button>
              <button onClick={() => goTo(stepIndex - 1)} disabled={stepIndex === 0}
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-lg transition">◀</button>
              <button onClick={() => setIsPlaying(p => !p)} disabled={boards.length === 0}
                className="w-14 h-10 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-30 flex items-center justify-center text-xl transition">
                {isPlaying ? "⏸" : "▶"}
              </button>
              <button onClick={() => goTo(stepIndex + 1)} disabled={stepIndex >= boards.length - 1}
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-lg transition">▶</button>
              <button onClick={() => goTo(boards.length - 1)} disabled={stepIndex >= boards.length - 1}
                className="w-10 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-lg transition">⏭</button>
              <select value={playSpeed} onChange={e => setPlaySpeed(Number(e.target.value))}
                className="ml-2 bg-slate-700 text-white text-xs rounded-lg px-2 py-2 border border-slate-600 focus:outline-none">
                <option value={1500}>0.5×</option>
                <option value={800}>1×</option>
                <option value={400}>2×</option>
                <option value={150}>5×</option>
              </select>
            </div>

            {/* Scrubber */}
            <input type="range" min={0} max={boards.length - 1} value={stepIndex}
              onChange={e => goTo(Number(e.target.value))}
              className="w-full accent-purple-500" />

            <p className="text-center text-xs text-gray-600">← → arrow keys to step · Space to play/pause</p>

            {/* Current move analysis comment */}
            {currentMoveAnalysis && (
              <div className={`rounded-xl p-4 border ${
                currentMoveAnalysis.classification === "blunder" ? "bg-red-500/10 border-red-500/30" :
                currentMoveAnalysis.classification === "mistake" ? "bg-orange-500/10 border-orange-500/30" :
                currentMoveAnalysis.classification === "inaccuracy" ? "bg-yellow-500/10 border-yellow-500/30" :
                currentMoveAnalysis.classification === "brilliant" ? "bg-cyan-500/10 border-cyan-500/30" :
                "bg-white/5 border-white/10"
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">{CLASS_META[currentMoveAnalysis.classification]?.emoji}</span>
                  <span className={`font-bold text-sm ${CLASS_META[currentMoveAnalysis.classification]?.color}`}>
                    {CLASS_META[currentMoveAnalysis.classification]?.label}
                  </span>
                  <span className="text-white font-mono font-bold">{currentMoveAnalysis.san}</span>
                  <span className="ml-auto text-xs font-mono text-gray-400">
                    {evalLabel(currentMoveAnalysis.evalAfter, currentMoveAnalysis.isMate, currentMoveAnalysis.mateIn)}
                  </span>
                </div>
                <p className="text-sm text-gray-300 leading-relaxed">{currentMoveAnalysis.comment}</p>
                {currentMoveAnalysis.bestMove && currentMoveAnalysis.bestMove !== currentMoveAnalysis.move && (
                  <p className="text-xs text-gray-500 mt-2">Best: <span className="font-mono text-purple-400">{currentMoveAnalysis.bestMove}</span></p>
                )}
              </div>
            )}
          </div>

          {/* ── Right: Move list panel ─────────────────────────────────────── */}
          <div className="lg:col-span-1 flex flex-col gap-4">

            {/* Eval sparkline chart */}
            {analysis && analysis.moves.length > 0 && (
              <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Evaluation</p>
                <svg viewBox={`0 0 ${analysis.moves.length} 100`} className="w-full h-16" preserveAspectRatio="none">
                  {/* Zero line */}
                  <line x1="0" y1="50" x2={analysis.moves.length} y2="50" stroke="#334155" strokeWidth="0.5" />
                  {/* Eval area */}
                  <polyline
                    points={[
                      "0,50",
                      ...analysis.moves.map((m, i) => `${i + 1},${100 - evalToPercent(m.evalAfter, m.isMate, m.mateIn)}`),
                    ].join(" ")}
                    fill="none"
                    stroke="#a855f7"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Current position marker */}
                  {stepIndex > 0 && (
                    <line
                      x1={stepIndex} y1="0" x2={stepIndex} y2="100"
                      stroke="#e879f9" strokeWidth="1"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </svg>
              </div>
            )}

            {/* Move list */}
            <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden flex-1">
              <div className="px-4 py-3 border-b border-white/10 bg-white/5 flex items-center justify-between">
                <h2 className="font-semibold text-sm text-gray-300 uppercase tracking-wider">Moves</h2>
                {analysis && <span className="text-xs text-purple-400">Analysis active</span>}
              </div>

              <div ref={moveListRef} className="overflow-y-auto max-h-80 lg:max-h-[420px]">
                {/* Start row */}
                <div
                  onClick={() => goTo(0)}
                  data-active={stepIndex === 0}
                  className={`px-4 py-2 text-xs cursor-pointer transition ${stepIndex === 0 ? "bg-purple-600/40 text-white" : "text-gray-500 hover:bg-white/5"}`}
                >
                  Start
                </div>

                {movePairs.map(([white, black], pairIdx) => {
                  const whiteStep = pairIdx * 2 + 1;
                  const blackStep = pairIdx * 2 + 2;
                  const whiteAnalysis = analysis?.moves[whiteStep - 1];
                  const blackAnalysis = black ? analysis?.moves[blackStep - 1] : undefined;

                  return (
                    <div key={pairIdx} className="flex text-sm border-t border-white/5">
                      {/* Move number */}
                      <div className="w-8 text-center py-2 text-gray-600 text-xs shrink-0">{pairIdx + 1}</div>

                      {/* White move */}
                      <div
                        onClick={() => goTo(whiteStep)}
                        data-active={stepIndex === whiteStep}
                        className={`flex-1 px-2 py-2 cursor-pointer font-mono text-xs transition flex items-center gap-1 ${stepIndex === whiteStep ? "bg-purple-600/40 text-white font-bold" : "hover:bg-white/5 text-gray-300"}`}
                      >
                        {whiteAnalysis && (
                          <span title={CLASS_META[whiteAnalysis.classification]?.label} className="text-[10px]">
                            {CLASS_META[whiteAnalysis.classification]?.emoji}
                          </span>
                        )}
                        {getMoveLabel(white)}
                      </div>

                      {/* Black move */}
                      <div
                        onClick={() => black ? goTo(blackStep) : undefined}
                        data-active={stepIndex === blackStep}
                        className={`flex-1 px-2 py-2 font-mono text-xs transition flex items-center gap-1 ${
                          black
                            ? stepIndex === blackStep
                              ? "bg-purple-600/40 text-white font-bold cursor-pointer"
                              : "hover:bg-white/5 text-gray-300 cursor-pointer"
                            : "text-gray-700"
                        }`}
                      >
                        {black && blackAnalysis && (
                          <span title={CLASS_META[blackAnalysis.classification]?.label} className="text-[10px]">
                            {CLASS_META[blackAnalysis.classification]?.emoji}
                          </span>
                        )}
                        {black ? getMoveLabel(black) : ""}
                      </div>
                    </div>
                  );
                })}

                {/* Result */}
                {game && (
                  <div className="px-4 py-3 border-t border-white/10 text-center text-xs text-gray-400">
                    {game.winner
                      ? `${game.winner.charAt(0).toUpperCase() + game.winner.slice(1)} wins by ${game.reason}`
                      : `Draw by ${game.reason}`}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* AI Chess Coach — only shown when Stockfish analysis is available */}
      {analysis && game && token && (
        <ChessAIAssistant
          gameId={gameId!}
          token={token}
          analysis={analysis}
          gameInfo={{
            whitePlayer: game.whiteUser?.username ?? (myColor === "white" ? user?.username ?? "White" : opponentName),
            blackPlayer: game.blackUser?.username ?? (myColor === "black" ? user?.username ?? "Black" : opponentName),
            result: game.winner
              ? `${game.winner.charAt(0).toUpperCase() + game.winner.slice(1)} wins by ${game.reason}`
              : `Draw by ${game.reason}`,
            moveCount: moves.length,
          }}
          currentMoveAnalysis={currentMoveAnalysis}
        />
      )}
    </div>
  );
};
