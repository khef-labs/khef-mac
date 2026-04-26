/**
 * Credential encryption for dbx connections.
 * AES-256-GCM with a local key stored in ~/.khef/secrets.key
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../../lib/logger';

const log = logger.child({ component: 'dbx-crypto' });

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits for GCM
const AUTH_TAG_LENGTH = 16;

const KEY_DIR = join(homedir(), '.khef');
const KEY_FILE = join(KEY_DIR, 'secrets.key');

let cachedKey: Buffer | null = null;

function getOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey;

  if (existsSync(KEY_FILE)) {
    cachedKey = readFileSync(KEY_FILE);
    if (cachedKey.length !== KEY_LENGTH) {
      log.warn('Invalid key length in secrets.key, regenerating');
      cachedKey = null;
    }
  }

  if (!cachedKey) {
    cachedKey = randomBytes(KEY_LENGTH);
    mkdirSync(KEY_DIR, { recursive: true });
    writeFileSync(KEY_FILE, cachedKey, { mode: 0o600 });
    log.info('Generated new encryption key at ~/.khef/secrets.key');
  }

  return cachedKey;
}

/**
 * Encrypt a JSON-serializable object.
 * Returns a base64 string containing iv + authTag + ciphertext.
 */
export function encrypt(data: Record<string, any>): string {
  const key = getOrCreateKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: iv (12) + authTag (16) + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64 string back to the original object.
 * Returns null if decryption fails (wrong key, corrupted data).
 */
export function decrypt(encoded: string): Record<string, any> | null {
  try {
    const key = getOrCreateKey();
    const packed = Buffer.from(encoded, 'base64');

    if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      return null;
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    log.warn({ err }, 'Failed to decrypt credentials');
    return null;
  }
}

/**
 * Check if a string looks like encrypted data (base64 with sufficient length).
 */
export function isEncrypted(value: string): boolean {
  if (typeof value !== 'string') return false;
  // Minimum: iv(12) + tag(16) + at least 1 byte ciphertext = 29 bytes → ~40 base64 chars
  return value.length >= 40 && /^[A-Za-z0-9+/=]+$/.test(value);
}
