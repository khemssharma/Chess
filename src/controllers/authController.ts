import AuthService from "../services/authServices";
import { Request, Response } from "express";
import { AuthenticatedRequest } from "../utils/types";

class AuthController {
  static signup = async (req: Request, res: Response) => {
    try {
      const { username, email, password } = req.body;
      const existingUser = await AuthService.findUserByEmail(email);
      if (existingUser)
        return res.status(400).json({ message: "User already exists" });
      const user = await AuthService.registerUser(username, email, password);
      // Don't return the password hash
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
    } catch (error) {
      res.status(400).json({ message: "Login failed", error });
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
