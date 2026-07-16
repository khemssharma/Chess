import rateLimit from "express-rate-limit";

/**
 * Auth endpoints (signup/login/google) were previously unprotected. Each
 * request does real bcrypt work (cost factor 10, deliberately slow) and/or a
 * DB write, so a burst of concurrent requests here is the most CPU/DB
 * expensive thing this API can be asked to do. This limits abuse/brute-force
 * without affecting normal usage.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // 20 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many auth requests — please try again later." },
});
