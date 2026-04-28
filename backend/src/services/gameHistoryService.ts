import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient();

interface SaveGameResultParams {
  gameId: string;
  whiteUserId: number | null;
  blackUserId: number | null;
  fen: string;
  moveHistory: { from: string; to: string; promotion?: string }[];
  moveCount: number;
  timeControl: number | null;
  winner: string | null;
  reason: string;
  isVsComputer?: boolean;
  computerDifficulty?: string;
}

class GameHistoryService {
  /**
   * Persist a finished game to the database.
   * Called automatically when any game ends (checkmate, timeout, draw, etc.)
   */
  async saveGameResult(params: SaveGameResultParams): Promise<void> {
    await prisma.game.create({
      data: {
        id: params.gameId,
        whiteUserId: params.whiteUserId,
        blackUserId: params.blackUserId,
        fen: params.fen,
        moveHistory: params.moveHistory as any,
        moveCount: params.moveCount,
        timeControl: params.timeControl,
        isVsComputer: params.isVsComputer ?? false,
        computerDifficulty: params.computerDifficulty ?? null,
        status: "over",
        winner: params.winner,
        reason: params.reason,
        finishedAt: new Date(),
      },
    });

    console.log(
      `Game ${params.gameId} saved to DB — winner: ${params.winner}, reason: ${params.reason}, vsComputer: ${params.isVsComputer ?? false}`
    );
  }

  /**
   * Fetch all games for a given user (as white or black). List view only.
   */
  async getGamesByUserId(userId: number) {
    return prisma.game.findMany({
      where: {
        OR: [{ whiteUserId: userId }, { blackUserId: userId }],
      },
      select: {
        id: true,
        whiteUserId: true,
        blackUserId: true,
        whiteUser: { select: { id: true, username: true } },
        blackUser: { select: { id: true, username: true } },
        moveCount: true,
        timeControl: true,
        status: true,
        winner: true,
        reason: true,
        isVsComputer: true,
        computerDifficulty: true,
        startedAt: true,
        finishedAt: true,
      },
      orderBy: { startedAt: "desc" },
    });
  }

  /**
   * Fetch a single game by ID with full move history for replay.
   */
  async getGameById(gameId: string) {
    return prisma.game.findUnique({
      where: { id: gameId },
      include: {
        whiteUser: { select: { id: true, username: true } },
        blackUser: { select: { id: true, username: true } },
      },
    });
  }
}

export const gameHistoryService = new GameHistoryService();
