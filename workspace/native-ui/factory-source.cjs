'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The production bundle and Native browser fixtures run the same modules.
module.exports = () => ['run-activity.js', 'model-availability.js', 'response-model.js', 'generation-profiles.js', 'task-budget.js', 'source.js', 'result-preview.js', 'preview-selection.js']
  .map(file => fs.readFileSync(path.join(__dirname, file), 'utf8'))
  .join('\n');
