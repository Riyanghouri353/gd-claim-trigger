// Recovery engine checks. Prereq: transpile the TS libs first:
//   npx tsc lib/recovery.ts lib/crypto.ts --outDir /tmp/rectest --module commonjs \
//     --target es2022 --moduleResolution node --esModuleInterop --skipLibCheck
// Then: node tests/recovery.test.mjs
import { createRequire } from 'module';
import { Wallet } from 'ethers';
const require = createRequire(import.meta.url);
let rec;
try { rec = require('/tmp/rectest/recovery.js'); } catch { console.log('SKIP: /tmp/rectest/recovery.js missing — transpile first (see header)'); process.exit(0); }
const { parseTemplate, candidateKey, deriveBatch, addressFromKeyHex, encodeAggregate3, decodeAggregate3 } = rec;

let fails = 0;
const eq = (a, b, msg) => { if (a !== b) { console.log('FAIL', msg, a, '!==', b); fails++; } };

// candidate counting: template 'ab??' style positions (use a 64-char template)
const info = parseTemplate('11'.repeat(31) + '??'); // last 2 unknown
eq(info.total.toString(), '256', 'total');
eq(candidateKey(info, 0n), '11'.repeat(31) + '00', 'cand 0');
eq(candidateKey(info, 255n), '11'.repeat(31) + 'ff', 'cand 255');
eq(candidateKey(info, 0x1an), '11'.repeat(31) + '1a', 'cand 26');

// suffix fast path vs ethers, starting mid-space
const batch = deriveBatch(info, 250n, 6);
for (const c of batch) eq(c.address, new Wallet('0x' + c.keyHex).address.toLowerCase(), 'suffix addr ' + c.index);

// generic path: unknown digit in the middle
const mid = parseTemplate('22'.repeat(10) + '?' + '33'.repeat(21) + '3');
const mb = deriveBatch(mid, 5n, 4);
for (const c of mb) eq(c.address, new Wallet('0x' + c.keyHex).address.toLowerCase(), 'mid addr ' + c.index);

// single-key helper vs ethers
eq(addressFromKeyHex('00'.repeat(31) + '01'), new Wallet('0x' + '00'.repeat(31) + '01').address.toLowerCase(), 'key 1 address');

// derivation speed (suffix path)
const big = parseTemplate('ab'.repeat(30) + '????');
const t0 = Date.now(); deriveBatch(big, 0n, 3000); const ms = Date.now() - t0;
console.log(`derive suffix: ${Math.round(3000 / (ms / 1000))}/s`);

// multicall codec: selector + a synthetic aggregate3 result round-trip
const enc = encodeAggregate3(['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002']);
if (!enc.startsWith('0x82ad56cb')) { console.log('FAIL aggregate3 selector'); fails++; }
const W = (n) => BigInt(n).toString(16).padStart(64, '0');
// build a fake result: two (true, uint256) entries with balances 5 and 0
const tail = (v) => W(1) + W(64) + W(32) + W(v);
const fake = '0x' + W(32) + W(2) + W(64) + W(64 + 128) + tail(5) + tail(0);
const dec = decodeAggregate3(fake, 2);
eq(dec[0].toString(), '5', 'decode bal 0');
eq(dec[1].toString(), '0', 'decode bal 1');

console.log(fails === 0 ? 'ALL RECOVERY TESTS PASSED' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);
