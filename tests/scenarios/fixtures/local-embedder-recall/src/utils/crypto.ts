/**
 * Cryptographic utility functions for application-level use.
 * Wraps Node.js crypto with consistent defaults.
 */
import crypto from "crypto";

export const ALGORITHM_AES_256_GCM = "aes-256-gcm";
export const IV_LENGTH_BYTES = 12;     // 96-bit nonce for GCM
export const AUTH_TAG_LENGTH_BYTES = 16;
export const KEY_LENGTH_BYTES = 32;    // 256-bit key

export interface EncryptResult {
  ciphertext: string;  // base64
  iv: string;          // base64
  authTag: string;     // base64
}

/**
 * Encrypt plaintext with AES-256-GCM using the provided key.
 * Returns ciphertext, IV, and authentication tag as base64 strings.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptResult {
  if (key.length !== KEY_LENGTH_BYTES) throw new Error(`Key must be ${KEY_LENGTH_BYTES} bytes`);
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM_AES_256_GCM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Decrypt an AES-256-GCM encrypted payload.
 * Throws if authentication fails (tampered ciphertext).
 */
export function decrypt(encResult: EncryptResult, key: Buffer): string {
  if (key.length !== KEY_LENGTH_BYTES) throw new Error(`Key must be ${KEY_LENGTH_BYTES} bytes`);
  const iv = Buffer.from(encResult.iv, "base64");
  const authTag = Buffer.from(encResult.authTag, "base64");
  const ciphertext = Buffer.from(encResult.ciphertext, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM_AES_256_GCM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

/**
 * Derive a symmetric key from a passphrase and salt using PBKDF2.
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, 200_000, KEY_LENGTH_BYTES, "sha256");
}

/** Generate a cryptographically random hex token of the specified byte length. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Constant-time equality check for string comparison (prevents timing attacks). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still do a dummy compare to take constant time
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}
