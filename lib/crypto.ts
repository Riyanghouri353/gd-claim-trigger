// AES-256-GCM envelope for wallet private keys.
// Keys are stored ENCRYPTED in Supabase (claim_wallets.encrypted_key) and are
// only decrypted in server memory at claim time, using PROJECT_KEY from env.
// Format: iv_hex:authTag_hex:ciphertext_hex

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

function projectKey(): Buffer {
  const raw = (process.env.PROJECT_KEY || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch {
    /* fall through */
  }
  throw new Error('PROJECT_KEY must be 32 bytes, as 64 hex chars or base64');
}

export function encryptPrivateKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', projectKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
}

export function decryptPrivateKey(payload: string): string {
  const [ivH, tagH, ctH] = (payload || '').split(':');
  if (!ivH || !tagH || !ctH) throw new Error('malformed encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', projectKey(), Buffer.from(ivH, 'hex'));
  decipher.setAuthTag(Buffer.from(tagH, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctH, 'hex')), decipher.final()]).toString('utf8');
}

/** Non-revealing check: does the stored ciphertext decrypt to a key-shaped value? */
export function canDecrypt(payload: string): boolean {
  try {
    const plain = decryptPrivateKey(payload);
    return /^(0x)?[0-9a-fA-F]{64}$/.test(plain.trim());
  } catch {
    return false;
  }
}
