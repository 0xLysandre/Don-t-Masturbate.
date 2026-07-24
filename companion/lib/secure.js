'use strict';

// All encryption here is AES-256-GCM as provided by Node's built-in `crypto`
// module (OpenSSL). No hand-rolled primitives, no custom constructions.

const fs = require('node:fs');
const {
  randomBytes,
  randomInt,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} = require('node:crypto');

const { HOME, KEY_FILE } = require('./paths');

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

// Password alphabet: unambiguous characters only, so the one-time reveal can be
// copied down by hand without 0/O or 1/l confusion.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_@#%+=';

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

let cachedKey = null;

/**
 * Loads the local master key, creating it on first use.
 *
 * The key lives next to the data as a 0600 file. That protects the vault from
 * casual snooping (another user account, a backup, a synced folder) — it does
 * not protect it from the owner of the machine, who can always read their own
 * files. See README "Threat model" for the honest version of this.
 */
function loadKey() {
  if (cachedKey) return cachedKey;
  ensureHome();
  if (!fs.existsSync(KEY_FILE)) {
    const key = randomBytes(KEY_BYTES);
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
    cachedKey = key;
    return key;
  }
  const key = fs.readFileSync(KEY_FILE);
  if (key.length !== KEY_BYTES) {
    throw new Error(`Key file ${KEY_FILE} is corrupt (expected ${KEY_BYTES} bytes).`);
  }
  cachedKey = key;
  return key;
}

/** Encrypts a UTF-8 string into a self-describing JSON envelope. */
function encrypt(plaintext, key = loadKey()) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  return {
    v: 1,
    alg: ALGO,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** Decrypts an envelope produced by `encrypt`. Throws if tampered with. */
function decrypt(envelope, key = loadKey()) {
  if (!envelope || envelope.alg !== ALGO) throw new Error('Unrecognised ciphertext envelope.');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}

/** Cryptographically random password, uniformly sampled (no modulo bias). */
function generatePassword(length = 24) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(0, ALPHABET.length)];
  return out;
}

/** Constant-time string comparison. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the timing does not leak the length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

module.exports = { ensureHome, loadKey, encrypt, decrypt, generatePassword, safeEqual };
