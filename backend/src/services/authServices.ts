import { PrismaClient } from '@prisma/client';
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET!;

class AuthService {
  static registerUser = async (username: string, email: string, password: string) => {
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
    const user = await this.findUserByEmail(email);
    if (!user) throw new Error("User not found");
    if (!user.password) throw new Error("This account uses Google Sign-In. Please sign in with Google.");
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) throw new Error("Invalid password");
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "24h" });
    return token;
  };

  static googleLogin = async (accessToken: string) => {
    // Fetch user info from Google
    const response = await fetch(
      `https://www.googleapis.com/oauth2/v3/userinfo?access_token=${accessToken}`
    );
    if (!response.ok) throw new Error("Failed to fetch Google user info");
    const googleUser = await response.json() as {
      sub: string;
      email: string;
      email_verified: boolean;
      name: string;
      given_name: string;
      picture: string;
    };

    if (!googleUser.email_verified) {
      throw new Error("Google email not verified");
    }

    const { sub: googleId, email, name, picture } = googleUser;

    // Find existing user by googleId or email
    let user = await prisma.user.findFirst({
      where: { OR: [{ googleId }, { email }] },
    });

    if (user) {
      // Update googleId and avatar if not set
      if (!user.googleId) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { googleId, avatar: picture },
        });
      }
    } else {
      // Create new user from Google data
      user = await prisma.user.create({
        data: {
          username: name,
          email,
          googleId,
          avatar: picture,
          password: null,
        },
      });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "24h" });
    return token;
  };
}

export default AuthService;
