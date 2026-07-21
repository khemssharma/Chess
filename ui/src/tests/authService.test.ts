import { AuthService } from "../services/authService";
import { setMockApiFetch } from "../api/apiClient";

// Declare mock testing globals for typescript compiler compatibility
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void> | void) => void;
declare const expect: (val: any) => any;
declare const beforeEach: (fn: () => void) => void;
declare const afterEach: (fn: () => void) => void;
declare const jest: any;

describe("AuthService login methods", () => {
  afterEach(() => {
    setMockApiFetch(null);
  });

  it("should perform email login, retrieve token, and fetch user data", async () => {
    // Mock apiFetch calls sequentially
    let callCount = 0;
    const mockUser = { id: 101, username: "chessmaster", email: "test@example.com" };
    
    setMockApiFetch((endpoint: string, options: any) => {
      callCount++;
      if (endpoint === "/api/auth/login") {
        expect(options.method).toBe("POST");
        expect(JSON.parse(options.body)).toEqual({ email: "test@example.com", password: "password123" });
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ token: "new-jwt-token" })
        } as Response);
      }
      if (endpoint === "/api/auth/me") {
        expect(options.headers?.Authorization).toBe("Bearer new-jwt-token");
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockUser)
        } as Response);
      }
      return Promise.reject(new Error("Unknown endpoint"));
    });

    const result = await AuthService.login("test@example.com", "password123");
    
    expect(callCount).toBe(2);
    expect(result.token).toBe("new-jwt-token");
    expect(result.user).toEqual(mockUser);
  });

  it("should fetch current user data using me() method", async () => {
    const mockUser = { id: 102, username: "checkmate", email: "check@example.com" };
    
    setMockApiFetch((endpoint: string) => {
      if (endpoint === "/api/auth/me") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockUser)
        } as Response);
      }
      return Promise.reject(new Error("Unknown endpoint"));
    });

    const result = await AuthService.me();
    expect(result).toEqual(mockUser);
  });
});
