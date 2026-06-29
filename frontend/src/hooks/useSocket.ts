import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";

// Derive WebSocket URL from the current page origin (same server).
// Works for both local dev (http → ws) and production (https → wss).
function getWsBase(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

export const useSocket = () => {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const { token, isLoading } = useAuth();

  useEffect(() => {
    // Don't open a WebSocket until we know the auth state.
    // Without this guard the socket connects as anonymous even for logged-in
    // users (because isLoading is true and token is still null), so the server
    // never associates the connection with the user's DB account and the stored
    // playerId reconnect fails.
    if (isLoading) return;

    const wsBase = getWsBase();
    // Append JWT as query param so the server can link games to the user's profile.
    // Guests (no token) can still play; their games won't appear in history.
    const url = token ? `${wsBase}?token=${encodeURIComponent(token)}` : wsBase;
    const ws = new WebSocket(url);

    ws.onopen = () => setSocket(ws);
    ws.onclose = () => setSocket(null);

    return () => ws.close();
  }, [token, isLoading]); // Reconnect when auth state changes

  return socket;
};
