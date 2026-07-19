# Deploying to Render

## Overview
This project deploys as three Render services, all defined in `render.yaml`:
- **chess-backend** — Node.js Web Service (WebSocket + REST API), horizontally scaled
- **chess-frontend** — Static Site (React/Vite)
- **chess-redis** — Render Key Value (Redis-compatible), shared state for matchmaking, active games, and reconnects

Render auto-detects `render.yaml` when you connect your GitHub repo, and provisions all three together.

---

## 1. Push your repo to GitHub
The backend's `package.json` lives at the **repo root** (not in a `backend/` folder — `render.yaml` was previously misconfigured to expect that; it now points at the actual layout: backend = repo root, frontend = `ui/`).

---

## 2. Connect to Render
1. Go to [render.com](https://render.com) → **New** → **Blueprint**
2. Connect your GitHub repo
3. Render reads `render.yaml` and creates all three services automatically

---

## 3. Backend environment variables
`render.yaml` wires `REDIS_HOST` / `REDIS_PORT` automatically from the `chess-redis` Key Value service it provisions — no manual step needed there.

Set these manually in the Render dashboard under **chess-backend → Environment** (they're marked `sync: false` in the blueprint, meaning Render won't auto-fill them from git — that's intentional for secrets):

| Key | Value |
|-----|-------|
| `DATABASE_URL` | Your PostgreSQL connection string (Render Postgres, or any external provider) |
| `JWT_SECRET` | A long random secret string |
| `OPENROUTER_API_KEY` | Only needed if using the AI assistant feature |

---

## 4. Frontend environment variable
Set under **chess-frontend → Environment** if it differs from the placeholder in `render.yaml`:

| Key | Value |
|-----|-------|
| `VITE_WS_URL` | `wss://chess-backend.onrender.com` (use the actual subdomain Render assigns) |

---

## 5. Stockfish on Render
Installed automatically during the backend build step (downloads a prebuilt static binary — no `apt-get`/root needed, which matters since Render's build environment doesn't grant that):

```
curl -L <stockfish release tarball> -o /tmp/sf.tar && tar -xf /tmp/sf.tar -C /tmp &&
cp /tmp/stockfish/stockfish-ubuntu-x86-64-avx2 ./stockfish-bin && chmod +x ./stockfish-bin &&
npm install && npm run build
```

If a build ever fails on the Stockfish step, check the build logs for that `curl`/`cp` output — a broken release URL is the most common cause.

---

## 6. Deploy order
Deploy the **backend first**, wait for it to be live, then the **frontend** — so you have the real backend URL to set in `VITE_WS_URL`.

---

## 7. Horizontal scaling

`chess-backend` is configured with `numInstances: 2` in `render.yaml`. This is safe — and actually the point of the recent refactor — because:

- Matchmaking, active game state, and reconnect handoffs are relayed through `chess-redis` (see `src/chess/RedisService.ts` and `src/chess/GameManager.ts`) instead of living only in one process's memory.
- Render's load balancer assigns each WebSocket connection to a **random** instance — it doesn't support sticky sessions — which used to mean two players in the same game could easily end up unable to reach each other. Two Redis pub/sub channels (`chess:to-player`, `chess:game-command`) now bridge that gap, so any instance can serve any client.

A few things to know before you rely on this in production:

- **`numInstances` requires at least a Starter plan.** Render's Free tier caps a web service at one instance; `numInstances: 2` will be ignored (or the deploy will flag it) on Free.
- **Autoscaling** (scale by CPU/memory instead of a fixed count) requires a **Pro workspace**. See the commented-out `scaling:` block in `render.yaml` for the syntax if you upgrade.
- **A crashed instance mid-game is not seamlessly recovered.** If the specific instance holding a game's authoritative state dies, that game resumes once *both* players reconnect (their own reconnect calls rebuild it) — see the "known limitations" section of `SCALABILITY_REPORT.md`. This is a deliberate scope cut, not an oversight — full instant failover would need leader election, which felt like a bigger, separate piece of work.
- **Verify the exact `keyvalue` blueprint fields against Render's current dashboard/docs at deploy time.** Render's product naming and blueprint schema for its Redis-compatible offering have changed before (it's now called "Key Value"); if `render.yaml` fails to parse, that's the first thing to check.

---

## 8. Troubleshooting

**WebSocket won't connect**
- Confirm `VITE_WS_URL` uses `wss://` (not `ws://`) — Render always terminates TLS.
- Make sure the backend URL matches exactly what Render shows.

**Stockfish not working / fallback to random moves**
- Check the backend build logs for the `curl`/`cp` Stockfish steps — should show a successful download and copy.
- Render's free tier may time out during heavy builds; retry the deploy if needed.

**Database errors on startup**
- Run `npm run db:migrate` locally against your production `DATABASE_URL`, or trigger it in a Render shell (dashboard → shell tab).

**Two players can't find each other / matchmaking seems stuck**
- Check that `chess-redis` is provisioned and `REDIS_HOST`/`REDIS_PORT` resolved on chess-backend (Environment tab). If Redis isn't reachable, each instance falls back to local-only matchmaking — you'll only ever match with someone who happens to land on the same instance.

**Cold start delays**
- Free-tier Render services spin down after inactivity. The first WebSocket connection after sleep will take ~30 seconds. Not applicable once you're on a paid plan with `numInstances` set (those never idle-spin-down the same way).
