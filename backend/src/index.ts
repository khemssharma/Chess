import dotenv from "dotenv";
dotenv.config();

import cors from "cors";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "url";

import AuthRouter from "./routes/authRoutes";
import { GameManager } from "./chess/GameManager";
import { verifyToken } from "./utils/jwt";

const app = express();

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
app.use("/api", AuthRouter);

// Health check
app.get("/", (_, res) => res.send("Chess + Auth Server running"));

// Share one HTTP server between Express and WebSocket
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
  console.log(`  REST API  → http://localhost:${PORT}/api`);
  console.log(`  WebSocket → ws://localhost:${PORT}?token=<jwt>\n`);
  console.log(
    allowedOrigins
      ? `  CORS allowed for: ${allowedOrigins.join(", ")}\n`
      : "  CORS: all origins allowed\n"
  );
});
