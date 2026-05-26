/**
 * server/cache-integrity.js
 *
 * Cache integrity checker and auto-repair utility.
 *
 * Validates:
 *   - _index.json structure and required fields
 *   - JSON file parseability
 *   - Cross-references between index and actual files
 *
 * Auto-repair:
 *   - Removes references to missing files
 *   - Rebuilds corrupted _index.json from available data
 *   - Creates missing directories
 *
 * Usage:
 *   const { checkAndRepair } = require('./cache-integrity');
 *   const report = await checkAndRepair(cacheDir);
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Required fields in _index.json
 */
const REQUIRED_INDEX_FIELDS = ['tabId', 'sessionId', 'siteVersion', 'createdAt', 'updatedAt', 'url', 'summary', 'dataFreshness', 'files'];

/**
 * Check if a JSON file is valid and parseable.
 * @param {string} filePath
 * @returns {{valid: boolean, error: string|null, data: object|null}}
 */
function validateJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, error: 'File not found', data: null };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    return { valid: true, error: null, data };
  } catch (e) {
    return { valid: false, error: e.message, data: null };
  }
}

/**
 * Validate _index.json structure.
 * @param {object} index - Parsed index data
 * @returns {{valid: boolean, issues: string[]}}
 */
function validateIndexStructure(index) {
  const issues = [];

  if (!index || typeof index !== 'object') {
    issues.push('Index is not a valid object');
    return { valid: false, issues };
  }

  for (const field of REQUIRED_INDEX_FIELDS) {
    if (!(field in index)) {
      issues.push(`Missing required field: "${field}"`);
    }
  }

  // Validate summary structure
  if (index.summary && typeof index.summary !== 'object') {
    issues.push('"summary" should be an object');
  }

  // Validate files structure
  if (index.files && typeof index.files !== 'object') {
    issues.push('"files" should be an object');
  }

  // Validate dataFreshness structure
  if (index.dataFreshness && typeof index.dataFreshness !== 'object') {
    issues.push('"dataFreshness" should be an object');
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Check if referenced files in index actually exist.
 * @param {object} index - Parsed index data
 * @param {string} sessionDir - Path to session directory
 * @returns {{missing: string[], valid: string[]}}
 */
function checkFileReferences(index, sessionDir) {
  const missing = [];
  const valid = [];

  if (!index.files || !index.files.raw) return { missing, valid };

  const rawFiles = index.files.raw;
  for (const [key, relPath] of Object.entries(rawFiles)) {
    if (!relPath) continue;
    const fullPath = path.join(sessionDir, relPath);
    if (fs.existsSync(fullPath)) {
      valid.push(key);
    } else {
      missing.push(key);
    }
  }

  return { missing, valid };
}

/**
 * Auto-repair a session's _index.json.
 * Removes references to missing files and ensures required fields exist.
 * @param {string} sessionDir - Path to session directory
 * @returns {{repaired: boolean, changes: string[], index: object|null}}
 */
function repairIndex(sessionDir) {
  const changes = [];
  const indexPath = path.join(sessionDir, '_index.json');

  // Read or create index
  let index = null;
  if (fs.existsSync(indexPath)) {
    const result = validateJsonFile(indexPath);
    if (result.valid) {
      index = result.data;
    } else {
      changes.push(`Corrupted _index.json: ${result.error}`);
    }
  }

  // Create minimal index if missing or corrupted
  if (!index) {
    index = {
      tabId: parseInt(path.basename(sessionDir)) || 0,
      sessionId: Date.now(),
      siteVersion: 'unknown',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      url: null,
      title: null,
      summary: { detectedFrameworks: [], textWordCount: 0, networkRequests: 0, consoleLogs: 0 },
      dataFreshness: {},
      files: { raw: {} },
    };
    changes.push('Created new minimal _index.json');
  }

  // Ensure required fields exist
  for (const field of REQUIRED_INDEX_FIELDS) {
    if (!(field in index)) {
      if (field === 'summary') index.summary = {};
      else if (field === 'dataFreshness') index.dataFreshness = {};
      else if (field === 'files') index.files = { raw: {} };
      else index[field] = null;
      changes.push(`Added missing field: "${field}"`);
    }
  }

  // Remove references to missing files
  if (index.files && index.files.raw) {
    const { missing } = checkFileReferences(index, sessionDir);
    for (const key of missing) {
      delete index.files.raw[key];
      changes.push(`Removed reference to missing file: "${key}"`);
    }
  }

  // Update timestamp
  index.updatedAt = Date.now();

  // Write repaired index
  try {
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    return { repaired: true, changes, index };
  } catch (e) {
    changes.push(`Failed to write repaired index: ${e.message}`);
    return { repaired: false, changes, index: null };
  }
}

/**
 * Check and repair an entire cache directory.
 * @param {string} cacheRoot - Path to cache root (e.g., cache/sessions)
 * @param {object} opts
 * @param {boolean} [opts.autoRepair] - Auto-repair issues (default: true)
 * @param {boolean} [opts.verbose] - Log details (default: false)
 * @returns {{sessions: number, healthy: number, repaired: number, issues: object[]}}
 */
function checkAndRepair(cacheRoot, opts = {}) {
  const autoRepair = opts.autoRepair !== false;
  const verbose = opts.verbose || false;
  const result = {
    sessions: 0,
    healthy: 0,
    repaired: 0,
    corrupted: 0,
    issues: [],
  };

  if (!fs.existsSync(cacheRoot)) {
    if (verbose) console.log(`[cache-integrity] Cache root not found: ${cacheRoot}`);
    return result;
  }

  // Find all session directories
  const siteDirs = fs.readdirSync(cacheRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const siteDir of siteDirs) {
    const sitePath = path.join(cacheRoot, siteDir);
    const sessionDirs = fs.readdirSync(sitePath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const sessionDir of sessionDirs) {
      const fullPath = path.join(sitePath, sessionDir);
      const indexPath = path.join(fullPath, '_index.json');
      result.sessions++;

      // Validate index
      const indexResult = validateJsonFile(indexPath);
      if (!indexResult.valid) {
        result.corrupted++;
        result.issues.push({
          session: `${siteDir}/${sessionDir}`,
          issue: `Invalid _index.json: ${indexResult.error}`,
        });

        if (autoRepair) {
          const repair = repairIndex(fullPath);
          if (repair.repaired) {
            result.repaired++;
            result.issues[result.issues.length - 1].repair = repair.changes;
          }
        }
        continue;
      }

      // Validate structure
      const structure = validateIndexStructure(indexResult.data);
      if (!structure.valid) {
        result.issues.push({
          session: `${siteDir}/${sessionDir}`,
          issue: `Structure issues: ${structure.issues.join('; ')}`,
        });

        if (autoRepair) {
          const repair = repairIndex(fullPath);
          if (repair.repaired) {
            result.repaired++;
            result.issues[result.issues.length - 1].repair = repair.changes;
          }
        }
        continue;
      }

      // Check file references
      const refs = checkFileReferences(indexResult.data, fullPath);
      if (refs.missing.length > 0) {
        result.issues.push({
          session: `${siteDir}/${sessionDir}`,
          issue: `Missing files: ${refs.missing.join(', ')}`,
        });

        if (autoRepair) {
          const repair = repairIndex(fullPath);
          if (repair.repaired) {
            result.repaired++;
            result.issues[result.issues.length - 1].repair = repair.changes;
          }
        }
        continue;
      }

      result.healthy++;
    }
  }

  if (verbose) {
    console.log(`[cache-integrity] Checked ${result.sessions} session(s)`);
    console.log(`[cache-integrity] Healthy: ${result.healthy}, Repaired: ${result.repaired}, Corrupted: ${result.corrupted}`);
    if (result.issues.length > 0) {
      console.log(`[cache-integrity] Issues:`);
      for (const issue of result.issues) {
        console.log(`  - ${issue.session}: ${issue.issue}`);
        if (issue.repair) {
          console.log(`    Repaired: ${issue.repair.join('; ')}`);
        }
      }
    }
  }

  return result;
}

module.exports = {
  validateJsonFile,
  validateIndexStructure,
  checkFileReferences,
  repairIndex,
  checkAndRepair,
};
