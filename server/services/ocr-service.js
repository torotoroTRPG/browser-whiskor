/**
 * server/services/ocr-service.js
 *
 * Native OCR engine binding (bring-your-own binary).
 *
 * whiskor's text-coords analyzer is DOM-based and already emits Tesseract-shaped
 * coordinate fields, but it sees nothing on canvas-rendered apps (Unity/WebGL) or
 * icon-only controls with no text node. This service fills that gap by shelling
 * out to a real OCR binary and returning the SAME schema, so an OCR'd region is a
 * drop-in for text-coords output.
 *
 * Engine resolution (no heavy npm dependency is bundled — you bring the binary):
 *   1. config.intelligence.ocr.binPath   (explicit path)
 *   2. env WHISKOR_OCR_PATH               (path or command name)
 *   3. autodetect `tesseract` on PATH
 * If none resolves, recognize() returns { ok:false, error:'ocr_unavailable' } and
 * the tool/HTTP layers surface install guidance instead of failing hard.
 *
 * The binary is expected to be Tesseract (or a CLI-compatible drop-in): it is
 * invoked as `<bin> stdin stdout -l <lang> --psm <psm> tsv`, the image is piped to
 * stdin, and the TSV on stdout is parsed into word boxes.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');

let _config = {};
let _resolved = false;
let _engine = null; // { binPath, version } | null

const DEFAULT_LANG = 'eng';
const DEFAULT_PSM = 3;            // automatic page segmentation
const DEFAULT_TIMEOUT_MS = 20000;

const INSTALL_HINT =
  'No OCR engine found. Install Tesseract (https://github.com/tesseract-ocr/tesseract), '
  + 'then either put it on PATH, set WHISKOR_OCR_PATH, or set intelligence.ocr.binPath in config.json.';

/** Run `<bin> --version` and parse the version string. Returns engine info or null. */
function _probe(binPath) {
  try {
    const r = spawnSync(binPath, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (!/tesseract/i.test(out)) return null; // guard against an unrelated binary
    const m = /tesseract\s+v?([\w.]+)/i.exec(out);
    return { binPath, version: m ? m[1] : 'unknown' };
  } catch (_) {
    return null;
  }
}

/**
 * (Re)read OCR config and reset engine resolution. Call once at worker startup.
 * Returns the resolved engine (or null), so callers can log availability.
 */
function init(config) {
  _config = (config && config.intelligence && config.intelligence.ocr) || {};
  _resolved = false;
  _engine = null;
  if (_config.enabled === false) {
    _resolved = true; // explicitly disabled — never probe
    return null;
  }
  return resolve();
}

/** Resolve (and cache) the OCR engine following the precedence above. */
function resolve() {
  if (_resolved) return _engine;
  _resolved = true;
  if (_config.enabled === false) { _engine = null; return null; }

  const explicit = _config.binPath || process.env.WHISKOR_OCR_PATH || null;
  if (explicit) {
    _engine = _probe(explicit);
  } else {
    _engine = _probe('tesseract'); // autodetect on PATH
  }
  return _engine;
}

function isAvailable() {
  return !!resolve();
}

/** Availability/status, safe to expose on /health and in tool errors. */
function getStatus() {
  const e = resolve();
  if (_config.enabled === false) return { available: false, reason: 'disabled' };
  return e
    ? { available: true, binPath: e.binPath, version: e.version, lang: _config.lang || DEFAULT_LANG }
    : { available: false, reason: 'no_engine', hint: INSTALL_HINT };
}

/**
 * Parse Tesseract TSV (the `tsv` config output) into word boxes.
 * TSV columns: level page_num block_num par_num line_num word_num
 *              left top width height conf text
 * Word rows are level===5. We keep the Tesseract-compatible fields and also expose
 * x/y/w/h aliases (matching text-coords' bbox convention) for convenience.
 */
function _parseTsv(tsv) {
  const rows = String(tsv || '').split(/\r?\n/);
  if (rows.length < 2) return { text: '', words: [], wordCount: 0 };

  const header = rows[0].split('\t');
  const col = {};
  header.forEach((h, i) => { col[h.trim()] = i; });
  // Bail to positional indices if the header isn't the expected Tesseract one.
  const at = (cols, name, pos) => cols[col[name] != null ? col[name] : pos];

  const words = [];
  const lineBuckets = new Map(); // "block.par.line" -> [text...]
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split('\t');
    if (cols.length < 12) continue;
    if (Number(at(cols, 'level', 0)) !== 5) continue; // word level only
    const text = at(cols, 'text', 11);
    if (!text || !text.trim()) continue;

    const left = Number(at(cols, 'left', 6));
    const top = Number(at(cols, 'top', 7));
    const width = Number(at(cols, 'width', 8));
    const height = Number(at(cols, 'height', 9));
    const conf = Number(at(cols, 'conf', 10));
    const block_num = Number(at(cols, 'block_num', 2));
    const par_num = Number(at(cols, 'par_num', 3));
    const line_num = Number(at(cols, 'line_num', 4));

    words.push({
      level: 5,
      page_num: Number(at(cols, 'page_num', 1)),
      block_num, par_num, line_num,
      word_num: Number(at(cols, 'word_num', 5)),
      text,
      left, top, width, height,
      x: left, y: top, w: width, h: height,
      confidence: Number.isFinite(conf) ? conf : null,
    });

    const key = `${block_num}.${par_num}.${line_num}`;
    if (!lineBuckets.has(key)) lineBuckets.set(key, []);
    lineBuckets.get(key).push(text);
  }

  const text = [...lineBuckets.values()].map(w => w.join(' ')).join('\n');
  return { text, words, wordCount: words.length };
}

/**
 * Recognize text in an image buffer (PNG/JPEG bytes).
 * Resolves { ok, text, words, wordCount, engine, lang, psm } on success, or
 * { ok:false, error } on failure (including 'ocr_unavailable' when no engine).
 * Never rejects.
 */
function recognize(imageBuffer, opts = {}) {
  return new Promise((done) => {
    const eng = resolve();
    if (!eng) return done({ ok: false, error: 'ocr_unavailable', hint: INSTALL_HINT });
    if (!imageBuffer || !imageBuffer.length) return done({ ok: false, error: 'empty_image' });

    const lang = opts.lang || _config.lang || DEFAULT_LANG;
    const psm = String(opts.psm != null ? opts.psm : (_config.psm != null ? _config.psm : DEFAULT_PSM));
    const timeoutMs = opts.timeoutMs || _config.timeoutMs || DEFAULT_TIMEOUT_MS;
    const args = ['stdin', 'stdout', '-l', lang, '--psm', psm, 'tsv'];

    let child;
    try {
      child = spawn(eng.binPath, args, { windowsHide: true });
    } catch (e) {
      return done({ ok: false, error: 'ocr_spawn_failed', detail: e.message });
    }

    const chunks = [];
    let stderr = '';
    let settled = false;
    const finish = (res) => { if (settled) return; settled = true; clearTimeout(timer); done(res); };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      finish({ ok: false, error: 'ocr_timeout', detail: `exceeded ${timeoutMs}ms` });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => finish({ ok: false, error: 'ocr_spawn_failed', detail: e.message }));
    child.on('close', (code) => {
      const out = Buffer.concat(chunks).toString('utf8');
      if (code !== 0 && !out) {
        return finish({ ok: false, error: 'ocr_failed', detail: (stderr || '').trim().slice(0, 500) });
      }
      finish({ ok: true, engine: eng.version, lang, psm: Number(psm), ..._parseTsv(out) });
    });

    child.stdin.on('error', () => { /* ignore EPIPE if the engine exits early */ });
    child.stdin.write(imageBuffer);
    child.stdin.end();
  });
}

/** Test hook: reset cached resolution. */
function _reset() { _config = {}; _resolved = false; _engine = null; }

module.exports = {
  init,
  resolve,
  isAvailable,
  getStatus,
  recognize,
  _parseTsv,
  _reset,
  INSTALL_HINT,
};
