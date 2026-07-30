import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = process.cwd();
const builtServer = path.join(repoRoot, 'dist', 'server.js');
const builtFrontend = path.join(repoRoot, 'frontend', 'dist', 'index.html');
assert.equal(fs.existsSync(builtServer), true, 'dist/server.js is missing; run pnpm build');
assert.equal(
  fs.existsSync(builtFrontend),
  true,
  'frontend/dist/index.html is missing; run pnpm build',
);

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timeoutId;
  const timeout = new Promise(resolve => {
    timeoutId = setTimeout(resolve, 5_000, 'timeout');
  });
  const result = await Promise.race([
    exited.then(() => 'exited'),
    timeout,
  ]);
  clearTimeout(timeoutId);
  if (result === 'timeout') {
    const killed = once(child, 'exit');
    child.kill('SIGKILL');
    await killed;
  }
}

async function waitForChildExit(child, label, timeoutMs) {
  const result = await new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = error => {
      cleanup();
      reject(new Error(`${label} could not start: ${error.message}`, { cause: error }));
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal, timedOut: false });
    };
    timer = setTimeout(() => {
      cleanup();
      resolve({ code: null, signal: null, timedOut: true });
    }, timeoutMs);
    child.once('error', onError);
    child.once('exit', onExit);
  });

  if (result.timedOut) {
    await stopChild(child);
    throw new Error(`${label} timed out after ${timeoutMs}ms`);
  }
  return result;
}

async function runDojoRuntimeSmoke(baseUrl) {
  if (process.env['AGENTMONITOR_VERIFY_DOJO_RUNTIME'] !== '1') {
    return { status: 'not_requested' };
  }

  const runtimePath = path.resolve(
    repoRoot,
    '..',
    'dojo',
    'scripts',
    'skill_health_runtime.py',
  );
  if (!fs.existsSync(runtimePath)) {
    console.log(`Dojo runtime smoke skipped: ${runtimePath} is absent`);
    return { status: 'skipped_absent' };
  }

  const healthUrl = `${baseUrl}/api/v2/analytics/skills/health`
    + '?date_from=2026-07-01&date_to=2026-07-29';
  const python = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("skill_health_runtime", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'rows = module.load_health_rows(url=sys.argv[2], path=None)',
    'if not any(row.get("name") == "test-strategy" for row in rows):',
    '    raise RuntimeError("Dojo runtime response is missing test-strategy")',
    'print(json.dumps({"rows": len(rows), "test_strategy": True}))',
  ].join('\n');
  const child = spawn('python3', ['-c', python, runtimePath, healthUrl], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const result = await waitForChildExit(child, 'Dojo runtime smoke', 15_000);
  assert.equal(
    result.code,
    0,
    `Dojo runtime smoke failed (signal: ${result.signal ?? 'none'})\n${stderr}${stdout}`,
  );
  let payload;
  try {
    payload = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(
      `Dojo runtime smoke returned invalid JSON on stdout\nstdout: ${stdout}\nstderr: ${stderr}`,
      { cause: error },
    );
  }
  if (stderr && process.env['AGENTMONITOR_VERIFY_DEBUG'] === '1') {
    console.error(stderr);
  }
  return { status: 'passed', ...payload };
}

const tempPrefix = path.join(os.tmpdir(), 'agentmonitor-skill-context-built-');
const tempDir = fs.mkdtempSync(tempPrefix);
const resolvedTempDir = path.resolve(tempDir);
let childForCleanup;
let closeDbForCleanup;
let portProbeForCleanup;

try {
  assert.equal(
    resolvedTempDir.startsWith(path.resolve(os.tmpdir()) + path.sep),
    true,
    'temporary directory must remain under the system temp directory',
  );
  assert.equal(
    path.basename(resolvedTempDir).startsWith('agentmonitor-skill-context-built-'),
    true,
    'temporary directory prefix mismatch',
  );

  const verifierRunId = randomUUID().replaceAll('-', '');
  const claudeSessionId = `claude-skill-oracle-${verifierRunId}`;
  const codexSessionId = `codex-skill-oracle-${verifierRunId}`;
  const dbPath = path.join(resolvedTempDir, 'agentmonitor.db');
  const claudeDir = path.join(resolvedTempDir, 'claude');
  const projectsDir = path.join(claudeDir, 'projects');
  const catalogDir = path.join(resolvedTempDir, 'catalog');
  const codexHome = path.join(resolvedTempDir, 'codex');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(catalogDir, { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });

  const portProbe = net.createServer();
  portProbeForCleanup = portProbe;
  await new Promise((resolve, reject) => {
    portProbe.listen(0, '127.0.0.1', resolve);
    portProbe.once('error', reject);
  });
  const portAddress = portProbe.address();
  assert.ok(portAddress && typeof portAddress !== 'string');
  const port = portAddress.port;
  await new Promise(resolve => portProbe.close(resolve));
  portProbeForCleanup = undefined;

  Object.assign(process.env, {
    AGENTMONITOR_DB_PATH: dbPath,
    AGENTMONITOR_HOST: '127.0.0.1',
    AGENTMONITOR_PORT: String(port),
    AGENTMONITOR_PROJECTS_DIR: projectsDir,
    AGENTMONITOR_CLAUDE_DIR: claudeDir,
    AGENTMONITOR_SKILL_CATALOG_DIRS: catalogDir,
    AGENTMONITOR_AUTO_IMPORT_MINUTES: '0',
    CODEX_HOME: codexHome,
  });

  const { initSchema } = await import('../dist/db/schema.js');
  const { getDb, closeDb } = await import('../dist/db/connection.js');
  closeDbForCleanup = closeDb;
  const {
    insertParsedSession,
    parseSessionMessages,
  } = await import('../dist/parser/claude-code.js');
  const { parseCodexSessionMessages } = await import('../dist/parser/codex-sessions.js');
  const { syncCodexLiveSession } = await import('../dist/live/codex-adapter.js');

  initSchema();
  const db = getDb();
  db.prepare(`
    INSERT INTO skill_catalog_snapshots (
      name, version, first_seen_at, last_seen_at
    ) VALUES ('test-strategy', '1.0.0', '2026-06-01T00:00:00Z', '2026-08-01T00:00:00Z')
  `).run();

  const claudeSkillLine = (timestamp, id, skill = 'test-strategy') => JSON.stringify({
    type: 'assistant',
    cwd: '/work/alpha',
    timestamp,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id,
        name: 'Skill',
        input: { skill },
      }],
    },
  });
  const additionalClaudeSkills = Array.from(
    { length: 35 },
    (_, index) => claudeSkillLine(
      '2026-07-10T09:59:00Z',
      `claude-fixture-${index + 1}`,
      `fixture-skill-${String(index + 1).padStart(2, '0')}`,
    ),
  );
  const claudeSource = [
    ...additionalClaudeSkills,
    claudeSkillLine('2026-07-10T10:00:00Z', 'claude-first'),
    claudeSkillLine('2026-07-10T10:01:00Z', 'claude-repeat'),
    JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      cwd: '/work/alpha',
      timestamp: '2026-07-10T10:02:00Z',
    }),
    claudeSkillLine('2026-07-10T10:03:00Z', 'claude-rehydration'),
  ].join('\n');
  const claudePath = path.join(
    projectsDir,
    '-work-alpha',
    `${claudeSessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.writeFileSync(claudePath, claudeSource);
  insertParsedSession(
    db,
    parseSessionMessages(
      claudeSource,
      claudeSessionId,
      claudePath,
    ),
    claudePath,
    Buffer.byteLength(claudeSource),
    'built-claude-oracle',
  );

  const catalog = `<skills_instructions>
## Skills
- test-strategy: Guide agents to test behavior. (file: /skills/test-strategy/SKILL.md)
</skills_instructions>`;
  const codexSkillLine = timestamp => JSON.stringify({
    type: 'response_item',
    timestamp,
    payload: {
      name: 'exec_command',
      arguments: JSON.stringify({
        cmd: 'cat /skills/test-strategy/SKILL.md',
      }),
    },
  });
  const codexSource = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-10T11:00:00Z',
      payload: {
        cwd: '/work/codex',
        originator: 'codex_cli_rs',
        cli_version: '0.145.0',
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-10T11:00:01Z',
      payload: {
        role: 'developer',
        content: [{ type: 'input_text', text: catalog }],
      },
    }),
    JSON.stringify({
      type: 'turn_context',
      timestamp: '2026-07-10T11:00:01Z',
      payload: { cwd: '/work/codex', model: 'gpt-5.6-terra' },
    }),
    codexSkillLine('2026-07-10T11:00:02Z'),
    JSON.stringify({
      type: 'compacted',
      timestamp: '2026-07-10T11:00:03Z',
      payload: { replacement_history: [] },
    }),
    codexSkillLine('2026-07-10T11:00:04Z'),
  ].join('\n');
  const codexPath = path.join(
    resolvedTempDir,
    path.basename(codexHome),
    'sessions',
    '2026',
    '07',
    '10',
    `${codexSessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(codexPath, codexSource);
  const parsedCodex = parseCodexSessionMessages(
    codexSource,
    codexSessionId,
    codexPath,
  );
  insertParsedSession(
    db,
    parsedCodex,
    codexPath,
    Buffer.byteLength(codexSource),
    'built-codex-oracle',
  );
  syncCodexLiveSession(db, parsedCodex);
  assert.deepEqual(
    db.prepare(`
      SELECT agent, COUNT(*) AS observations
      FROM browsing_sessions
      JOIN session_context_observations
        ON session_context_observations.session_id = browsing_sessions.id
      GROUP BY agent
      ORDER BY agent
    `).all(),
    [
      { agent: 'claude', observations: 39 },
      { agent: 'codex', observations: 4 },
    ],
    'built parsers must seed the expected context observations before server startup',
  );
  closeDb();

  const child = spawn(process.execPath, [builtServer], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childForCleanup = child;
  let childOutput = '';
  child.stdout.on('data', chunk => {
    childOutput += chunk;
  });
  child.stderr.on('data', chunk => {
    childOutput += chunk;
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  async function waitForHealth() {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) {
        throw new Error(`built server exited early (${child.exitCode})\n${childOutput}`);
      }
      let response;
      try {
        response = await fetch(`${baseUrl}/api/health`);
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      if (response.ok) {
        const marker = await fetch(
          `${baseUrl}/api/v2/sessions/${encodeURIComponent(codexSessionId)}/skill-context`,
        );
        if (marker.status === 200) return;
        throw new Error(
          `loopback port ${port} answered health without the verifier session marker; `
          + 'another runtime likely claimed the selected port',
        );
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`built server did not become healthy\n${childOutput}`);
  }

  await waitForHealth();

  const healthResponse = await fetch(
    `${baseUrl}/api/v2/analytics/skills/health?date_from=2026-07-01&date_to=2026-07-29`,
  );
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  if (process.env['AGENTMONITOR_VERIFY_DEBUG'] === '1') {
    console.error(JSON.stringify(health.consultations, null, 2));
  }
  assert.deepEqual(
    health.consultations.byHarness.map(item => item.harness),
    ['claude', 'codex'],
  );
  const claude = health.consultations.byHarness
    .find(item => item.harness === 'claude')
    ?.skills.find(skill => skill.name === 'test-strategy');
  const codex = health.consultations.byHarness
    .find(item => item.harness === 'codex')
    ?.skills.find(skill => skill.name === 'test-strategy');
  assert.ok(claude);
  assert.ok(codex);
  assert.deepEqual(claude.classes, {
    first_read: 1,
    rehydration_after_compaction: 1,
    repeat_no_compaction: 1,
    unclassifiable: 0,
  });
  assert.deepEqual(codex.classes, {
    first_read: 1,
    rehydration_after_compaction: 1,
    repeat_no_compaction: 0,
    unclassifiable: 0,
  });
  const dojoRuntimeSmoke = await runDojoRuntimeSmoke(baseUrl);

  const realization = {
    id: 'built-codex-realization',
    harness: 'codex',
    profileIdentity: 'profile:built-smoke',
    profileComposition: ['built-smoke'],
    canonicalRevision: 'dojo@built-smoke',
    validFrom: '2026-07-01T00:00:00Z',
    validTo: '2026-08-01T00:00:00Z',
    skills: [{
      name: 'test-strategy',
      descriptionFingerprint: '1'.repeat(64),
      version: '1.0.0',
      contentIdentity: '2'.repeat(64),
    }],
    provenance: {
      producer: 'dojo',
      producerVersion: '0.1.0',
      artifactId: 'artifact:built-smoke',
      artifactRevision: 'r1',
      sourceUri: 'file:///tmp/built-smoke.json',
    },
  };
  const createResponse = await fetch(
    `${baseUrl}/api/v2/skills/expected-realizations/${realization.id}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(realization),
    },
  );
  assert.equal(createResponse.status, 201);
  const replayResponse = await fetch(
    `${baseUrl}/api/v2/skills/expected-realizations/${realization.id}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(realization),
    },
  );
  assert.equal(replayResponse.status, 200);
  const associateResponse = await fetch(
    `${baseUrl}/api/v2/sessions/${encodeURIComponent(codexSessionId)}/expected-skill-realization`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ realizationId: realization.id }),
    },
  );
  assert.equal(associateResponse.status, 201);
  const contextResponse = await fetch(
    `${baseUrl}/api/v2/sessions/${encodeURIComponent(codexSessionId)}/skill-context`,
  );
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json();
  assert.equal(context.catalog.observable, true);
  assert.equal(context.expectedRealization.status, 'associated');

  const playwright = spawn(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      'e2e/skill-consultation-analytics.spec.ts',
      '--project=chromium',
      '--reporter=line',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENTMONITOR_E2E_URL: baseUrl,
      },
      stdio: 'inherit',
    },
  );
  const [playwrightCode] = await once(playwright, 'exit');
  assert.equal(playwrightCode, 0, 'skill consultation Playwright verification failed');

  console.log(
    JSON.stringify({
      builtRuntime: true,
      healthHarnesses: ['claude', 'codex'],
      claudeClasses: claude.classes,
      codexClasses: codex.classes,
      realizationCreate: createResponse.status,
      realizationReplay: replayResponse.status,
      association: associateResponse.status,
      context: contextResponse.status,
      dojoRuntimeSmoke,
    }),
  );
} finally {
  try {
    if (childForCleanup) await stopChild(childForCleanup);
  } finally {
    try {
      if (portProbeForCleanup?.listening) {
        await new Promise((resolve, reject) => {
          portProbeForCleanup.close(error => error ? reject(error) : resolve());
        });
      }
      closeDbForCleanup?.();
    } finally {
      assert.equal(
        resolvedTempDir.startsWith(path.resolve(os.tmpdir()) + path.sep),
        true,
        'refusing to remove a non-temp verification directory',
      );
      fs.rmSync(resolvedTempDir, { recursive: true, force: true });
    }
  }
}
