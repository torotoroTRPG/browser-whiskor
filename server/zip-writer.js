/**
 * server/zip-writer.js
 * Minimal, dependency-free ZIP archive builder (store + deflate).
 *
 * The project ships zero zip dependencies and must run cross-platform (the
 * release.yml `zip` CLI is Linux-only), so this builds a valid ZIP container
 * by hand using Node's built-in zlib for DEFLATE and a small CRC32 table.
 * Sufficient for /export (download a ZIP of the session cache).
 */
'use strict';

const zlib = require('zlib');

// Standard CRC32 (polynomial 0xEDB88320), table-based.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

/**
 * Build a ZIP archive from a list of entries.
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @returns {Buffer} the complete .zip file
 */
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw);
    // Only use DEFLATE when it actually saves space; otherwise STORE verbatim.
    const useDeflate = deflated.length < raw.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? deflated : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);         // version needed to extract
    local.writeUInt16LE(0x0800, 6);     // flags: bit 11 = UTF-8 filename
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);         // mod time
    local.writeUInt16LE(0x21, 12);      // mod date (1980-01-01, arbitrary)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22);  // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);         // extra field length
    localChunks.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4);  // version made by
    central.writeUInt16LE(20, 6);  // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // offset of local header
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4);  // disk number
  end.writeUInt16LE(0, 6);  // disk with central dir
  end.writeUInt16LE(entries.length, 8);  // entries on this disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12); // central dir size
  end.writeUInt32LE(offset, 16);            // central dir offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralBuf, end]);
}

module.exports = { buildZip, crc32 };
