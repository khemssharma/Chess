import AuthService from "../services/authServices";
import { Request, Response } from "express";
import { AuthenticatedRequest } from "../utils/types";
import jwt from "jsonwebtoken";

class AuthController {
  static signup = async (req: Request, res: Response) => {
    try {
      const { username, email, password } = req.body;
      const existingUser = await AuthService.findUserByEmail(email);
      if (existingUser)
        return res.status(400).json({ message: "User already exists" });
      const user = await AuthService.registerUser(username, email, password);
      const { password: _, ...safeUser } = user;
      return res.status(201).json(safeUser);
    } catch (error) {
      res.status(400).json({ message: "Registration failed", error });
    }
  };

  static login = async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      const token = await AuthService.loginUser(email, password);
      res.status(200).json({ token });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Login failed" });
    }
  };

  static googleLogin = async (req: Request, res: Response) => {
    try {
      const { access_token } = req.body;
      if (!access_token) {
        return res.status(400).json({ message: "Google access token required" });
      }
      const token = await AuthService.googleLogin(access_token);
      const decoded = jwt.decode(token) as { userId: number };
      const user = await AuthService.findUserById(decoded.userId);
      if (!user) return res.status(404).json({ message: "User not found" });
      const { password: _, ...safeUser } = user;
      res.status(200).json({ token, user: safeUser });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Google login failed" });
    }
  };

  static getMe = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const user = await AuthService.findUserById(req.user.userId);
      if (!user) return res.status(404).json({ message: "User not found" });
      const { password: _, ...safeUser } = user;
      res.status(200).json(safeUser);
    } catch (error) {
      res.status(500).json({ message: "Internal server error", error });
    }
  };
}

export default AuthController;
