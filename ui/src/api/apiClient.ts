const API_URL = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_API_URL as string) || "http://localhost:3000";
const TOKEN_KEY = "chess_auth_token";
const USER_KEY = "chess_auth_user";

let mockApiFetch: typeof apiFetch | null = null;
export function setMockApiFetch(mock: typeof apiFetch | null) {
  mockApiFetch = mock;
}

export async function apiFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  if (mockApiFetch) {
    return mockApiFetch(endpoint, options);
  }

  const token = localStorage.getItem(TOKEN_KEY);

  // Ensure endpoint starts with a slash if not absolute
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const url = `${API_URL}${normalizedEndpoint}`;

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem("chess_player_id");
    localStorage.removeItem("chess_game_id");

    // Redirect to login if we are not already on the login or register pages
    const path = window.location.pathname;
    if (path !== "/login" && path !== "/register") {
      window.location.href = "/login";
    }
    throw new Error("Unauthorized");
  }

  return response;
}
