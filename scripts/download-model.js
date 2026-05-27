/**
 * scripts/download-model.js
 * 
 * Pre-downloads the ONNX model from Hugging Face Hub.
 * This prevents the first MCP request from timing out while downloading.
 * Requires NO authentication (uses public models).
 */
'use strict';

const { pipeline, env } = require('@xenova/transformers');
const path = require('path');
const fs = require('fs');

async function downloadModel() {
  console.log('[whiskor] Pre-fetching MiniLM embedding model...');
  console.log('[whiskor] Note: Downloading from Hugging Face Hub (Public/No Auth Required).');
  
  const cacheDir = path.resolve(process.cwd(), '.model-cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  
  // Set Transformers.js cache directory
  env.cacheDir = cacheDir;

  const modelName = 'paraphrase-multilingual-MiniLM-L12-v2';
  
  try {
    const start = Date.now();
    // Initialize pipeline to trigger download
    await pipeline('feature-extraction', modelName, {
      quantized: true,
      progress_callback: (info) => {
        if (info.status === 'progress') {
          process.stdout.write(`\rDownloading ${info.file}: ${Math.round(info.progress)}%`);
        } else if (info.status === 'done') {
          process.stdout.write(`\rDownloaded ${info.file} (100%)\n`);
        }
      }
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[whiskor] Model ${modelName} is ready! (Cache: ${cacheDir}, took ${elapsed}s)`);
  } catch (err) {
    console.error('\n[whiskor] Failed to download model:', err.message);
    process.exit(1);
  }
}

downloadModel();
