/**
 * tests/unit/cache-writer-rename-retry.test.js
 * Section 2.x — atomic-write rename retry (Windows EPERM/EBUSY robustness)
 *
 * On Windows the rename in the tmp→rename atomic write transiently fails with
 * EPERM/EBUSY/EACCES/EEXIST when the target is briefly locked (antivirus, search
 * indexer, another handle). The writer retries a few times before giving up;
 * ENOENT (target dir removed under us) is not retried. Exercises the REAL
 * server/cache-writer.js retry helper with an injected rename impl.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cw = require('../../server/cache-writer');

function fail(code) { const e = new Error(code); e.code = code; return e; }

describe('2.x rename retry (async)', () => {
  it('retries a transient EPERM and then succeeds', async () => {
    let calls = 0;
    const renameImpl = async () => { calls++; if (calls < 3) throw fail('EPERM'); };
    await cw._renameWithRetryAsync('a.tmp', 'a.json', renameImpl);
    assert.strictEqual(calls, 3, 'should retry until the lock clears');
  });

  it('gives up after exhausting retries and rethrows', async () => {
    let calls = 0;
    const renameImpl = async () => { calls++; throw fail('EBUSY'); };
    await assert.rejects(
      cw._renameWithRetryAsync('a.tmp', 'a.json', renameImpl),
      (e) => e.code === 'EBUSY',
    );
    assert.strictEqual(calls, cw.RENAME_BACKOFFS_MS.length + 1, 'one initial try + one per backoff');
  });

  it('does not retry ENOENT (target dir gone) — rethrows immediately', async () => {
    let calls = 0;
    const renameImpl = async () => { calls++; throw fail('ENOENT'); };
    await assert.rejects(cw._renameWithRetryAsync('a.tmp', 'a.json', renameImpl), (e) => e.code === 'ENOENT');
    assert.strictEqual(calls, 1, 'ENOENT is expected (teardown/deletion); no retry');
  });
});

describe('2.x rename retry (sync)', () => {
  it('retries a transient EACCES then succeeds', () => {
    let calls = 0;
    const renameImpl = () => { calls++; if (calls < 2) throw fail('EACCES'); };
    cw._renameWithRetrySync('a.tmp', 'a.json', renameImpl);
    assert.strictEqual(calls, 2);
  });

  it('rethrows a non-transient error without retrying', () => {
    let calls = 0;
    const renameImpl = () => { calls++; throw fail('EINVAL'); };
    assert.throws(() => cw._renameWithRetrySync('a.tmp', 'a.json', renameImpl), (e) => e.code === 'EINVAL');
    assert.strictEqual(calls, 1);
  });
});
