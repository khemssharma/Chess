import { Router } from "express";
import AuthController from "../controllers/authController";
import AuthMiddleware from "../middlewares/authMiddleware";
import GameController from "../controllers/gameController";
import AnalysisController from "../controllers/analysisController";
import AIController from "../controllers/aiController";

const router = Router();

router.post("/auth/register", AuthController.signup);
router.post("/auth/login", AuthController.login);
router.post("/auth/google", AuthController.googleLogin);
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

export default router;
