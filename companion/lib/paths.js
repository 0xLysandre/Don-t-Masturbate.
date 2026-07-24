'use strict';

const os = require('node:os');
const path = require('node:path');

const HOME =
  process.env.ACCOUNTABILITY_HOME || path.join(os.homedir(), '.accountability-companion');

const PORT = Number(process.env.ACCOUNTABILITY_PORT || 7373);

module.exports = {
  HOME,
  PORT,
  KEY_FILE: path.join(HOME, 'key.bin'),
  DATA_FILE: path.join(HOME, 'data.enc.json'),
};
