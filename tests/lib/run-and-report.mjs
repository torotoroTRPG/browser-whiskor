import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

/**
 * Run node --test on given directories, return structured results.
 * @param {Array<{name:string, dirs:string[]}>} phases
 */
export function runPhases(phases) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const results = [];

  for (const phase of phases) {
    const { name, dirs } = phase;
    const dirArgs = dirs.map(d => join(ROOT, d));
    const t1 = Date.now();

    const proc = spawnSync(process.execPath, ['--test', ...dirArgs], {
      cwd: ROOT,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const allOutput = (proc.stdout || '') + '\n' + (proc.stderr || '');

    const totalMatch = allOutput.match(/# tests (\d+)/);
    const passMatch  = allOutput.match(/# pass (\d+)/);
    const failMatch  = allOutput.match(/# fail (\d+)/);

    const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
    const pass  = passMatch  ? parseInt(passMatch[1], 10)  : 0;
    const fail  = failMatch  ? parseInt(failMatch[1], 10)  : 0;

    // Per-suite breakdown
    const suites = [];
    const lines = allOutput.split('\n');
    let current = null;

    for (const line of lines) {
      const indent = line.search(/\S/);
      const trimmed = line.trim();

      if (indent === 0 && trimmed.startsWith('# Subtest:')) {
        if (current) suites.push(current);
        current = { name: trimmed.replace(/^# Subtest:\s+/, ''), total: 0, pass: 0, fail: 0 };
        continue;
      }

      if (!current) continue;

      const rm = trimmed.match(/^(ok|not ok)\s+\d+\s+-\s+(.+)/);
      if (rm && indent >= 4) {
        current.total++;
        if (rm[1] === 'ok') current.pass++; else current.fail++;
      }
    }
    if (current) suites.push(current);

    results.push({
      name,
      label: phase.label || name,
      dirs,
      suites,
      total,
      pass,
      fail,
      durationMs: Date.now() - t1,
      tapOutput: allOutput,
    });
  }

  const durationMs = Date.now() - t0;
  return {
    phases: results,
    summary: {
      total: results.reduce((s, p) => s + p.total, 0),
      pass:  results.reduce((s, p) => s + p.pass, 0),
      fail:  results.reduce((s, p) => s + p.fail, 0),
    },
    startedAt,
    durationMs,
  };
}

// CLI: accepts mode as argument
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('run-and-report.mjs');
if (isMain) {
  const mode = process.argv[2] || 'full';
  const phases = [
    { name: 'unit', label: 'unit tests (mocked)', dirs: ['tests/unit'] },
  ];
  if (mode === 'full') {
    phases.push({ name: 'integration+stress', label: 'integration & stress tests (real WS)', dirs: ['tests/integration', 'tests/stress'] });
  }
  const result = runPhases(phases);
  process.stdout.write(JSON.stringify(result));
}
