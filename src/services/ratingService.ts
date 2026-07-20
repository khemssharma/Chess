import { prisma } from "../lib/prisma.js";
import { updatePair, GlickoRating } from "./glicko2.js";

interface RatedGameResult {
  gameId: string;
  whiteUserId: number;
  blackUserId: number;
  /** "white" | "black" | null (draw) */
  winner: string | null;
}

class RatingService {
  /**
   * Apply a Glicko-2 rating update to both players of a finished PvP game.
   * Called from GameHistoryService after the game row is written.
   * Also stamps before/after ratings onto the Game record so the history
   * screen can show "+12" / "-8" badges like lichess.
   */
  async applyGameResult({ gameId, whiteUserId, blackUserId, winner }: RatedGameResult) {
    const [white, black] = await Promise.all([
      prisma.user.findUnique({ where: { id: whiteUserId } }),
      prisma.user.findUnique({ where: { id: blackUserId } }),
    ]);
    if (!white || !black) return;

    const whiteRating: GlickoRating = {
      rating: white.rating,
      ratingDeviation: white.ratingDeviation,
      volatility: white.volatility,
    };
    const blackRating: GlickoRating = {
      rating: black.rating,
      ratingDeviation: black.ratingDeviation,
      volatility: black.volatility,
    };

    const scoreForWhite = winner === "white" ? 1 : winner === "black" ? 0 : 0.5;
    const { a: newWhite, b: newBlack } = updatePair(whiteRating, blackRating, scoreForWhite);

    // one transaction so a crash can't update one player but not the other
    await prisma.$transaction([
      prisma.user.update({
        where: { id: whiteUserId },
        data: {
          rating: newWhite.rating,
          ratingDeviation: newWhite.ratingDeviation,
          volatility: newWhite.volatility,
        },
      }),
      prisma.user.update({
        where: { id: blackUserId },
        data: {
          rating: newBlack.rating,
          ratingDeviation: newBlack.ratingDeviation,
          volatility: newBlack.volatility,
        },
      }),
      prisma.game.update({
        where: { id: gameId },
        data: {
          rated: true,
          whiteRatingBefore: whiteRating.rating,
          whiteRatingAfter: newWhite.rating,
          blackRatingBefore: blackRating.rating,
          blackRatingAfter: newBlack.rating,
        },
      }),
    ]);

    console.log(
      `Ratings updated for game ${gameId}: ` +
        `white ${Math.round(whiteRating.rating)} → ${Math.round(newWhite.rating)}, ` +
        `black ${Math.round(blackRating.rating)} → ${Math.round(newBlack.rating)}`
    );
  }

  /** Top players ordered by rating. type: "game" | "puzzle" */
  async getLeaderboard(type: "game" | "puzzle", limit = 50) {
    if (type === "puzzle") {
      const users = await prisma.user.findMany({
        orderBy: { puzzleRating: "desc" },
        take: limit,
        select: {
          id: true,
          username: true,
          avatar: true,
          puzzleRating: true,
          puzzleRatingDeviation: true,
          _count: { select: { puzzleAttempts: true } },
        },
      });
      return users.map((u: any, i: number) => ({
        rank: i + 1,
        id: u.id,
        username: u.username,
        avatar: u.avatar,
        rating: Math.round(u.puzzleRating),
        ratingDeviation: Math.round(u.puzzleRatingDeviation),
        // RD > 110 = "provisional" rating, shown with a "?" like lichess
        provisional: u.puzzleRatingDeviation > 110,
        played: u._count.puzzleAttempts,
      }));
    }

    const users = await prisma.user.findMany({
      orderBy: { rating: "desc" },
      take: limit,
      select: {
        id: true,
        username: true,
        avatar: true,
        rating: true,
        ratingDeviation: true,
        _count: { select: { gamesAsWhite: true, gamesAsBlack: true } },
      },
    });
    return users.map((u: any, i: number) => ({
      rank: i + 1,
      id: u.id,
      username: u.username,
      avatar: u.avatar,
      rating: Math.round(u.rating),
      ratingDeviation: Math.round(u.ratingDeviation),
      provisional: u.ratingDeviation > 110,
      played: u._count.gamesAsWhite + u._count.gamesAsBlack,
    }));
  }
}

export default new RatingService();
