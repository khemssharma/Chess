import { Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";
import { AuthenticatedRequest } from "../utils/types";

class AuthMiddleware {
  static authenticate = (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) => {
    const authHeader = req.header("Authorization") || req.header("x-auth-token");
    const token = authHeader?.replace(/^Bearer\s*/i, "").trim();
    if (!token) return res.status(401).json({ message: "No token provided" });

    try {
      req.user = verifyToken(token);
      next();
    } catch {
      res.status(401).json({ message: "Invalid token" });
    }
  };
}

export default AuthMiddleware;
