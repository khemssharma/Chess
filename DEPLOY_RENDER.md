# Deploying Chess App on Render (Single Server)

This app runs as a **single service** — the Express backend serves the React
frontend build and handles API + WebSocket requests, all on one port.

## How it works

```
Root package.json
├── npm run build
│   ├── npm install --prefix backend
│   ├── npm install --prefix frontend
│   ├── npm run build --prefix frontend   → frontend/dist/
│   └── npm run build --prefix backend    → backend/dist/
└── npm start
    └── npm run start --prefix backend    → node dist/src/index.js
        ├── Serves frontend/dist/ as static files
        ├── REST API at /api/*
        └── WebSocket on the same port
```

## Render Setup

1. Create a **Web Service** on Render (not a Static Site).
2. Connect your GitHub repo.
3. Settings:
   - **Build Command:** `npm run build`
   - **Start Command:** `npm start`
   - **Root Directory:** *(leave blank — uses repo root)*
4. Environment variables:
   - `DATABASE_URL` — your PostgreSQL connection string
   - `JWT_SECRET` — a secure random string
   - `NODE_ENV` — `production`
   - `PORT` — Render sets this automatically
   - `STOCKFISH_PATH` — `./stockfish-bin` (if using Stockfish)
   - `REDIS_URL` — *(optional)* Redis connection string
   - `VITE_GOOGLE_CLIENT_ID` — *(optional)* for Google OAuth

> **Note:** `CLIENT_URL`, `VITE_API_URL`, and `VITE_WS_URL` are **no longer
> needed** — everything runs on the same origin.

## Local Development

```bash
# Terminal 1 — backend (port 3000)
cd backend
npm install
npm run dev

# Terminal 2 — frontend (port 5173, proxies to backend)
cd frontend
npm install
npm run dev
```

Or build and run as a single server locally:

```bash
npm run build
npm start        # → http://localhost:3000
```
