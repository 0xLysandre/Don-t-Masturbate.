'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DATA_FILE } = require('./paths');
const { ensureHome, loadKey, encrypt, decrypt } = require('./secure');

const SCHEMA_VERSION = 1;

const EXAMPLE_BLOCKLIST = ['example-adult-site.com', 'another-example.net'];
const EXAMPLE_KEYWORDS = ['example flagged phrase', 'another flagged phrase'];

function defaultState() {
  return {
    version: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    setupComplete: false,
    cooldownHours: 12,
    blocklist: [],
    keywords: [],
    session: { active: false, startedAt: null, endsAt: null, endedAt: null, endedReason: null },
    // vault.secret holds the AES-GCM envelope for the password. It is kept as
    // ciphertext even in memory so a stray JSON.stringify of the state can
    // never leak the plaintext into an API response or a log line.
    vault: { secret: null, createdAt: null, rotatedAt: null },
    unlockRequests: [],
    checkins: [],
  };
}

/**
 * The whole state file is a single AES-256-GCM envelope on disk. Writes are
 * atomic (temp file + rename) so a crash mid-write cannot truncate the vault.
 */
class Store {
  constructor(file = DATA_FILE) {
    this.file = file;
    this.key = loadKey();
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return defaultState();
    const raw = fs.readFileSync(this.file, 'utf8');
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error(`Data file ${this.file} is not valid JSON.`);
    }
    const state = JSON.parse(decrypt(envelope, this.key));
    return { ...defaultState(), ...state };
  }

  save() {
    ensureHome();
    const envelope = encrypt(JSON.stringify(this.state), this.key);
    const tmp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.state;
  }

  exists() {
    return fs.existsSync(this.file);
  }
}

module.exports = { Store, defaultState, EXAMPLE_BLOCKLIST, EXAMPLE_KEYWORDS, SCHEMA_VERSION };
