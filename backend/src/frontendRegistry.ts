/**
 * Frontend Route Registry
 *
 * This file is the single source of truth for all UI routes that the
 * React SPA owns.  The backend uses this registry so that:
 *   - A hard refresh on any valid client-side route returns index.html
 *     (React Router takes over from there).
 *   - Truly unknown paths still receive a proper 404 JSON response.
 *   - API / WebSocket paths are never accidentally caught by the fallback.
 *
 * Mirrors the pattern used in the Chat-App backend.
 */

/** Exact static paths the SPA handles. */
export const FRONTEND_STATIC_ROUTES: string[] = [
  "/",
  "/login",
  "/register",
  "/game",
  "/history",
];

/**
 * Dynamic route patterns the SPA handles.
 * Add a RegExp here for every parameterised React-Router path.
 */
export const FRONTEND_DYNAMIC_ROUTES: RegExp[] = [
  /^\/game\/[^/]+$/,     // /game/:gameId  (if used)
  /^\/history\/[^/]+$/,  // /history/:gameId  (GameReplay screen)
];

/**
 * Returns true when the given pathname belongs to the React SPA,
 * meaning the backend should serve index.html instead of returning 404.
 *
 * Excludes:
 *   - /api/*   – REST endpoints
 *   - /socket.io/*  – Socket.io polling (if ever added)
 *   - paths that look like static assets (contain a dot, e.g. .js .css .png)
 */
export function isFrontendRoute(pathname: string): boolean {
  // Never intercept API or WebSocket upgrade paths
  if (pathname.startsWith("/api") || pathname.startsWith("/socket.io")) {
    return false;
  }

  // Never intercept static asset requests (e.g. /assets/index-abc123.js)
  if (/\.\w+$/.test(pathname)) {
    return false;
  }

  if (FRONTEND_STATIC_ROUTES.includes(pathname)) {
    return true;
  }

  return FRONTEND_DYNAMIC_ROUTES.some((pattern) => pattern.test(pathname));
}
