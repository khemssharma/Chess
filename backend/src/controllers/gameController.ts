import { Response } from "express";
import { AuthenticatedRequest } from "../utils/types";
import { gameHistoryService } from "../services/gameHistoryService";

class GameController {
  /**
   * GET /api/games
   * Returns all games for the authenticated user.
   */
  static getMyGames = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const games = await gameHistoryService.getGamesByUserId(req.user.userId);
      res.status(200).json({ games });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch games", error });
    }
  };

  /**
   * GET /api/games/:gameId
   * Returns full details (including move history) for one game.
   * The requester must have been a participant.
   */
  static getGameById = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const game = await gameHistoryService.getGameById(req.params.gameId);

      if (!game) return res.status(404).json({ message: "Game not found" });

      // Only participants can view the full game record
      if (
        game.whiteUserId !== req.user.userId &&
        game.blackUserId !== req.user.userId
      ) {
        return res.status(403).json({ message: "Access denied" });
      }

      res.status(200).json({ game });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch game", error });
    }
  };
}

export default GameController;
