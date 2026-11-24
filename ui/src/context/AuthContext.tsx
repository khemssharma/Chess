import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { AuthService, User } from "../services/authService";
import { getTokenExpiration, isTokenExpired } from "../utils/jwt";

const TOKEN_KEY = "chess_auth_token";
const USER_KEY = "chess_auth_user";

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  googleLogin: (accessToken: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

export const AuthContext = createContext<AuthContextType | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem("chess_player_id");
    localStorage.removeItem("chess_game_id");
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    const initializeAuth = async () => {
      const storedToken = localStorage.getItem(TOKEN_KEY);
      
      if (!storedToken) {
        setIsLoading(false);
        return;
      }

      // If stored token is already expired, log out immediately without an unnecessary API call
      if (isTokenExpired(storedToken)) {
        logout();
        setIsLoading(false);
        return;
      }

      try {
        const userData = await AuthService.me();
        setToken(storedToken);
        setUser(userData);
        localStorage.setItem(USER_KEY, JSON.stringify(userData));
      } catch {
        logout();
      } finally {
        setIsLoading(false);
      }
    };

    initializeAuth();
  }, [logout]);

  // Proactive token expiration timer and wake-up/tab visibility listener
  useEffect(() => {
    if (!token) return;

    if (isTokenExpired(token)) {
      logout();
      return;
    }

    const exp = getTokenExpiration(token);
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (exp !== null) {
      const remainingMs = exp - Date.now();
      if (remainingMs <= 0) {
        logout();
        return;
      }
      timer = setTimeout(() => {
        logout();
      }, remainingMs);
    }

    const checkExpiry = () => {
      if (isTokenExpired(token)) {
        logout();
      }
    };

    document.addEventListener("visibilitychange", checkExpiry);
    window.addEventListener("focus", checkExpiry);
    const interval = setInterval(checkExpiry, 30_000);

    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", checkExpiry);
      window.removeEventListener("focus", checkExpiry);
    };
  }, [token, logout]);

  // Listen for unauthorized 401 events dispatched by API client or WebSocket
  useEffect(() => {
    const handleAuthLogout = () => {
      logout();
    };
    window.addEventListener("auth:logout", handleAuthLogout);
    return () => {
      window.removeEventListener("auth:logout", handleAuthLogout);
    };
  }, [logout]);

  const setSession = (newToken: string, userData: User) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(userData));
    setToken(newToken);
    setUser(userData);
  };

  const login = async (email: string, password: string) => {
    const { token: newToken, user: userData } = await AuthService.login(email, password);
    setSession(newToken, userData);
  };

  const googleLogin = async (accessToken: string) => {
    const { token: newToken, user: userData } = await AuthService.googleLogin(accessToken);
    setSession(newToken, userData);
  };

  const register = async (username: string, email: string, password: string) => {
    const { token: newToken, user: userData } = await AuthService.register(username, email, password);
    setSession(newToken, userData);
  };

  return (
    <AuthContext.Provider value={{ user, token, login, googleLogin, register, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
};
