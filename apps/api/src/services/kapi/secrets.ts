/**
 * AES-256-GCM encryption for kapi env var secrets.
 *
 * The key is loaded lazily from KAPI_SECRET_KEY (base64 or hex, 32 bytes).
 * Ciphertext layout: [12-byte nonce][16-byte auth tag][ciphertext].
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const NONCE_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // try base64 first (44 chars for 32 raw bytes incl. padding)
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === 32) return decoded;
  }
  // fall back to hex
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  throw new Error('KAPI_SECRET_KEY must be 32 raw bytes encoded as base64 or hex');
}

export function getSecretKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.KAPI_SECRET_KEY;
  if (!raw) {
    throw new Error(
      'KAPI_SECRET_KEY is not set. Generate one with: openssl rand -base64 32'
    );
  }
  cachedKey = parseKey(raw);
  return cachedKey;
}

/**
 * 8-byte fingerprint of the active key. Stored in `settings` so we can detect
 * key mismatches before attempting to decrypt old ciphertext with a new key.
 */
export function getKeyFingerprint(): string {
  const key = getSecretKey();
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function isSecretKeyConfigured(): boolean {
  try {
    getSecretKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): Buffer {
  const key = getSecretKey();
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, encrypted]);
}

export function decryptSecret(blob: Buffer): string {
  const key = getSecretKey();
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new Error('Ciphertext too short — corrupt or wrong key');
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const ciphertext = blob.subarray(NONCE_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
