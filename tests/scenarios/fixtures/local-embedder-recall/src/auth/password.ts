/**
 * Password hashing and validation.
 * Uses bcrypt-compatible salted hashing with configurable work factor.
 */
import crypto from "crypto";

const SALT_ROUNDS = 12;
const HASH_ITERATIONS = 100_000;
const KEY_LENGTH = 64;
const DIGEST = "sha512";

export interface HashedPassword {
  hash: string;
  salt: string;
  iterations: number;
}

/**
 * Hash a plain-text password with a new random salt.
 * Uses PBKDF2 for key stretching.
 */
export function hashPassword(plaintext: string): HashedPassword {
  const salt = crypto.randomBytes(32).toString("hex");
  const hash = crypto
    .pbkdf2Sync(plaintext, salt, HASH_ITERATIONS, KEY_LENGTH, DIGEST)
    .toString("hex");
  return { hash, salt, iterations: HASH_ITERATIONS };
}

/**
 * Compare a plain-text password against a stored hash.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyPassword(plaintext: string, stored: HashedPassword): boolean {
  const candidate = crypto
    .pbkdf2Sync(plaintext, stored.salt, stored.iterations, KEY_LENGTH, DIGEST)
    .toString("hex");
  // Timing-safe compare to prevent oracle attacks
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(stored.hash, "hex"));
}

/** Estimate work factor (rounds) needed to keep hashing under target milliseconds. */
export function calibrateWorkFactor(targetMs: number): number {
  const start = Date.now();
  crypto.pbkdf2Sync("probe", "saltsalt", HASH_ITERATIONS, KEY_LENGTH, DIGEST);
  const elapsed = Date.now() - start;
  const ratio = targetMs / elapsed;
  return Math.max(SALT_ROUNDS, Math.round(HASH_ITERATIONS * ratio));
}
