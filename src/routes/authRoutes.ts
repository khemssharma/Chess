import { Router } from "express";
import AuthController from "../controllers/authController.js";
import AuthMiddleware from "../middlewares/authMiddleware.js";
import { authRateLimiter } from "../middlewares/rateLimiters.js";
import GameController from "../controllers/gameController.js";
import AnalysisController from "../controllers/analysisController.js";
import AIController from "../controllers/aiController.js";
import PuzzleController from "../controllers/puzzleController.js";
import LeaderboardController from "../controllers/leaderboardController.js";

const router = Router();

router.post("/auth/register", authRateLimiter, AuthController.signup);
router.post("/auth/login", authRateLimiter, AuthController.login);
router.post("/auth/google", authRateLimiter, AuthController.googleLogin);
router.get("/auth/me", AuthMiddleware.authenticate, AuthController.getMe);

// Chess game history — protected routes
router.get("/games", AuthMiddleware.authenticate, GameController.getMyGames);
router.get("/games/:gameId", AuthMiddleware.authenticate, GameController.getGameById);

// Stockfish analysis — protected, computationally heavy, cached
router.post("/games/:gameId/analyze", AuthMiddleware.authenticate, AnalysisController.analyze);

// AI narrative analysis & chat — powered by OpenRouter
router.post("/games/:gameId/ai-analyze", AuthMiddleware.authenticate, AIController.generateAnalysis);
router.post("/games/:gameId/ai-chat", AuthMiddleware.authenticate, AIController.chat);
router.delete("/games/:gameId/ai-session", AuthMiddleware.authenticate, AIController.clearSession);

// Puzzles — rating-matched tactics training (Glicko-2 rated)
router.get("/puzzles/next", AuthMiddleware.authenticate, PuzzleController.getNext);
router.get("/puzzles/me", AuthMiddleware.authenticate, PuzzleController.getMyStats);
router.post("/puzzles/:puzzleId/attempt", AuthMiddleware.authenticate, PuzzleController.submitAttempt);

// Leaderboard — public
router.get("/leaderboard", LeaderboardController.getLeaderboard);

export default router;
