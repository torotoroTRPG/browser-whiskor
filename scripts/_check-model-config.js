'use strict';
const fs = require('fs');

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const modelName = cfg?.intelligence?.searchClassifier?.miniLM?.model || '';
const cacheDir  = cfg?.intelligence?.searchClassifier?.miniLM?.modelCacheDir || '.model-cache';

// 1. model name must include org/ prefix
if (!modelName.includes('/')) {
  console.error('FAIL: config.json model missing org/ prefix: "' + modelName + '"');
  process.exit(1);
}

const [orgName, baseName] = modelName.split('/');

// 2. download-model.js must declare MODEL_NAME = baseName (no org prefix)
//    and SAVE_BASE_DIR must use path.join(..., cacheDir, orgName, MODEL_NAME)
//    @xenova/transformers FileCache key = path.join(cacheDir, modelName, file)
//    where modelName = "Xenova/baseName", so effective dir = cacheDir/Xenova/baseName

const dmSrc = fs.readFileSync('scripts/download-model.js', 'utf8');

// Check MODEL_NAME declaration
const modelNameDecl = dmSrc.match(/const\s+MODEL_NAME\s*=\s*['"]([^'"]+)['"]/);
if (!modelNameDecl) {
  console.error('FAIL: MODEL_NAME declaration not found in download-model.js');
  process.exit(1);
}
if (modelNameDecl[1] !== baseName) {
  console.error('FAIL: MODEL_NAME in download-model.js ("' + modelNameDecl[1] + '") != baseName from config ("' + baseName + '")');
  process.exit(1);
}

// Check SAVE_BASE_DIR contains the right path segments (as string literals + MODEL_NAME variable)
const saveDirLine = dmSrc.match(/const\s+SAVE_BASE_DIR\s*=\s*path\.join\(([^)]+)\)/);
if (!saveDirLine) {
  console.error('FAIL: SAVE_BASE_DIR not found in download-model.js');
  process.exit(1);
}
const args = saveDirLine[1];
const hasModelNameVar = /\bMODEL_NAME\b/.test(args);
const literals = (args.match(/['"][^'"]+['"]/g) || []).map(s => s.slice(1, -1));

if (!literals.includes(cacheDir)) {
  console.error('FAIL: SAVE_BASE_DIR missing cacheDir segment "' + cacheDir + '" — got: ' + JSON.stringify(literals));
  process.exit(1);
}
if (!literals.includes(orgName)) {
  console.error('FAIL: SAVE_BASE_DIR missing org segment "' + orgName + '" — got: ' + JSON.stringify(literals));
  process.exit(1);
}
if (!hasModelNameVar) {
  console.error('FAIL: SAVE_BASE_DIR missing MODEL_NAME variable — got: ' + args.trim());
  process.exit(1);
}
// Ensure no extra path segments between cacheDir and orgName (e.g. "models")
const idxCache = literals.indexOf(cacheDir);
const idxOrg   = literals.indexOf(orgName);
if (idxOrg - idxCache !== 1) {
  console.error('FAIL: unexpected segment between "' + cacheDir + '" and "' + orgName + '" in SAVE_BASE_DIR — got: ' + JSON.stringify(literals));
  process.exit(1);
}

console.log('ok  model=' + modelName + '  SAVE_BASE_DIR=.../' + [cacheDir, orgName, baseName].join('/'));
