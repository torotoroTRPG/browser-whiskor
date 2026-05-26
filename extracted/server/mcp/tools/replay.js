/**
 * server/mcp/tools/replay.js
 *
 * MCP tool: replay_session
 *
 * Re-executes the recorded action sequence from a previous session,
 * verifying pre/post state hashes and reporting divergences.
 */
'use strict';

const path = require('path');
const { replay } = require('../../session-replay');

module.exports = function registerReplayTools(registry) {
  registry.push({
    definition: {
      name: 'replay_session',
      description: 'Re-executes the recorded sequence of agent actions from a previous session. For each action verifies the pre-action state hash, executes the action, waits 300 ms, then verifies the post-action state hash. Hash mismatches are reported as divergences. Useful for regression testing and debugging non-deterministic page behaviour.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Target tab to replay actions into.',
          },
          sourceSessionDir: {
            type: 'string',
            description: 'Absolute path to the source session directory whose raw/replay/actions.jsonl will be replayed. Use list_sessions to find available session paths.',
          },
          fromSeq: {
            type: 'number',
            description: 'Replay from this sequence number (inclusive). Default: 1 (start of recording).',
          },
          toSeq: {
            type: 'number',
            description: 'Stop after this sequence number (inclusive). Default: replay all recorded steps.',
          },
          stopOnDivergence: {
            type: 'boolean',
            description: 'Abort replay immediately when a state hash mismatch is detected. Default: false (continue and collect all divergences).',
          },
        },
        required: ['tabId', 'sourceSessionDir'],
      },
    },
    handler: async (args, cb) => {
      const { tabId, sourceSessionDir, fromSeq, toSeq, stopOnDivergence } = args;

      if (!cb._callAction) {
        return { ok: false, error: 'Action executor not available.' };
      }
      if (!cb._requestHash) {
        return { ok: false, error: 'State hash requester not available.' };
      }

      // Validate that the source session directory exists and has actions
      const actionsPath = path.join(sourceSessionDir, 'raw', 'replay', 'actions.jsonl');
      try {
        require('fs').accessSync(actionsPath);
      } catch {
        return {
          ok: false,
          error: `No replay recording found at ${actionsPath}. The source session may not have any recorded actions.`,
        };
      }

      return replay({
        tabId,
        sourceSessionDir,
        fromSeq:          fromSeq          ?? 1,
        toSeq:            toSeq            ?? Infinity,
        stopOnDivergence: stopOnDivergence ?? false,
        executeAction:    (tid, action, ms) => cb._callAction(tid, action, ms),
        getHash:          (tid) => cb._requestHash(tid),
      });
    },
  });
};
