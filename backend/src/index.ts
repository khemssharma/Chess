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

// Support comma-separated origins in CLIENT_URL, e.g. "https://a.onrender.com,https://b.onrender.com"
const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(",").map((o) => o.trim())
  : [];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (Render health checks, curl, mobile)
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-auth-token"],
  credentials: true,
};

app.use(cors(corsOptions));
// Explicitly handle OPTIONS preflight for all routes
app.options("*", cors(corsOptions));

app.use(express.json());
app.use("/api", AuthRouter);

// Health check
app.get("/", (_, res) => res.send("Chess + Auth Server running"));

// Share one HTTP server between Express and WebSocket
const server = createServer(app);
const wss = new WebSocketServer({ server });
const gameManager = new GameManager();

wss.on("connection", (ws: WebSocket, req) => {
  // Clients pass their JWT as a query param:
  //   ws://localhost:3000?token=<jwt>
  // Guests (no token) can still play; their games are not linked to a profile.
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
    allowedOrigins.length > 0
      ? `  CORS allowed for: ${allowedOrigins.join(", ")}\n`
      : "  No CORS origins configured — allowing all origins\n"
  );
});
