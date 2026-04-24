# Deploying to Render

## Overview
This project deploys as two Render services:
- **chess-backend** — Node.js Web Service (WebSocket + REST API)
- **chess-frontend** — Static Site (React/Vite)

The `render.yaml` at the repo root defines both. Render will auto-detect it when you connect your GitHub repo.

---

## 1. Push your repo to GitHub
Make sure your repo contains both `backend/` and `frontend/` directories, plus `render.yaml`.

---

## 2. Connect to Render
1. Go to [render.com](https://render.com) → **New** → **Blueprint**
2. Connect your GitHub repo
3. Render will read `render.yaml` and create both services automatically

---

## 3. Backend environment variables
Set these in the Render dashboard under **chess-backend → Environment**:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | Your PostgreSQL connection string |
| `REDIS_URL` | Your Redis connection string |
| `JWT_SECRET` | A long random secret string |
| `NODE_ENV` | `production` |

Render offers managed **PostgreSQL** and **Redis** add-ons — create them from the dashboard and copy the connection URLs.

---

## 4. Frontend environment variable
Set this under **chess-frontend → Environment**:

| Key | Value |
|-----|-------|
| `VITE_WS_URL` | `wss://chess-backend.onrender.com` |

Replace `chess-backend` with the actual subdomain Render assigns to your backend service.

---

## 5. Stockfish on Render
Stockfish is installed automatically during the backend build step:

```
apt-get update && apt-get install -y stockfish && npm install && npm run build
```

This is already set in `render.yaml` — no extra action needed. Render's Node.js web service environment runs on Debian/Ubuntu, so `apt-get` works out of the box.

If the build ever fails with a Stockfish error, you can verify availability by checking the build logs for `stockfish` installation output.

---

## 6. Deploy order
Deploy the **backend first**, wait for it to be live, then deploy the **frontend** — so you have the real backend URL to set in `VITE_WS_URL`.

---

## 7. Troubleshooting

**WebSocket won't connect**
- Confirm `VITE_WS_URL` uses `wss://` (not `ws://`) — Render always terminates TLS.
- Make sure the backend URL matches exactly what Render shows (e.g. `chess-backend.onrender.com`).

**Stockfish not working / fallback to random moves**
- Check the backend build logs for `apt-get install -y stockfish` — it should show a successful install.
- Render's free tier may time out during heavy builds; retry the deploy if needed.

**Database errors on startup**
- Run `npm run db:migrate` locally against your production `DATABASE_URL`, or trigger it in a Render shell (dashboard → shell tab).

**Cold start delays**
- Free-tier Render services spin down after inactivity. The first WebSocket connection after sleep will take ~30 seconds. Upgrade to a paid instance to avoid this.
