#!/usr/bin/env node
/**
 * scripts/download-model-simple.js
 * 
 * Downloads MiniLM ONNX model from Hugging Face using only Node.js built-ins.
 * No external dependencies (no @xenova/transformers, no requests, no axios).
 * 
 * Usage:
 *   node scripts/download-model-simple.js
 */
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MODEL_NAME = 'paraphrase-multilingual-MiniLM-L12-v2';
const HF_REPO = `Xenova/${MODEL_NAME}`;
const BASE_URL = `https://huggingface.co/${HF_REPO}/resolve/main`;

const FILES_TO_DOWNLOAD = [
  { path: 'onnx/model_quantized.onnx', size: '~50MB' },
  { path: 'tokenizer.json', size: '~2MB' },
  { path: 'tokenizer_config.json', size: '~1KB' },
  { path: 'config.json', size: '~1KB' },
  { path: 'special_tokens_map.json', size: '~1KB' },
  { path: 'unigram.json', size: '~200KB' },
];

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SAVE_BASE_DIR = path.join(PROJECT_ROOT, '.model-cache', 'models', 'Xenova', MODEL_NAME);

/**
 * Download a file with progress reporting and redirect handling
 */
function downloadFile(url, destPath, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many redirects'));
  }
  
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    
    const req = mod.get(url, { timeout: 30000 }, (res) => {
      // Handle redirects
      if (res.statusCode === 302 || res.statusCode === 301 || res.statusCode === 307 || res.statusCode === 308) {
        res.resume();
        let redirectUrl = res.headers.location;
        if (!redirectUrl) {
          return reject(new Error(`Redirect without location header: ${url}`));
        }
        // Handle relative redirects
        if (!redirectUrl.startsWith('http')) {
          const urlObj = new URL(url);
          redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
        }
        return downloadFile(redirectUrl, destPath, redirectCount + 1).then(resolve).catch(reject);
      }
      
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      }
      
      const totalSize = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      let lastPercent = -1;
      
      // Ensure directory exists
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      
      const fileStream = fs.createWriteStream(destPath);
      
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalSize > 0) {
          const percent = Math.floor((downloaded / totalSize) * 100);
          if (percent !== lastPercent && percent % 10 === 0) {
            process.stdout.write(`\r  Progress: ${percent}%`);
            lastPercent = percent;
          }
        }
      });
      
      res.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        process.stdout.write(`\r  Progress: 100%\n`);
        resolve();
      });
      
      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function main() {
  console.log('[whiskor] Downloading MiniLM model...');
  console.log(`[whiskor] Destination: ${SAVE_BASE_DIR}`);
  console.log(`[whiskor] Source: ${BASE_URL}`);
  console.log('');
  
  let successCount = 0;
  let failCount = 0;
  
  for (const file of FILES_TO_DOWNLOAD) {
    const url = `${BASE_URL}/${file.path}`;
    const destPath = path.join(SAVE_BASE_DIR, file.path);
    const fileName = path.basename(file.path);
    
    console.log(`Downloading ${fileName} (${file.size})...`);
    
    try {
      await downloadFile(url, destPath);
      console.log(`✓ ${fileName} downloaded successfully\n`);
      successCount++;
    } catch (err) {
      console.error(`✗ Failed to download ${fileName}: ${err.message}\n`);
      failCount++;
    }
  }
  
  console.log('');
  console.log(`[whiskor] Download complete: ${successCount} succeeded, ${failCount} failed`);
  
  if (failCount > 0) {
    console.error('[whiskor] Some files failed. Check your network or Hugging Face access.');
    process.exit(1);
  } else {
    console.log('[whiskor] Model is ready!');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[whiskor] Fatal error:', err.message);
  process.exit(1);
});
