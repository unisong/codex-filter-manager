'use strict';

// Keep the public CLI path stable for launchers and existing installations.
const filter = require('./src/filter.cjs');
if (require.main === module) filter.main().catch(error => {
  console.error('Filter: ' + error.message);
  process.exitCode = 1;
});
module.exports = filter;
