'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEGACY_DIR = path.join(os.homedir(), '.accountability-companion');

/**
 * Where the encrypted state lives.
 *
 * New installs follow the XDG base directory spec ($XDG_STATE_HOME, falling
 * back to ~/.local/state) — this is machine-local mutable state, not config.
 * An existing ~/.accountability-companion keeps being used, so nobody's vault
 * moves out from under them on upgrade.
 */
function resolveHome() {
  if (process.env.ACCOUNTABILITY_HOME) return process.env.ACCOUNTABILITY_HOME;
  try {
    if (fs.existsSync(LEGACY_DIR)) return LEGACY_DIR;
  } catch {
    /* unreadable home: fall through to the XDG path */
  }
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'accountability-companion');
}

const HOME = resolveHome();

const PORT = Number(process.env.ACCOUNTABILITY_PORT || 7373);

module.exports = {
  HOME,
  PORT,
  LEGACY_DIR,
  KEY_FILE: path.join(HOME, 'key.bin'),
  DATA_FILE: path.join(HOME, 'data.enc.json'),
};
