Render deployment steps

1) Push your repo to Github (or connect your repo to Render). This repo should contain both `backend` and `frontend` directories. The attached `render.yaml` defines both services.

2) Backend (Web Service)
- Render should detect the `backend` working directory using `render.yaml`.
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Ensure the `PORT` environment variable is used — the backend already falls back to `process.env.PORT`.

3) Frontend (Static Site)
- Render should detect the `frontend` working directory using `render.yaml`.
- Build command: `npm install && npm run build`
- Publish directory: `dist`
- Set environment variable: `VITE_WS_URL` to `wss://<your-backend-service>.onrender.com` (replace with the actual backend URL provided by Render). If your backend serves non-TLS websocket, use `ws://`.

4) Manual deploy steps (alternative):
- Create a new Web Service in Render and configure it to use the `backend` folder. Set the build & start commands above.
- Create a new Static Site in Render and configure it to use the `frontend` folder. After building, set `VITE_WS_URL` env var to the backend URL.

5) Notes & tips:
- The backend uses TypeScript and compiles to `dist` before starting; `start` runs the compiled code in `dist`.
- If your frontend needs to use secure websockets (`wss`), make sure the backend is configured to use TLS or is behind a TLS-terminating proxy.
- Locally, the frontend defaults to `ws://localhost:8080` if the `VITE_WS_URL` env var isn't set.

6) Troubleshooting:
- If the websocket doesn't connect, ensure you used `wss://` for secure connections, and confirm your Render backend service is started successfully.
- Tail logs on Render (dashboard) if connections are failing.
- If you change the server path or port, update `VITE_WS_URL` accordingly.

That's it — once you deploy the backend and configure the frontend env var to point to your backend, the app will connect through Render-hosted endpoints.