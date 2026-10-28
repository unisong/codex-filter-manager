'use strict';
// Offline fixtures derived from the public reference histograms, not suppliers.
const bank = require('../../vendor/modeltrace/unified_bank.json');
function numbers(model, index = 0) {
  const entry = bank.models.find(item => item.id === model);
  if (!entry) throw new Error('Unknown fixture model');
  const total = entry.counts.reduce((sum, count) => sum + count, 0);
  const values = Array.from({length: 300}, (_, position) => {
    let quantile = (position + (index % 3 + 1) / 7) / 300 * total;
    for (let bin = 0; bin < entry.counts.length; bin++) {
      quantile -= entry.counts[bin];
      if (quantile < 0) return bin + 1;
    }
    return 355;
  });
  const offset = Math.floor(index / 3) % values.length;
  return values.slice(offset).concat(values.slice(0, offset));
}
function outputs(model, start = 0) {
  return Array.from({length: 3}, (_, index) => ({expected_count: 300, text: numbers(model, start + index).join(',')}));
}
module.exports = {bank, numbers, outputs};
if (require.main === module) {
  const {analyzeSamples} = require('../../src/guard-evidence.cjs');
  const expected = 'gpt-6-astra';
  const pass = outputs(expected), different = outputs('gpt-6-luna');
  console.log(JSON.stringify({
    pass: analyzeSamples(pass, bank, expected).evidence,
    different: analyzeSamples(different, bank, expected).evidence,
    conflict: analyzeSamples([pass[0], pass[1], different[2]], bank, expected).evidence
  }));
}
