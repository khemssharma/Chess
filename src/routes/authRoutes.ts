import { Router } from "express";
import AuthController from "../controllers/authController";
import AuthMiddleware from "../middlewares/authMiddleware";
import GameController from "../controllers/gameController";

const router = Router();

router.post("/auth/register", AuthController.signup);
router.post("/auth/login", AuthController.login);
router.get("/auth/me", AuthMiddleware.authenticate, AuthController.getMe);

// Chess game history — protected routes
router.get("/games", AuthMiddleware.authenticate, GameController.getMyGames);
router.get("/games/:gameId", AuthMiddleware.authenticate, GameController.getGameById);

export default router;
