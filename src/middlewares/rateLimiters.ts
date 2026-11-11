import rateLimit from "express-rate-limit";
import { redisService } from "../chess/RedisService.js";

type RateLimitPlan = {
  windowMs: number;
  limit: number;
  keyPrefix: string;
};

const envInt = (name: string, fallback: number): number => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: envInt("AUTH_RATE_LIMIT", 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many auth requests — please try again later." },
});

const redisLimiter = (plan: RateLimitPlan) => async (req: any, res: any, next: any) => {
  const userId = req.user?.userId;
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const identity = userId ? `user:${userId}` : `ip:${ip}`;
  const result = await redisService.rateLimit(`${plan.keyPrefix}:${identity}`, plan.limit, plan.windowMs);
  res.setHeader("X-RateLimit-Limit", plan.limit);
  res.setHeader("X-RateLimit-Remaining", result.remaining);
  if (!result.allowed) {
    res.setHeader("Retry-After", Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
    return res.status(429).json({ message: "Too many requests — please try again later." });
  }
  return next();
};

export const analysisRateLimiter = redisLimiter({ windowMs: 60 * 1000, limit: envInt("ANALYSIS_RATE_LIMIT", 10), keyPrefix: "analysis" });
export const aiRateLimiter = redisLimiter({ windowMs: 60 * 1000, limit: envInt("AI_RATE_LIMIT", 20), keyPrefix: "ai" });
export const puzzleAttemptRateLimiter = redisLimiter({ windowMs: 60 * 1000, limit: envInt("PUZZLE_ATTEMPT_RATE_LIMIT", 30), keyPrefix: "puzzle-attempt" });
