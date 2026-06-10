'use strict';

/**
 * server/http-origin-guard.js
 *
 * Decide whether to accept an incoming HTTP API request based on its
 * Origin header.
 *
 * Why this exists: Access-Control-Allow-Origin only stops a browser page
 * from READING a cross-origin response — it does not stop the browser from
 * SENDING the request. A "simple" request (e.g. POST with
 * Content-Type: text/plain and mode:'no-cors') skips preflight entirely and
 * is delivered to the server, which previously parsed and dispatched it
 * (including /api/action — click/navigate/type_text/execute_js). Any page
 * the instrumented browser visits could drive the user's own tabs.
 *
 * Origin is set by the browser and cannot be overridden by page JS, and is
 * omitted for same-origin GETs and for non-browser clients (curl, the MCP
 * proxy). So:
 *   - no Origin header      -> trusted (non-browser client / same-origin GET)
 *   - Origin in allowed set -> trusted, echoed back for CORS
 *   - allowedMcpOrigins=['*'] -> explicit opt-out, never reject (documented
 *     as "not recommended for production")
 *   - host is not loopback (e.g. 0.0.0.0 for LAN exposure) -> never reject;
 *     a single serverOrigin can't represent "any LAN address", and that
 *     setup already documents appIsolation tokens as its mitigation
 *   - anything else -> reject before the body is read
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * @param {string} origin - value of the request's Origin header, or '' if absent
 * @param {{host: string, httpPort: number, allowedMcpOrigins: string[]}} opts
 * @returns {{allow: boolean, acao: string}} acao is the
 *   Access-Control-Allow-Origin header value to send
 */
function checkOrigin(origin, { host, httpPort, allowedMcpOrigins }) {
  const serverOrigin = `http://${host}:${httpPort}`;
  const allowAny = allowedMcpOrigins.includes('*');

  if (!origin) return { allow: true, acao: serverOrigin };

  const allowed = allowAny
    ? [serverOrigin]
    : [...new Set([...allowedMcpOrigins.map(h => `http://${h}:${httpPort}`), serverOrigin])];

  if (allowed.includes(origin)) return { allow: true, acao: origin };

  const reject = !allowAny && LOOPBACK_HOSTS.has(host);
  return { allow: !reject, acao: 'none' };
}

module.exports = { checkOrigin };
