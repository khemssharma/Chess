import { apiFetch } from "../api/apiClient";

// Declare mock testing globals for typescript compiler compatibility
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void> | void) => void;
declare const expect: (val: any) => any;
declare const beforeAll: (fn: () => void) => void;
declare const afterAll: (fn: () => void) => void;
declare const beforeEach: (fn: () => void) => void;
declare const jest: any;

describe("apiFetch client utility", () => {
  let originalFetch: typeof fetch;
  let originalLocation: Location;
  let store: Record<string, string> = {};

  beforeAll(() => {
    originalFetch = globalThis.fetch;
    originalLocation = window.location;

    // Mock localStorage
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, value: string) => { store[key] = value; },
        removeItem: (key: string) => { delete store[key]; },
        clear: () => { store = {}; }
      },
      writable: true
    });

    // Mock window location
    Object.defineProperty(window, "location", {
      value: {
        href: "",
        pathname: "/game"
      },
      writable: true
    });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(window, "location", { value: originalLocation });
  });

  beforeEach(() => {
    store = {};
    window.location.href = "";
    window.location.pathname = "/game";
  });

  it("should append auth token to headers if it exists in localStorage", async () => {
    store["chess_auth_token"] = "mock-valid-token";
    
    let requestHeaders: HeadersInit | undefined;
    globalThis.fetch = jest.fn().mockImplementation((_url: string, options: any) => {
      requestHeaders = options?.headers;
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ success: true })
      } as Response);
    });

    const response = await apiFetch("/api/games");
    expect(response.status).toBe(200);
    expect(requestHeaders).toBeDefined();
    expect((requestHeaders as any)["Authorization"]).toBe("Bearer mock-valid-token");
  });

  it("should clear storage and redirect to login when response status is 401", async () => {
    store["chess_auth_token"] = "mock-expired-token";
    store["chess_auth_user"] = '{"id":1}';

    globalThis.fetch = jest.fn().mockImplementation(() => {
      return Promise.resolve({
        status: 401,
        ok: false,
        json: () => Promise.resolve({ message: "Invalid token" })
      } as Response);
    });

    try {
      await apiFetch("/api/games");
      expect(false).toBe(true); // Should not reach here
    } catch (err: any) {
      expect(err.message).toBe("Unauthorized");
    }
    
    expect(store["chess_auth_token"]).toBeUndefined();
    expect(store["chess_auth_user"]).toBeUndefined();
    expect(window.location.href).toBe("/login");
  });
});
