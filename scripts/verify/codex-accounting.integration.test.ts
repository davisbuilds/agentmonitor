import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nativeRequests, writeCodexAccountingReplay } from '../../tests/helpers/codex-accounting-replay.js';
import { repoRoot, startSession, stopSession } from './session.js';

for (const layout of ['full', 'split'] as const) {
  test(`compiled Codex import preserves native billing in the ${layout} layout`, async t => {
    const session = await startSession();
    t.after(async () => {
      await stopSession(session);
      fs.rmSync(session.directory, { recursive: true, force: true });
    });

    const codexDir = path.join(session.directory, 'replay');
    writeCodexAccountingReplay(codexDir, layout);
    const expectedDays = nativeRequests.map(({ timestamp, input, cached, output }) => ({
      date: timestamp.slice(0, 10),
      input_tokens: input - cached,
      cache_read_tokens: cached,
      output_tokens: output,
      usage_events: 1,
    }));

    for (const pass of ['initial', 'repeat', 'forced replay']) {
      const args = ['dist/cli.js', '--db-path', path.join(session.directory, 'fixture.db'),
        'import', '--source', 'codex', '--json'];
      if (pass === 'forced replay') args.push('--force');
      const report = JSON.parse(execFileSync(process.execPath, args, {
        cwd: repoRoot, encoding: 'utf8', timeout: 15_000,
        env: { PATH: process.env.PATH, HOME: session.directory, CODEX_HOME: codexDir },
      }));
      assert.equal(report.total_files, layout === 'full' ? 1 : 3, pass);
      for (const file of report.files) assert.equal(file.error, undefined, file.error);
      if (pass === 'forced replay') assert.ok(report.events_found > 0, 'forced import must reprocess the recording');

      const endpoint = new URL('/api/v2/usage/summary?agent=codex&project=accounting-replay', session.url);
      const summary = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
      assert.equal(summary.status, 200);
      assert.partialDeepStrictEqual(await summary.json(), {
        total_input_tokens: 104_400,
        total_cache_read_tokens: 103_600,
        total_output_tokens: 2_080,
        total_usage_events: 4,
        total_sessions: 1,
      }, pass);

      endpoint.pathname = '/api/v2/usage/daily';
      const daily = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
      assert.equal(daily.status, 200);
      const { data } = await daily.json();
      assert.equal(data.length, expectedDays.length, pass);
      for (const [index, expected] of expectedDays.entries()) {
        assert.partialDeepStrictEqual(data[index], expected, pass);
      }
    }
  });
}
