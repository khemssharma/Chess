import { Response } from "express";
import { AuthenticatedRequest } from "../utils/types";
import PuzzleService from "../services/puzzleService";

class PuzzleController {
  /** GET /api/puzzles/next — rating-matched next puzzle for the logged-in user */
  static getNext = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const puzzle = await PuzzleService.getNextPuzzle(req.user!.userId);
      if (!puzzle) {
        return res.status(404).json({ message: "No puzzles available. Run the puzzle seed script." });
      }
      res.json(puzzle);
    } catch (err) {
      console.error("getNext puzzle error:", err);
      res.status(500).json({ message: "Failed to fetch puzzle" });
    }
  };

  /** POST /api/puzzles/:puzzleId/attempt — { solved: boolean, moves: string[] } */
  static submitAttempt = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const puzzleId = parseInt(req.params.puzzleId);
      const { solved, moves } = req.body as { solved: boolean; moves: string[] };

      if (isNaN(puzzleId) || typeof solved !== "boolean" || !Array.isArray(moves)) {
        return res.status(400).json({ message: "Invalid request body" });
      }

      const result = await PuzzleService.submitAttempt(req.user!.userId, puzzleId, solved, moves);
      res.json(result);
    } catch (err: any) {
      if (err.message === "Solution verification failed") {
        return res.status(400).json({ message: err.message });
      }
      console.error("submitAttempt error:", err);
      res.status(500).json({ message: "Failed to record attempt" });
    }
  };

  /** GET /api/puzzles/me — puzzle rating, accuracy, streak for the logged-in user */
  static getMyStats = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const stats = await PuzzleService.getUserStats(req.user!.userId);
      res.json(stats);
    } catch (err) {
      console.error("getMyStats error:", err);
      res.status(500).json({ message: "Failed to fetch puzzle stats" });
    }
  };
}

export default PuzzleController;
