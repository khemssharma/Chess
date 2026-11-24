export interface JwtPayload {
  userId?: number;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

/**
 * Parses the payload from a JWT token string.
 * Supports standard base64 and base64url encodings safely.
 */
export function parseJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(jsonPayload) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Returns expiration timestamp in milliseconds, or null if token is invalid or missing exp claim.
 */
export function getTokenExpiration(token: string): number | null {
  const payload = parseJwt(token);
  if (!payload || typeof payload.exp !== "number") return null;
  return payload.exp * 1000;
}

/**
 * Checks whether a token has expired.
 * If token is a valid JWT with an `exp` claim, returns true if current time >= exp.
 * If token does not contain an `exp` claim or is not a standard JWT, returns false.
 */
export function isTokenExpired(token: string): boolean {
  const exp = getTokenExpiration(token);
  if (exp === null) return false;
  return Date.now() >= exp;
}
