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
   * Returns full game details including move history for replay.
   * Requester must have been a participant (white, black, or the solo player in a computer game).
   */
  static getGameById = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });

      const game = await gameHistoryService.getGameById(req.params.gameId);
      if (!game) return res.status(404).json({ message: "Game not found" });

      const uid = Number(req.user.userId);
      const isParticipant =
        game.whiteUserId === uid ||
        game.blackUserId === uid ||
        game.isVsComputer;

      if (!isParticipant) {
        return res.status(403).json({ message: "Access denied" });
      }

      res.status(200).json({ game });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch game", error });
    }
  };
}

export default GameController;
