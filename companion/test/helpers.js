'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Point the companion at a throwaway data directory. Must be called before any
 * lib module is required, because paths.js reads the environment once.
 */
function useTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accountability-test-'));
  process.env.ACCOUNTABILITY_HOME = dir;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

module.exports = { useTempHome };
