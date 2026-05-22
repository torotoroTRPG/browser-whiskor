/**
 * tests/e2e/global-setup.js
 *
 * Runs once before all E2E tests:
 *   1. Copies extension/ to tests/tmp/e2e-extension/ (safe sandbox)
 *   2. Syncs shared/injected/ into the sandbox (incremental)
 *   3. Verifies manifest.json exists in sandbox
 *   4. Cleans up old test artifacts
 *
 * This ensures:
 *   - The real extension/ directory is NEVER modified by tests
 *   - AI agents won't accidentally edit extension/ thinking it's the source of truth
 *   - Tests always run with the latest shared/ code
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

const EXTENSION_SRC = path.join(ROOT, 'extension');
const SANDBOX_DIR = path.join(ROOT, 'tests', 'tmp', 'e2e-extension');
const SHARED_SRC = path.join(ROOT, 'shared', 'injected');
const SANDBOX_INJECTED = path.join(SANDBOX_DIR, 'injected');

/**
 * Recursively copy a directory, preserving structure.
 * Only copies files that are new or changed (incremental).
 */
function copyDirIncremental(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirIncremental(srcPath, destPath);
    } else {
      // Only copy if file doesn't exist or content differs
      const shouldCopy = !fs.existsSync(destPath) ||
        fs.statSync(srcPath).mtimeMs > fs.statSync(destPath).mtimeMs;

      if (shouldCopy) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

/**
 * Sync shared/injected/ into the sandbox's injected/ directory.
 * Only copies changed files (incremental sync).
 */
function syncSharedToSandbox() {
  if (!fs.existsSync(SHARED_SRC)) {
    console.log('⚠ shared/injected/ not found, skipping sync');
    return;
  }

  if (!fs.existsSync(SANDBOX_INJECTED)) {
    fs.mkdirSync(SANDBOX_INJECTED, { recursive: true });
  }

  const sharedFiles = getAllFiles(SHARED_SRC);
  let synced = 0;

  for (const relPath of sharedFiles) {
    const srcFile = path.join(SHARED_SRC, relPath);
    const destFile = path.join(SANDBOX_INJECTED, relPath);

    // Ensure parent directory exists
    const destDir = path.dirname(destFile);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Only copy if changed
    const shouldCopy = !fs.existsSync(destFile) ||
      fs.statSync(srcFile).mtimeMs > fs.statSync(destFile).mtimeMs;

    if (shouldCopy) {
      fs.copyFileSync(srcFile, destFile);
      synced++;
    }
  }

  console.log(`  Synced ${synced} shared file(s) to sandbox`);
}

/**
 * Get all relative file paths in a directory (recursive).
 */
function getAllFiles(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath, base));
    } else {
      files.push(path.relative(base, fullPath));
    }
  }

  return files;
}

/**
 * Remove stale files from sandbox that no longer exist in source.
 */
function removeStaleFiles(sandboxDir, sourceDir) {
  if (!fs.existsSync(sandboxDir)) return;

  const sandboxFiles = getAllFiles(sandboxDir);
  const sourceFiles = new Set(getAllFiles(sourceDir));

  for (const relPath of sandboxFiles) {
    if (!sourceFiles.has(relPath)) {
      const staleFile = path.join(sandboxDir, relPath);
      fs.unlinkSync(staleFile);
    }
  }
}

export default async function globalSetup() {
  console.log('\n🔧 E2E Setup: Preparing extension sandbox...');

  // Ensure tmp directory exists
  const tmpDir = path.join(ROOT, 'tests', 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  // Step 1: Copy extension/ to sandbox (incremental)
  console.log('  Copying extension/ to sandbox...');
  copyDirIncremental(EXTENSION_SRC, SANDBOX_DIR);

  // Step 2: Sync shared/ into sandbox (overwrites with latest shared code)
  console.log('  Syncing shared/ into sandbox...');
  syncSharedToSandbox();

  // Step 4: Verify manifest exists
  const manifestPath = path.join(SANDBOX_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('❌ manifest.json not found in sandbox after copy');
    process.exit(1);
  }

  // Step 5: Clean up old e2e profile data (but keep directory)
  const profileDir = path.join(ROOT, 'tests', 'tmp', 'e2e-profile');
  if (fs.existsSync(profileDir)) {
    try {
      const files = fs.readdirSync(profileDir);
      for (const file of files) {
        const filePath = path.join(profileDir, file);
        if (fs.statSync(filePath).isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  console.log(`✅ Sandbox ready at: ${path.relative(ROOT, SANDBOX_DIR)}`);
  console.log('');

  // Global teardown
  return async function globalTeardown() {
    // Clean up e2e profile but keep sandbox for debugging if needed
    try {
      if (fs.existsSync(profileDir)) {
        const files = fs.readdirSync(profileDir);
        for (const file of files) {
          const filePath = path.join(profileDir, file);
          if (fs.statSync(filePath).isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          }
        }
      }
    } catch {
      // Ignore
    }
  };
}
