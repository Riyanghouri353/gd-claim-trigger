#!/usr/bin/env node
// One-time migration: encrypt your wallet keys and emit SQL INSERTs.
// Run LOCALLY (never on a server, never commit output):
//
//   PROJECT_KEY=<64-hex> WALLETS_JSON='[{"label":"Wallet 1","privateKey":"0x..."}]' node scripts/encrypt-wallets.mjs
//
// Then paste the printed INSERT statements into the Supabase SQL editor.
// The same PROJECT_KEY must be set as env var on Render.

import { createCipheriv, randomBytes } from 'crypto';

const keyHex = (process.env.PROJECT_KEY || '').trim();
if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
  console.error('ERROR: PROJECT_KEY must be 64 hex chars (32 bytes).');
  console.error('Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
const key = Buffer.from(keyHex, 'hex');

let wallets;
try {
  wallets = JSON.parse(process.env.WALLETS_JSON || '[]');
  if (!Array.isArray(wallets) || wallets.length === 0) throw new Error('empty');
} catch {
  console.error('ERROR: WALLETS_JSON must be a JSON array like [{"label":"Wallet 1","privateKey":"0x..."}]');
  process.exit(1);
}

const esc = (s) => String(s).replace(/'/g, "''");

console.log('-- Paste into Supabase SQL editor. Keys are AES-256-GCM ciphertext (iv:tag:data).');
for (const [i, w] of wallets.entries()) {
  if (!w.privateKey) {
    console.error(`ERROR: wallet ${i} has no privateKey`);
    process.exit(1);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(w.privateKey), 'utf8'), cipher.final()]);
  const payload = [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
  const label = w.label || `Wallet ${i + 1}`;
  const chains = Array.isArray(w.chains) && w.chains.length > 0 ? w.chains.join(',') : 'celo,xdc,fuse';
  console.log(
    `insert into claim_wallets (label, encrypted_key, chains) values ('${esc(label)}', '${payload}', '${esc(chains)}');`,
  );
}
console.error(`\nDone: ${wallets.length} INSERT statement(s) above.`);
