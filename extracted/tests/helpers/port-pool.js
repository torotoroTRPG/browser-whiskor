/**
 * port-pool.js
 * Deterministic port allocation so parallel test files never collide.
 *
 * Each test FILE is assigned a 100-port block by importing with its ID.
 * Within a file, individual tests claim pairs sequentially.
 *
 * Port layout (WS port shown; HTTP = WS + 1):
 *   ID 0  → 18000–18099   (server-ws)
 *   ID 1  → 18100–18199   (server-http)
 *   ID 2  → 18200–18299   (server-routing)
 *   ID 3  → 18300–18399   (delta-flow)
 *   ID 4  → 18400–18499   (full-flow)
 *   ID 5  → 18500–18599   (error-recovery)
 *   ID 6  → 18600–18699   (stress/large-data)
 *   ID 7  → 18700–18799   (stress/long-session)
 *   ID 8  → 18800–18899   (dashboard-canvas)
 */

const BASE   = 18_000;
const BLOCK  = 100;        // ports per file
const STRIDE = 2;          // WS port + HTTP port per test

/**
 * Create a port allocator for a specific test file.
 *
 * @param {number} fileId  0-based index (see layout above)
 * @returns {{ next(): { wsPort: number, httpPort: number } }}
 */
export function createPortPool(fileId) {
  const start = BASE + fileId * BLOCK;
  let offset = 0;

  return {
    next() {
      if (offset + STRIDE > BLOCK) throw new Error(`Port pool exhausted for fileId=${fileId}`);
      const wsPort   = start + offset;
      const httpPort = start + offset + 1;
      offset += STRIDE;
      return { wsPort, httpPort };
    },
  };
}
