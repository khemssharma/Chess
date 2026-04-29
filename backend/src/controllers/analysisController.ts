import { Response } from "express";
import { AuthenticatedRequest } from "../utils/types";
import { gameHistoryService } from "../services/gameHistoryService";
import { analyzeGame } from "../services/analysisService";

// In-memory cache so we don't re-analyze the same game twice
const analysisCache = new Map<string, object>();

class AnalysisController {
  /**
   * POST /api/games/:gameId/analyze
   * Runs Stockfish analysis on every move and returns classifications + comments.
   * Results are cached in memory for the lifetime of the server process.
   */
  static analyze = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });

      const { gameId } = req.params;

      // Access check — must be a participant
      const game = await gameHistoryService.getGameById(gameId);
      if (!game) return res.status(404).json({ message: "Game not found" });

      const uid = Number(req.user.userId);
      const isParticipant =
        game.whiteUserId === uid ||
        game.blackUserId === uid ||
        game.isVsComputer;
      if (!isParticipant) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Return cached result if available
      if (analysisCache.has(gameId)) {
        return res.json({ analysis: analysisCache.get(gameId), cached: true });
      }

      const moves = game.moveHistory as { from: string; to: string; promotion?: string }[];
      if (!moves || moves.length === 0) {
        return res.status(400).json({ message: "No moves to analyze" });
      }

      console.log(`Starting analysis of game ${gameId} (${moves.length} moves)...`);
      const analysis = await analyzeGame(moves);

      analysisCache.set(gameId, analysis);
      console.log(`Analysis of game ${gameId} complete.`);

      res.json({ analysis });
    } catch (error) {
      console.error("Analysis error:", error);
      res.status(500).json({ message: "Analysis failed", error: String(error) });
    }
  };
}

export default AnalysisController;
