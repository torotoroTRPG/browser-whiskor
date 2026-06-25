/**
 * server/mcp/tools/source.js
 * get_source_context — serve a relevant slice of the user's uploaded source.
 * See docs/ideas/SOURCE_UPLOAD_CORRELATION.md (slice 1).
 */
'use strict';

module.exports = function registerSourceTools(registry) {
  registry.registerTools([{
    definition: {
      name: 'get_source_context',
      description: "Read a focused slice of the user's UPLOADED source code (front-end and/or back-end). Pass `symbol` (a component/function/class name) to jump to its declaration, or `file` with an optional `line`+`around` or `from`/`to` range; with neither, lists the project's files. Returns only the relevant excerpt — never whole files — so context stays lean. Requires the user to have uploaded source via POST /api/source/upload.",
      inputSchema: {
        type: 'object',
        properties: {
          projectId:  { type: 'string', description: 'Which uploaded project (default: the only one).' },
          component:  { type: 'string', description: 'A framework component name (e.g. from get_framework_state) — resolves to its source file.' },
          sourceFile: { type: 'string', description: 'Optional exact source path hint for the component (React _debugSource fileName).' },
          sourceLine: { type: 'number', description: 'Optional source line hint for the component (React _debugSource lineNumber).' },
          symbol:     { type: 'string', description: 'Jump to the declaration of this component/function/class name.' },
          file:       { type: 'string', description: 'Relative path of a file to slice (omit symbol).' },
          line:      { type: 'number', description: 'Center the excerpt on this line.' },
          around:    { type: 'number', description: 'Lines of context around `line` (default 30).' },
          from:      { type: 'number', description: '1-based start line (with `to`).' },
          to:        { type: 'number', description: '1-based end line.' },
          maxLines:  { type: 'number', description: 'Cap excerpt length (default 400).' },
        },
      },
    },
    handler: async (args, cb) => {
      if (!cb._sourceContext) {
        return { error: 'Source context not available — no source uploaded. POST files to /api/source/upload first.' };
      }
      try {
        return await cb._sourceContext(args || {});
      } catch (e) {
        return { error: e.message };
      }
    },
  }, {
    definition: {
      name: 'capture_sources',
      description: "Capture the page's resources (JS/CSS/HTML) of a tab via the DevTools getResources() API, which reads from the browser cache and so bypasses the CORS limits that block the page-context source fetcher — letting cross-origin CDN bundles (e.g. a SPA's main.*.js) actually be stored. REQUIRES the browser-whiskor DevTools panel to be OPEN on the target tab (getResources is only available there); if it isn't, returns { ok:false, error:'no_devtools' }. Stored files land in the tab's source cache (download via the dashboard /export?tabId=). Returns { ok, stored, count }.",
      inputSchema: {
        type: 'object',
        properties: {
          tabId:         { type: 'number', description: 'Tab to capture (from get_sessions).' },
          includeBinary: { type: 'boolean', description: 'Also capture binary assets (images/fonts/media) as raw bytes, not just JS/CSS/HTML. Default false — code only.' },
          timeoutMs:     { type: 'number', description: 'How long to wait for the panel to respond (default 15000).' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      if (!cb._sourceCapture) return { error: 'Source capture not available in this mode.' };
      try {
        return await cb._sourceCapture(args || {});
      } catch (e) {
        return { error: e.message };
      }
    },
  }]);
};
