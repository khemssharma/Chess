import { parseJwt, getTokenExpiration, isTokenExpired } from "../utils/jwt";

// Declare mock testing globals for typescript compiler compatibility
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (val: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

function createTestJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(JSON.stringify(payload));
  const signature = "mockSignature";
  return `${header}.${body}.${signature}`;
}

describe("JWT Utility functions", () => {
  it("should parse payload from valid JWT token", () => {
    const payload = { userId: 42, username: "grandmaster", exp: 1700000000 };
    const token = createTestJwt(payload);

    const parsed = parseJwt(token);
    expect(parsed).toEqual(payload);
    expect(parsed?.userId).toBe(42);
    expect(parsed?.exp).toBe(1700000000);
  });

  it("should return null when parsing invalid or malformed token strings", () => {
    expect(parseJwt("not-a-valid-jwt")).toBe(null);
    expect(parseJwt("")).toBe(null);
    expect(parseJwt("header.only-two-parts")).toBe(null);
    expect(parseJwt("part1.not-json.part3")).toBe(null);
  });

  it("should extract expiration timestamp in milliseconds", () => {
    const expSeconds = 1750000000;
    const token = createTestJwt({ userId: 1, exp: expSeconds });

    const expMs = getTokenExpiration(token);
    expect(expMs).toBe(expSeconds * 1000);
  });

  it("should return null for expiration if token has no exp claim", () => {
    const token = createTestJwt({ userId: 1 });
    expect(getTokenExpiration(token)).toBe(null);
  });

  it("should detect when token is expired", () => {
    // Expired 1 hour ago
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const expiredToken = createTestJwt({ userId: 1, exp: pastExp });

    expect(isTokenExpired(expiredToken)).toBe(true);
  });

  it("should detect when token is still active and valid", () => {
    // Expires 1 hour in the future
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const validToken = createTestJwt({ userId: 1, exp: futureExp });

    expect(isTokenExpired(validToken)).toBe(false);
  });

  it("should return false for tokens or mocks without an exp claim", () => {
    const nonExpiringToken = createTestJwt({ userId: 1 });
    expect(isTokenExpired(nonExpiringToken)).toBe(false);
    expect(isTokenExpired("mock-valid-token")).toBe(false);
  });
});
