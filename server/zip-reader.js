/**
 * server/zip-reader.js
 *
 * Minimal, dependency-free ZIP reader (store + deflate) — the counterpart to
 * zip-writer.js. Parses the End-of-Central-Directory + central directory, then
 * reads each entry's local header and inflates its data. Used by the source-upload
 * endpoint so a user can upload a .zip of their source instead of a JSON file map.
 *
 * Returns { relPath: utf8-string } for file entries. Binary files come back as
 * (garbled) strings; callers that care (source-index) skip binaries by extension.
 */
'use strict';

const zlib = require('zlib');

const SIG_LOCAL   = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD    = 0x06054b50;

// Locate the End-of-Central-Directory record (scanning back from the end, since a
// trailing comment of up to 0xffff bytes may follow it).
function _findEOCD(buf) {
  const min = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Parse a ZIP buffer into { relPath: content }. opts: { maxEntries, maxBytes } cap
 * the work to keep a hostile/huge archive bounded.
 */
function readZip(buf, opts = {}) {
  const maxEntries = opts.maxEntries || 20000;
  const maxBytes   = opts.maxBytes   || 64 * 1024 * 1024;
  const out = {};
  if (!Buffer.isBuffer(buf) || buf.length < 22) return out;

  const eocd = _findEOCD(buf);
  if (eocd < 0) return out;

  let count = buf.readUInt16LE(eocd + 10);     // total central-dir entries
  const cdOffset = buf.readUInt32LE(eocd + 16); // central directory offset
  if (count > maxEntries) count = maxEntries;

  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const method     = buf.readUInt16LE(p + 10);
    const compSize   = buf.readUInt32LE(p + 20);
    const nameLen    = buf.readUInt16LE(p + 28);
    const extraLen   = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff   = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry

    // Local header tells us where the data actually starts (its name/extra lengths
    // can differ from the central record's).
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) continue;
    const lNameLen  = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) continue;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let content;
    try {
      if (method === 0) content = comp;                    // stored
      else if (method === 8) content = zlib.inflateRawSync(comp); // deflated
      else continue;                                       // unsupported method
    } catch (_) { continue; }

    total += content.length;
    if (total > maxBytes) break;
    out[name] = content.toString('utf8');
  }
  return out;
}

module.exports = { readZip };
