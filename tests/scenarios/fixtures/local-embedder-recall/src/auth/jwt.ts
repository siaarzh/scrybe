/**
 * JWT authentication utilities.
 * Handles token creation, verification, and refresh logic.
 */
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET ?? "fallback-dev-secret";
const ACCESS_TOKEN_TTL_SECONDS = 900;   // 15 minutes
const REFRESH_TOKEN_TTL_SECONDS = 86400; // 24 hours

export interface JwtPayload {
  sub: string;   // subject (user id)
  iat: number;   // issued at
  exp: number;   // expiry
  role: string;
}

/** Encode a JSON payload as base64url without padding. */
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Compute an HMAC-SHA256 signature for the given data. */
function sign(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Create a signed JWT token for the given user.
 * Returns both an access token (short-lived) and a refresh token (long-lived).
 */
export function createTokenPair(userId: string, role: string): { accessToken: string; refreshToken: string } {
  const now = Math.floor(Date.now() / 1000);

  const header = b64url({ alg: "HS256", typ: "JWT" });
  const accessPayload = b64url({ sub: userId, iat: now, exp: now + ACCESS_TOKEN_TTL_SECONDS, role });
  const refreshPayload = b64url({ sub: userId, iat: now, exp: now + REFRESH_TOKEN_TTL_SECONDS, role, refresh: true });

  const accessSig = sign(`${header}.${accessPayload}`, JWT_SECRET);
  const refreshSig = sign(`${header}.${refreshPayload}`, JWT_SECRET);

  return {
    accessToken: `${header}.${accessPayload}.${accessSig}`,
    refreshToken: `${header}.${refreshPayload}.${refreshSig}`,
  };
}

/**
 * Verify and decode a JWT token.
 * Throws if the token is invalid, expired, or tampered with.
 */
export function verifyToken(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token: expected 3 segments");

  const [header, payload, sig] = parts as [string, string, string];
  const expected = sign(`${header}.${payload}`, JWT_SECRET);
  if (sig !== expected) throw new Error("Token signature mismatch");

  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtPayload;
  const now = Math.floor(Date.now() / 1000);
  if (decoded.exp < now) throw new Error("Token expired");

  return decoded;
}

/** Check if a token is within its refresh window (within 5 minutes of expiry). */
export function isTokenNearExpiry(token: string): boolean {
  try {
    const payload = verifyToken(token);
    const now = Math.floor(Date.now() / 1000);
    return payload.exp - now < 300;
  } catch {
    return true;
  }
}
