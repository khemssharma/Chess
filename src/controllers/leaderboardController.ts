import { Request, Response } from "express";
import RatingService from "../services/ratingService.js";

class LeaderboardController {
  /** GET /api/leaderboard?type=game|puzzle — public, no auth needed */
  static getLeaderboard = async (req: Request, res: Response) => {
    try {
      const type = req.query.type === "puzzle" ? "puzzle" : "game";
      const leaderboard = await RatingService.getLeaderboard(type);
      res.json({ type, leaderboard });
    } catch (err) {
      console.error("leaderboard error:", err);
      res.status(500).json({ message: "Failed to fetch leaderboard" });
    }
  };
}

export default LeaderboardController;
