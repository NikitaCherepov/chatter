'use strict';
const fs = require('node:fs');
const path = require('node:path');
// An unexpected Docker/host restart must not start writers between DB and env swaps.
const marker = path.join(path.dirname(process.env.API_DB_PATH || '/data/chatter.db'), '.secret-rotation-maintenance');
function start() {
  if (fs.existsSync(marker)) return setTimeout(start, 1000);
  require('../dist/server.js');
}
start();
