import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Chess, Square } from "chess.js";
import { PuzzleService, PuzzleData, AttemptResult, PuzzleStats } from "../services/puzzleService";

type Phase = "loading" | "solving" | "wrong" | "solved" | "failed" | "error";

const themeLabel: Record<string, string> = {
  mateIn1: "Mate in 1",
  mateIn2: "Mate in 2",
};

export const Puzzles = () => {
  const chessRef = useRef(new Chess());
  const [puzzle, setPuzzle] = useState<PuzzleData | null>(null);
  const [board, setBoard] = useState(chessRef.current.board());
  const [phase, setPhase] = useState<Phase>("loading");
  const [from, setFrom] = useState<Square | null>(null);
  const [solutionIdx, setSolutionIdx] = useState(0); // index into puzzle.solution
  const [userMoves, setUserMoves] = useState<string[]>([]);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [stats, setStats] = useState<PuzzleStats | null>(null);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const loadStats = useCallback(async () => {
    try {
      const statsData = await PuzzleService.getMyStats();
      setStats(statsData);
    } catch { /* non-critical */ }
  }, []);

  const loadPuzzle = useCallback(async () => {
    setPhase("loading");
    setResult(null);
    setFrom(null);
    setUserMoves([]);
    setSolutionIdx(0);
    setLastMove(null);
    try {
      const data = await PuzzleService.getNextPuzzle();
      chessRef.current = new Chess(data.fen);
      setBoard(chessRef.current.board());
      setPuzzle(data);
      setPhase("solving");
    } catch (err: any) {
      setErrorMsg(err.message || "Network error");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    loadPuzzle();
    loadStats();
  }, [loadPuzzle, loadStats]);

  const submitAttempt = async (solved: boolean, moves: string[]) => {
    if (!puzzle) return;
    try {
      const resultData = await PuzzleService.submitAttempt(puzzle.id, solved, moves);
      setResult(resultData);
      loadStats();
    } catch { /* rating update failed silently — puzzle UX still works */ }
  };

  const playOpponentReply = (idx: number) => {
    if (!puzzle) return;
    const reply = puzzle.solution[idx];
    setTimeout(() => {
      const chess = chessRef.current;
      chess.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply.slice(4) || undefined });
      setBoard(chess.board());
      setLastMove({ from: reply.slice(0, 2), to: reply.slice(2, 4) });
      setSolutionIdx(idx + 1);
    }, 350);
  };

  const handleUserMove = (fromSq: Square, toSq: Square) => {
    if (!puzzle || phase !== "solving") return;
    const chess = chessRef.current;

    // promotions: auto-queen (seed puzzles contain none, lichess imports may)
    const piece = chess.get(fromSq);
    const needsPromotion =
      piece?.type === "p" && (toSq[1] === "8" || toSq[1] === "1");
    const uciMove = fromSq + toSq + (needsPromotion ? "q" : "");

    let moved;
    try {
      moved = chess.move({ from: fromSq, to: toSq, promotion: needsPromotion ? "q" : undefined });
    } catch {
      return; // illegal — ignore
    }
    if (!moved) return;

    const expected = puzzle.solution[solutionIdx];
    const isLastSolverMove = solutionIdx === puzzle.solution.length - 1;
    const correct =
      uciMove === expected || (isLastSolverMove && chess.isCheckmate());

    setBoard(chess.board());
    setLastMove({ from: fromSq, to: toSq });
    setFrom(null);

    if (!correct) {
      // wrong move — puzzle failed, record it, then show the solution
      setPhase("wrong");
      submitAttempt(false, [...userMoves, uciMove]);
      setTimeout(() => {
        chess.undo();
        setBoard(chess.board());
        setLastMove(null);
        setPhase("failed");
      }, 700);
      return;
    }

    const newUserMoves = [...userMoves, uciMove];
    setUserMoves(newUserMoves);

    if (isLastSolverMove || solutionIdx + 1 >= puzzle.solution.length) {
      setPhase("solved");
      submitAttempt(true, newUserMoves);
    } else {
      setSolutionIdx(solutionIdx + 1);
      playOpponentReply(solutionIdx + 1);
    }
  };

  const revealSolution = () => {
    if (!puzzle) return;
    const chess = new Chess(puzzle.fen);
    for (const mv of puzzle.solution) {
      chess.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv.slice(4) || undefined });
    }
    chessRef.current = chess;
    setBoard(chess.board());
    const last = puzzle.solution[puzzle.solution.length - 1];
    setLastMove({ from: last.slice(0, 2), to: last.slice(2, 4) });
  };

  const handleSquareClick = (sq: Square) => {
    if (phase !== "solving" || !puzzle) return;
    const chess = chessRef.current;
    const piece = chess.get(sq);
    const myColor = puzzle.playerColor === "white" ? "w" : "b";

    if (!from) {
      if (piece && piece.color === myColor) setFrom(sq);
    } else if (sq === from) {
      setFrom(null);
    } else if (piece && piece.color === myColor) {
      setFrom(sq); // switch selection
    } else {
      handleUserMove(from, sq);
    }
  };

  // Render board oriented for the solver
  const rows = puzzle?.playerColor === "black" ? [...board].reverse().map(r => [...r].reverse()) : board;

  const squareName = (i: number, j: number): Square => {
    const flipped = puzzle?.playerColor === "black";
    const file = "abcdefgh"[flipped ? 7 - j : j];
    const rank = flipped ? i + 1 : 8 - i;
    return (file + rank) as Square;
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* Nav */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
        <h1 className="text-xl font-bold">Puzzles</h1>
        <div className="flex gap-4 text-sm text-slate-300">
          <Link to="/game" className="hover:text-white">Play</Link>
          <Link to="/history" className="hover:text-white">History</Link>
          <Link to="/leaderboard" className="hover:text-white">Leaderboard</Link>
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Board */}
        <div className="lg:col-span-2">
          {phase === "loading" && (
            <div className="aspect-square max-w-[560px] flex items-center justify-center text-slate-400">
              Loading puzzle…
            </div>
          )}
          {phase === "error" && (
            <div className="aspect-square max-w-[560px] flex flex-col items-center justify-center gap-4 text-slate-400">
              <p>{errorMsg}</p>
              <button onClick={loadPuzzle} className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded">Retry</button>
            </div>
          )}
          {phase !== "loading" && phase !== "error" && puzzle && (
            <div className="max-w-[560px] select-none">
              {rows.map((row, i) => (
                <div key={i} className="flex">
                  {row.map((sq, j) => {
                    const name = squareName(i, j);
                    const dark = (i + j) % 2 === 1;
                    const isSelected = from === name;
                    const isLast = lastMove && (lastMove.from === name || lastMove.to === name);
                    return (
                      <div
                        key={j}
                        onClick={() => handleSquareClick(name)}
                        className={`w-full aspect-square flex items-center justify-center cursor-pointer
                          ${dark ? "bg-green-700" : "bg-green-100"}
                          ${isSelected ? "ring-4 ring-yellow-400 ring-inset" : ""}
                          ${isLast ? "brightness-110 outline outline-2 outline-yellow-500/60 -outline-offset-2" : ""}`}
                      >
                        {sq && (
                          <img
                            className="w-3/5 pointer-events-none"
                            src={`/${sq.color === "b" ? sq.type : `${sq.type.toUpperCase()} copy`}.png`}
                            alt={`${sq.color}${sq.type}`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Side panel */}
        <div className="space-y-4">
          {stats && (
            <div className="bg-slate-900 rounded-lg p-4 border border-slate-800">
              <div className="text-3xl font-bold">
                {stats.puzzleRating}
                {stats.provisional && <span className="text-slate-500 text-xl">?</span>}
              </div>
              <div className="text-slate-400 text-sm mb-3">Puzzle Rating (Glicko-2)</div>
              <div className="grid grid-cols-3 gap-2 text-center text-sm">
                <div><div className="font-bold">{stats.totalAttempts}</div><div className="text-slate-500">Played</div></div>
                <div><div className="font-bold">{stats.accuracy}%</div><div className="text-slate-500">Accuracy</div></div>
                <div><div className="font-bold">{stats.streak}🔥</div><div className="text-slate-500">Streak</div></div>
              </div>
            </div>
          )}

          {puzzle && (
            <div className="bg-slate-900 rounded-lg p-4 border border-slate-800 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Theme</span>
                <span className="font-semibold">{themeLabel[puzzle.themes] || puzzle.themes.split(",")[0]}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Puzzle rating</span>
                <span className="font-semibold">{puzzle.rating}</span>
              </div>

              {phase === "solving" && (
                <div className="text-center py-2 text-yellow-400 font-semibold">
                  {puzzle.playerColor === "white" ? "White" : "Black"} to move — find the best move!
                </div>
              )}
              {phase === "wrong" && (
                <div className="text-center py-2 text-red-400 font-semibold">That's not it…</div>
              )}
              {phase === "solved" && (
                <div className="text-center py-2">
                  <div className="text-green-400 font-bold text-lg">Solved! 🎉</div>
                  {result && (
                    <div className={`text-sm mt-1 ${result.ratingDelta >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {result.ratingBefore} → {result.ratingAfter} ({result.ratingDelta >= 0 ? "+" : ""}{result.ratingDelta})
                    </div>
                  )}
                </div>
              )}
              {phase === "failed" && (
                <div className="text-center py-2">
                  <div className="text-red-400 font-bold">Incorrect</div>
                  {result && (
                    <div className="text-sm mt-1 text-red-400">
                      {result.ratingBefore} → {result.ratingAfter} ({result.ratingDelta})
                    </div>
                  )}
                  <button onClick={revealSolution} className="mt-2 text-sm text-blue-400 hover:underline">
                    Show solution
                  </button>
                </div>
              )}

              {(phase === "solved" || phase === "failed") && (
                <button
                  onClick={loadPuzzle}
                  className="w-full bg-blue-600 hover:bg-blue-700 py-2 rounded font-semibold"
                >
                  Next Puzzle →
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
