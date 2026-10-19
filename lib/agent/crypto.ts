import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

function masterKey(): Buffer {
  const hex = process.env.VAULT_KEY || "";
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error("VAULT_KEY must be 64 hex characters (32 bytes). Generate with: openssl rand -hex 32");
  }
  return buf;
}

export interface EncryptedSecret {
  enc: string;
  iv: string;
  tag: string;
}

/** AES-256-GCM encrypt a Groq API key. Master key lives in VAULT_KEY env var. */
export function encryptSecret(plain: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    enc: enc.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

/** Decrypt. Throws if VAULT_KEY is wrong or data was tampered with. */
export function decryptSecret(s: EncryptedSecret): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(s.iv, "hex"));
  decipher.setAuthTag(Buffer.from(s.tag, "hex"));
  const out = Buffer.concat([
    decipher.update(Buffer.from(s.enc, "hex")),
    decipher.final(),
  ]);
  return out.toString("utf8");
}
