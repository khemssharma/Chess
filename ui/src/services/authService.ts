import { apiFetch } from "../api/apiClient";

export interface User {
  id: number;
  username: string;
  email: string;
  avatar?: string | null;
}

export class AuthService {
  static async login(email: string, password: string): Promise<{ token: string; user: User }> {
    const res = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Login failed");
    }
    const { token } = await res.json();

    // Fetch the user details using the newly acquired token
    const meRes = await apiFetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!meRes.ok) {
      throw new Error("Failed to fetch user profile after login");
    }
    const user = await meRes.json();
    return { token, user };
  }

  static async googleLogin(accessToken: string): Promise<{ token: string; user: User }> {
    const res = await apiFetch("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Google login failed");
    }
    const { token, user } = await res.json();
    return { token, user };
  }

  static async register(username: string, email: string, password: string): Promise<{ token: string; user: User }> {
    const res = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Registration failed");
    }
    return this.login(email, password);
  }

  static async me(): Promise<User> {
    const res = await apiFetch("/api/auth/me");
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Unauthorized");
    }
    return res.json();
  }
}
