import { PrismaClient, User } from "../generated/prisma";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET!;

class AuthService {
  static registerUser = async (
    username: string,
    email: string,
    password: string
  ): Promise<User> => {
    const hashedPassword = await bcrypt.hash(password, 10);
    return prisma.user.create({
      data: { username, email, password: hashedPassword },
    });
  };

  static findUserByEmail = async (email: string) => {
    return prisma.user.findUnique({ where: { email } });
  };

  static findUserById = async (id: number) => {
    return prisma.user.findUnique({ where: { id } });
  };

  static loginUser = async (email: string, password: string) => {
    console.log("AuthService.loginUser called with:", { email, password });
    const user = await this.findUserByEmail(email);
    console.log("User found:", user);
    if (!user) throw new Error("User not found");
    const isMatch = await bcrypt.compare(password, user.password);
    console.log("Password match:", isMatch);
    if (!isMatch) throw new Error("Invalid password");
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "24h",
    });
    console.log("Generated token:", token);
    return token;
  };
}

export default AuthService;
