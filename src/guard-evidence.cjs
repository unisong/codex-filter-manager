'use strict';

// Keep the upstream scorer unchanged. This layer records bounded numeric
// evidence and checks whether averaging hid a conflicting individual sample.
let modelIds;
const SAMPLE_COUNT = 3;
const MAX_NUMBERS = 664;
const CANDIDATE_COUNT = 3;

function invalid() {
  const error = new Error('检测数字证据无效，未能验证模型一致性。');
  error.code = 'guard_unverified'; error.status = 409;
  return error;
}

function plain(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  return names.length === keys.length && names.every(key => keys.includes(key)
    && Object.hasOwn(descriptors[key], 'value'));
}

function array(value, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return false;
  // Reject sparse arrays and extra properties rather than silently dropping
  // them when evidence is serialized for history or exported to the user.
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys.includes('length')
    && Array.from({length: value.length}, (_, index) => String(index)).every(key =>
      Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

function probability(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }
function model(value) {
  if (typeof value !== 'string' || value.length > 160) return false;
  // A missing/corrupt bank must reach the guard's existing recoverable fatal
  // state rather than crashing management-page startup while requiring us.
  if (!modelIds) {
    try { modelIds = new Set(require('../vendor/modeltrace/unified_bank.json').models.map(item => item.id)); }
    catch { return false; }
  }
  return modelIds.has(value);
}
function identical(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function repeated(samples) {
  return samples.some((sample, index) => samples.slice(0, index).some(previous => identical(sample.numbers, previous.numbers)));
}
function conflicting(sample) {
  // When the requested model is first, its weight equals score, so it cannot
  // satisfy expectedScore <= .15 alongside score >= .8. These are single-
  // sample weights (beta for one query), not a fabricated three-query result.
  return sample.score >= 0.8 && sample.expectedScore <= 0.15 && sample.score - sample.expectedScore >= 0.65;
}

function summary(result, expected) {
  const ordered = [...result.results].sort((left, right) => right.probability - left.probability);
  const requested = ordered.find(item => item.model === expected);
  if (!requested || ordered.length < CANDIDATE_COUNT) throw invalid();
  return {prediction: ordered[0].model, score: ordered[0].probability, expectedScore: requested.probability,
    topCandidates: ordered.slice(0, CANDIDATE_COUNT).map(item => ({model: item.model, score: item.probability}))};
}

function validSummary(value, keys) {
  if (!plain(value, keys) || !model(value.prediction) || !probability(value.score)
      || !probability(value.expectedScore) || value.expectedScore > value.score
      || !array(value.topCandidates, CANDIDATE_COUNT, CANDIDATE_COUNT)) return false;
  const seen = new Set();
  let last = 1, sum = 0;
  for (const candidate of value.topCandidates) {
    if (!plain(candidate, ['model', 'score']) || !model(candidate.model) || !probability(candidate.score)
        || candidate.score > last || seen.has(candidate.model)) return false;
    seen.add(candidate.model); last = candidate.score; sum += candidate.score;
  }
  return sum <= 1 + 1e-12 && value.prediction === value.topCandidates[0].model && value.score === value.topCandidates[0].score;
}

function validateEvidence(value) {
  if (!plain(value, ['schemaVersion', 'sampling', 'samples', 'aggregate', 'flags'])
      || value.schemaVersion !== 1 || value.sampling !== 'independent'
      || !array(value.samples, SAMPLE_COUNT, SAMPLE_COUNT)
      || !plain(value.flags, ['conflictingSamples', 'repeatedSamples'])
      || typeof value.flags.conflictingSamples !== 'boolean' || typeof value.flags.repeatedSamples !== 'boolean'
      || !validSummary(value.aggregate, ['prediction', 'score', 'expectedScore', 'topCandidates'])) return false;
  for (const sample of value.samples) {
    if (!validSummary(sample, ['expectedCount', 'actualCount', 'numbers', 'prediction', 'score', 'expectedScore', 'topCandidates'])
        || !Number.isInteger(sample.expectedCount) || sample.expectedCount < 292 || sample.expectedCount > 332
        || !Number.isInteger(sample.actualCount) || !array(sample.numbers, 80, MAX_NUMBERS)
        || sample.actualCount !== sample.numbers.length
        || sample.actualCount < Math.max(80, Math.ceil(sample.expectedCount * 0.55))
        || sample.actualCount > sample.expectedCount * 2
        || sample.numbers.some(number => !Number.isInteger(number) || number < 1 || number > 355)) return false;
  }
  return value.flags.conflictingSamples === value.samples.some(conflicting)
    && value.flags.repeatedSamples === repeated(value.samples);
}

function analyzeSamples(outputs, bank, expected) {
  if (!array(outputs, SAMPLE_COUNT, SAMPLE_COUNT) || !model(expected)) throw invalid();
  // The guard verifies pinned artifact hashes before starting an analysis.
  // Defer loading executable vendor code until that verification has run.
  const scorer = require('../vendor/modeltrace/fingerprint-core.mjs');
  const samples = outputs.map(output => {
    if (!output || typeof output.text !== 'string' || output.text.length > 65536
        || !Number.isInteger(output.expected_count) || output.expected_count < 292 || output.expected_count > 332) throw invalid();
    const numbers = scorer.parseNumbers(output.text);
    if (numbers.length < Math.max(80, Math.ceil(output.expected_count * 0.55))
        || numbers.length > Math.min(MAX_NUMBERS, output.expected_count * 2)) throw invalid();
    return {expectedCount: output.expected_count, actualCount: numbers.length, numbers,
      ...summary(scorer.analyzeGlobalOutputs([output], bank), expected)};
  });
  const result = scorer.analyzeGlobalOutputs(outputs, bank);
  const evidence = {schemaVersion: 1, sampling: 'independent', samples, aggregate: summary(result, expected),
    flags: {conflictingSamples: samples.some(conflicting), repeatedSamples: repeated(samples)}};
  if (!validateEvidence(evidence)) throw invalid();
  return {result, evidence};
}

module.exports = {analyzeSamples, validateEvidence};
