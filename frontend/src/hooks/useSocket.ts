import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";

const WS_BASE = (import.meta.env.VITE_WS_URL as string) || "ws://localhost:3000";

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

    // Append JWT as query param so the server can link games to the user's profile.
    // Guests (no token) can still play; their games won't appear in history.
    const url = token ? `${WS_BASE}?token=${encodeURIComponent(token)}` : WS_BASE;
    const ws = new WebSocket(url);

    ws.onopen = () => setSocket(ws);
    ws.onclose = () => setSocket(null);

    return () => ws.close();
  }, [token, isLoading]); // Reconnect when auth state changes

  return socket;
};
