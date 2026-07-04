/**
 * server/mcp/tools/dev.js
 * dev-exec MCP tools (profile "dev", visible ONLY while dev mode is active).
 *
 * These handlers are deliberately thin: the gate → intake → audit → dispatch →
 * redact orchestration lives worker-side (index.js `devExec` / `devStatus`), so
 * it runs identically in standalone and under the proxy (the proxy forwards to
 * /api/dev/*). This mirrors ocrCapture. See docs/vision/whiskor-for-dev/dev-exec.md.
 */
'use strict';

module.exports = function registerDevTools(registry) {
  const tools = [];

  // exec_module — run a self-contained ES module on the real page runtime.
  tools.push({
    definition: {
      name: 'exec_module',
      description: 'Run a self-contained ES module (dependencies already bundled) on the REAL page runtime — real DOM, real framework state, real network. This is not a unit-test sandbox (jsdom/vitest simulate); it observes what actually happens in the running app. Only available while an operator has enabled dev mode. Supply the artifact ONE of three ways: inline `code`, a built file `path` (confined to dev.exec.fileRoots), or an `artifactId` from a prior push to /api/dev/artifact. Bare/relative imports are rejected — bundle first (esbuild --bundle). probe mode returns the module\'s default export; harness mode runs its exported __whiskor_tests__.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId:      { type: 'number', description: 'Target tab ID.' },
          code:       { type: 'string', description: 'Inline artifact: a self-contained ES module as text. Must not contain bare ("react") or relative ("./x.js") imports.' },
          path:       { type: 'string', description: 'Path to a built artifact file. Must resolve inside dev.exec.fileRoots (else blocked).' },
          artifactId: { type: 'string', description: 'Id of an artifact previously pushed to /api/dev/artifact.' },
          mode:       { type: 'string', enum: ['probe', 'harness'], description: "'probe' (default): evaluate the module, return its default export. 'harness': run exported __whiskor_tests__ and report pass/fail." },
          timeoutMs:  { type: 'number', description: 'Max ms for module evaluation + settled export (default 10000).' },
        },
        required: ['tabId'],
      },
    },
    handler: async (args, cb) => {
      if (typeof cb._devExec !== 'function') {
        return { ok: false, error: 'dev-exec is not wired on this server.' };
      }
      return cb._devExec({
        tabId:      args.tabId,
        code:       args.code,
        path:       args.path,
        artifactId: args.artifactId,
        mode:       args.mode,
        timeoutMs:  args.timeoutMs,
      }, 'agent');
    },
  });

  // dev_status — report the current dev mode state (active, TTL remaining).
  tools.push({
    definition: {
      name: 'dev_status',
      description: 'Report the current dev mode state: whether it is active and how long remains before it auto-expires. Read-only.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    handler: async (_args, cb) => {
      if (typeof cb._devStatus !== 'function') return { ok: false, error: 'dev-exec is not wired on this server.' };
      return cb._devStatus();
    },
  });

  registry.registerTools(tools);
};
