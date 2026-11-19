'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The production bundle and Native browser fixtures run the same modules.
module.exports = () => ['run-activity.js', 'model-availability.js', 'response-model.js', 'source.js', 'result-preview.js']
  .map(file => fs.readFileSync(path.join(__dirname, file), 'utf8'))
  .join('\n');
