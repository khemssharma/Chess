import dotenv from "dotenv";
dotenv.config();

import cors from "cors";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "url";
import path from "path";
import fs from "fs";

import AuthRouter from "./routes/authRoutes";
import { GameManager } from "./chess/GameManager";
import { verifyToken } from "./utils/jwt";
import { isFrontendRoute } from "./frontendRegistry";

// ---------------------------------------------------------------------------
// Resolve the frontend build directory
// Works in BOTH modes:
//  dev  → ts-node-dev runs from backend/src   → ../../frontend/dist
//  prod → compiled file at backend/dist/src   → ../../../frontend/dist
// ---------------------------------------------------------------------------
const distCandidates = [
  path.resolve(__dirname, "../ui/dist"),
  path.resolve(__dirname, "../../ui/dist"),
];
const frontendDist =
  distCandidates.find((p) => fs.existsSync(path.join(p, "index.html"))) ??
  distCandidates[0];

if (!fs.existsSync(path.join(frontendDist, "index.html"))) {
  console.warn(
    "⚠ ui/dist not found — run `npm run build` inside the ui folder first."
  );
}

const app = express();

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
// Allow all origins — safe for this app since auth is JWT-based, not cookie-based.
// To restrict later, set CLIENT_URL as a comma-separated list of allowed origins.
const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(",").map((o) => o.trim())
  : null; // null = allow all

const corsOptions: cors.CorsOptions = {
  origin: allowedOrigins ?? true, // true = reflect the request origin (allow all)
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-auth-token"],
  credentials: true,
};

// Must be the FIRST middleware — before express.json() and routes
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // preflight for all routes
app.use(express.json());

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use("/api", AuthRouter);

// ---------------------------------------------------------------------------
// Static frontend serving (path resolved above, works in dev and prod)
// ---------------------------------------------------------------------------
app.use(express.static(frontendDist));

// ---------------------------------------------------------------------------
// SPA fallback — uses the frontend registry so the server knows exactly
// which paths belong to the React app (mirrors Chat-App pattern).
//
//  - Known UI routes  → serve index.html (React Router takes over)
//  - Truly unknown   → 404 JSON  (no silent swallowing of typos / bad links)
// ---------------------------------------------------------------------------
app.get("*", (req, res) => {
  if (isFrontendRoute(req.path)) {
    return res.sendFile(path.join(frontendDist, "index.html"));
  }
  res.status(404).json({ error: `Route '${req.path}' not found` });
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ server });

const gameManager = new GameManager();

wss.on("connection", (ws: WebSocket, req) => {
  let dbUserId: number | null = null;

  try {
    const { query } = parse(req.url || "", true);
    const token = query.token as string | undefined;

    if (token) {
      const decoded = verifyToken(token);
      dbUserId = decoded.userId;
      console.log(`Authenticated WS connection — userId: ${dbUserId}`);
    } else {
      console.log("Anonymous WS connection (no token provided)");
    }
  } catch {
    console.log("WS connection with invalid token — treating as guest");
  }

  gameManager.addUser(ws, dbUserId);
  ws.on("close", () => gameManager.removeUser(ws));
});

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

server.listen(PORT, () => {
  console.log(`\nServer listening on port ${PORT}`);
  console.log(` REST API  → http://localhost:${PORT}/api`);
  console.log(` WebSocket → ws://localhost:${PORT}?token=\n`);
  console.log(
    allowedOrigins
      ? ` CORS allowed for: ${allowedOrigins.join(", ")}\n`
      : " CORS: all origins allowed\n"
  );
});