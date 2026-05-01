import { Router } from "express";
import AuthController from "../controllers/authController";
import AuthMiddleware from "../middlewares/authMiddleware";
import GameController from "../controllers/gameController";
import AnalysisController from "../controllers/analysisController";

const router = Router();

router.post("/auth/register", AuthController.signup);
router.post("/auth/login", AuthController.login);
router.post("/auth/google", AuthController.googleLogin);
router.get("/auth/me", AuthMiddleware.authenticate, AuthController.getMe);

// Chess game history — protected routes
router.get("/games", AuthMiddleware.authenticate, GameController.getMyGames);
router.get("/games/:gameId", AuthMiddleware.authenticate, GameController.getGameById);

// Game analysis — protected, computationally heavy, cached
router.post("/games/:gameId/analyze", AuthMiddleware.authenticate, AnalysisController.analyze);

export default router;
