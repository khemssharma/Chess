import { prisma } from "../lib/prisma";
import { Chess } from "chess.js";
import { updateRating, GlickoRating } from "./glicko2";

/**
 * Puzzle format (lichess-style single line):
 *  - `fen`      — position with the SOLVER to move
 *  - `solution` — UCI moves alternating solver / opponent, e.g.
 *                 ["d2c2", "a2a3", "c4b3"]  (solver, opponent reply, solver mates)
 *  - even indices are the solver's moves, odd indices are auto-played replies
 */

class PuzzleService {
  /**
   * Pick the next puzzle for a user:
   *  1. prefer puzzles they haven't attempted yet
   *  2. rated within ±300 of their puzzle rating (rating-matched like lichess)
   *  3. random among candidates so it doesn't feel deterministic
   */
  async getNextPuzzle(userId: number) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error("User not found");

    const attempted = await prisma.puzzleAttempt.findMany({
      where: { userId },
      select: { puzzleId: true },
    });
    const attemptedIds = attempted.map((a: { puzzleId: number }) => a.puzzleId);

    const band = {
      gte: user.puzzleRating - 300,
      lte: user.puzzleRating + 300,
    };

    // fresh + in rating band → fresh anywhere → any puzzle (all solved: allow repeats)
    let candidates = await prisma.puzzle.findMany({
      where: { id: { notIn: attemptedIds }, rating: band },
      select: { id: true },
    });
    if (candidates.length === 0) {
      candidates = await prisma.puzzle.findMany({
        where: { id: { notIn: attemptedIds } },
        select: { id: true },
      });
    }
    if (candidates.length === 0) {
      candidates = await prisma.puzzle.findMany({ select: { id: true } });
    }
    if (candidates.length === 0) return null;

    const pickId = candidates[Math.floor(Math.random() * candidates.length)].id;
    const puzzle = await prisma.puzzle.findUnique({ where: { id: pickId } });
    if (!puzzle) return null;

    const chess = new Chess(puzzle.fen);
    return {
      id: puzzle.id,
      fen: puzzle.fen,
      solution: puzzle.solution as string[], // client validates locally; server re-verifies on submit
      playerColor: chess.turn() === "w" ? "white" : "black",
      rating: Math.round(puzzle.rating),
      themes: puzzle.themes,
      userPuzzleRating: Math.round(user.puzzleRating),
    };
  }

  /**
   * Record an attempt and update BOTH ratings with Glicko-2:
   *  - solving a puzzle = the user "beat" an opponent rated at the puzzle's rating
   *  - the puzzle's own rating also moves (fails make it stronger, solves weaker),
   *    which is exactly how lichess keeps puzzle difficulty calibrated
   *
   * Claimed solves are re-verified server-side by replaying the moves, so a
   * client can't just POST { solved: true } to farm rating.
   */
  async submitAttempt(userId: number, puzzleId: number, solved: boolean, moves: string[]) {
    const [user, puzzle] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.puzzle.findUnique({ where: { id: puzzleId } }),
    ]);
    if (!user || !puzzle) throw new Error("User or puzzle not found");

    if (solved && !this.verifySolution(puzzle.fen, puzzle.solution as string[], moves)) {
      throw new Error("Solution verification failed");
    }

    const userRating: GlickoRating = {
      rating: user.puzzleRating,
      ratingDeviation: user.puzzleRatingDeviation,
      volatility: user.puzzleVolatility,
    };
    const puzzleRating: GlickoRating = {
      rating: puzzle.rating,
      ratingDeviation: puzzle.ratingDeviation,
      volatility: puzzle.volatility,
    };

    const newUser = updateRating(userRating, [
      { opponent: puzzleRating, score: solved ? 1 : 0 },
    ]);
    const newPuzzle = updateRating(puzzleRating, [
      { opponent: userRating, score: solved ? 0 : 1 },
    ]);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          puzzleRating: newUser.rating,
          puzzleRatingDeviation: newUser.ratingDeviation,
          puzzleVolatility: newUser.volatility,
        },
      }),
      prisma.puzzle.update({
        where: { id: puzzleId },
        data: {
          rating: newPuzzle.rating,
          ratingDeviation: newPuzzle.ratingDeviation,
          volatility: newPuzzle.volatility,
          plays: { increment: 1 },
          solves: solved ? { increment: 1 } : undefined,
        },
      }),
      prisma.puzzleAttempt.create({
        data: {
          userId,
          puzzleId,
          solved,
          ratingBefore: userRating.rating,
          ratingAfter: newUser.rating,
        },
      }),
    ]);

    return {
      solved,
      ratingBefore: Math.round(userRating.rating),
      ratingAfter: Math.round(newUser.rating),
      ratingDelta: Math.round(newUser.rating - userRating.rating),
    };
  }

  /**
   * Replay the user's claimed moves against the stored solution.
   * Every even (solver) move must match the solution line — except the very
   * last move, where ANY legal checkmate is accepted (some positions have
   * more than one mate; punishing a valid mate would be unfair).
   */
  private verifySolution(fen: string, solution: string[], userMoves: string[]): boolean {
    const solverMoves = solution.filter((_, i) => i % 2 === 0);
    if (userMoves.length !== solverMoves.length) return false;

    try {
      const chess = new Chess(fen);
      for (let i = 0; i < solution.length; i++) {
        const isSolverMove = i % 2 === 0;
        const expected = solution[i];
        const played = isSolverMove ? userMoves[i / 2] : expected;

        if (isSolverMove && played !== expected) {
          // deviation only allowed if it's the final move AND it's checkmate
          const isLast = i === solution.length - 1;
          if (!isLast) return false;
          const m = this.tryMove(chess, played);
          return m !== null && chess.isCheckmate();
        }

        if (this.tryMove(chess, played) === null) return false;
      }
      return chess.isCheckmate();
    } catch {
      return false;
    }
  }

  private tryMove(chess: Chess, uciMove: string) {
    try {
      return chess.move({
        from: uciMove.slice(0, 2),
        to: uciMove.slice(2, 4),
        promotion: uciMove.length > 4 ? uciMove.slice(4) : undefined,
      });
    } catch {
      return null;
    }
  }

  /** User's puzzle dashboard numbers */
  async getUserStats(userId: number) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error("User not found");

    const [total, solvedCount, recent] = await Promise.all([
      prisma.puzzleAttempt.count({ where: { userId } }),
      prisma.puzzleAttempt.count({ where: { userId, solved: true } }),
      prisma.puzzleAttempt.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { solved: true, ratingAfter: true, createdAt: true, puzzleId: true },
      }),
    ]);

    // current solve streak
    let streak = 0;
    for (const a of recent) {
      if (a.solved) streak++;
      else break;
    }

    return {
      puzzleRating: Math.round(user.puzzleRating),
      ratingDeviation: Math.round(user.puzzleRatingDeviation),
      provisional: user.puzzleRatingDeviation > 110,
      totalAttempts: total,
      solved: solvedCount,
      accuracy: total > 0 ? Math.round((solvedCount / total) * 100) : 0,
      streak,
      recent,
    };
  }
}

export default new PuzzleService();
