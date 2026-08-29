/**
 * The user's provider key, encrypted before it enters Redis (D5).
 *
 * The plaintext exists in exactly three places, all transient: the
 * authenticated app→worker POST body, this process's memory between receipt
 * and encryption (and again between decryption and the child's stdin), and
 * the job child's memory. Never argv, never env, never a file, never a Redis
 * payload — the payload carries only this module's output.
 *
 * AES-256-GCM, key derived from MOTION_WORKER_KEY_SECRET by SHA-256. Output
 * shape: base64(iv[12] || tag[16] || ciphertext) — one string, self-carrying.
 */

import crypto from 'node:crypto';

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest();
}

export function encryptKey(plaintext, secret) {
  if (!plaintext) throw new Error('encryptKey: empty plaintext');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptKey(encoded, secret) {
  const raw = Buffer.from(String(encoded), 'base64');
  if (raw.length < 12 + 16 + 1) throw new Error('decryptKey: payload too short');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
