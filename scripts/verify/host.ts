import type * as Sse from '../../src/sse/emitter.js';
import type * as Live from '../../src/api/v2/live-stream.js';
import type * as Watcher from '../../src/watcher/service.js';
import type * as App from '../../src/app.js';
import type * as Connection from '../../src/db/connection.js';
import type * as Schema from '../../src/db/schema.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { repoRoot, sessionPrefix, writeJson, type Session } from './session.js';

const directory = fs.realpathSync(process.argv[2]);
assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
assert.ok(path.basename(directory).startsWith(sessionPrefix));
const startup = JSON.parse(fs.readFileSync(path.join(directory, 'startup.json'), 'utf8')) as Pick<Session, 'id' | 'provenance'>;
const token = fs.readFileSync(path.join(directory, 'control-token'), 'utf8');
const dbPath = path.join(directory, 'fixture.db');
const claudeDir = path.join(directory, 'claude');
const codexHome = path.join(directory, 'codex');
const antigravityDir = path.join(directory, 'antigravity');
const projects = path.join(claudeDir, 'projects', '-verification');
for (const dir of [projects, path.join(codexHome, 'sessions'), antigravityDir, path.join(directory, 'executions'), path.join(directory, 'catalog')]) {
  fs.mkdirSync(dir, { recursive: true });
}
Object.assign(process.env, {
  AGENTMONITOR_DB_PATH: dbPath,
  AGENTMONITOR_HOST: '127.0.0.1',
  AGENTMONITOR_CLAUDE_DIR: claudeDir,
  AGENTMONITOR_PROJECTS_DIR: path.join(directory, 'projects'),
  AGENTMONITOR_EXECUTIONS_DIR: path.join(directory, 'executions'),
  AGENTMONITOR_SKILL_CATALOG_DIRS: path.join(directory, 'catalog'),
  AGENTMONITOR_AUTO_IMPORT_MINUTES: '0',
  AGENTMONITOR_ENABLE_LIVE_TAB: 'true',
  AGENTMONITOR_TIMEZONE: 'UTC',
  AGENTMONITOR_USAGE_BUDGETS_PATH: path.join(directory, 'budgets.json'),
  AGENTMONITOR_TRACE_QUALITY_FINDINGS_PATH: path.join(directory, 'findings.json'),
});

const built = (module: string) => pathToFileURL(path.join(repoRoot, 'dist', module)).href;
const { initSchema } = await import(built('db/schema.js')) as typeof Schema;
const { getDb, closeDb } = await import(built('db/connection.js')) as typeof Connection;
const { createApp } = await import(built('app.js')) as typeof App;
const { startWatcher, stopWatcher } = await import(built('watcher/service.js')) as typeof Watcher;
const { liveBroadcaster } = await import(built('api/v2/live-stream.js')) as typeof Live;
const { broadcaster } = await import(built('sse/emitter.js')) as typeof Sse;

let application: Server | undefined;
let controller: Server | undefined;
let session: Session | undefined;
let expiry: NodeJS.Timeout | undefined;
let closing: Promise<void> | undefined;
function closeApplication() {
  if (closing) return closing;
  closing = (async () => {
    const watchdog = setTimeout(() => {
      if (session) writeJson(path.join(directory, 'session.json'), { ...session, status: 'failed', error: 'Cleanup timed out' });
      process.exit(1);
    }, 5_000);
    try {
      if (expiry) clearTimeout(expiry);
      await stopWatcher();
      liveBroadcaster.closeAllClients();
      broadcaster.closeAllClients();
      if (application?.listening) {
        const closed = new Promise<void>((resolve, reject) => application!.close(error => error ? reject(error) : resolve()));
        application.closeAllConnections();
        await closed;
      }
      closeDb();
      if (session) {
        session.status = 'stopped';
        writeJson(path.join(directory, 'session.json'), session);
      }
    } catch (error) {
      if (session) writeJson(path.join(directory, 'session.json'), { ...session, status: 'failed', error: String(error) });
      // Do not leave a partially closed detached host alive after an error.
      console.error(error);
      process.exit(1);
    } finally { clearTimeout(watchdog); }
  })();
  return closing;
}

async function shutdown() {
  try { await closeApplication(); }
  catch (error) {
    if (session) writeJson(path.join(directory, 'session.json'), { ...session, status: 'failed', error: String(error) });
    process.exitCode = 1;
  } finally { controller?.close(); controller?.closeAllConnections(); }
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });

try {
  initSchema();
  const db = getDb();
  assert.equal(fs.realpathSync(db.name), fs.realpathSync(dbPath), 'Fixture must never use the install DB');
  // Synthetic usage events intentionally bypass ingestion: this scenario checks
  // aggregation and rendering. Its expected values live in contracts.ts.
  const insert = db.prepare(`INSERT INTO events
    (session_id, agent_type, event_type, status, tokens_in, tokens_out, cost_usd, project, model, created_at, source)
    VALUES (?, 'codex', 'llm_response', 'success', 100, 20, 0.01, ?, 'gpt-5.5', '2026-07-10T12:00:00Z', 'otel')`);
  const insertSession = db.prepare(`INSERT INTO browsing_sessions (id, project, agent, started_at, ended_at)
    VALUES (?, ?, 'codex', '2026-07-10T12:00:00Z', '2026-07-10T12:01:00Z')`);
  db.transaction(() => {
    for (let index = 0; index < 10; index++) insertSession.run(`verify-usage-${index}`, index < 6 ? 'alpha' : 'beta');
    for (let index = 0; index < 1000; index++) insert.run(`verify-usage-${Math.floor(index / 100)}`, index < 600 ? 'alpha' : 'beta');
  })();

  const liveId = `verify-live-${startup.id}`;
  const transcript = path.join(projects, `${liveId}.jsonl`);
  const message = (role: string, text: string) => JSON.stringify({
    type: role, uuid: randomUUID(), sessionId: liveId, cwd: '/verification', timestamp: new Date().toISOString(),
    message: { id: randomUUID(), role, content: [{ type: 'text', text }] },
  }) + '\n';
  fs.writeFileSync(transcript, message('user', 'Verify the live session') + message('assistant', 'Initial verification response'));
  startWatcher({ claudeDir, codexHome, antigravityDir });
  application = createApp().listen(0, '127.0.0.1');
  await once(application, 'listening');
  controller = createServer((request, response) => {
    void (async () => {
      response.setHeader('content-type', 'application/json');
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(403).end(JSON.stringify({ error: 'Unauthorized verification control' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/status') {
        response.end(JSON.stringify({ session, liveId, transcript }));
      } else if (request.method === 'POST' && request.url === '/advance' && !closing) {
        const marker = `Verification follow-up ${randomUUID()}`;
        fs.appendFileSync(transcript, message('assistant', marker));
        response.end(JSON.stringify({ marker, liveId }));
      } else if (request.method === 'POST' && request.url === '/stop') {
        await closeApplication();
        response.end(JSON.stringify({ status: 'stopped' }));
        controller!.close();
        controller!.closeIdleConnections();
      } else {
        response.writeHead(404).end(JSON.stringify({ error: 'Unknown verification action' }));
      }
    })().catch(error => {
      console.error(error);
      response.writeHead(500).end(JSON.stringify({ error: String(error) }));
    });
  }).listen(0, '127.0.0.1');
  await once(controller, 'listening');
  const appAddress = application.address();
  const controlAddress = controller.address();
  assert.ok(appAddress && typeof appAddress !== 'string' && controlAddress && typeof controlAddress !== 'string');
  session = {
    schema_version: 1, ...startup, directory, status: 'running',
    url: `http://127.0.0.1:${appAddress.port}`, control_url: `http://127.0.0.1:${controlAddress.port}`,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
  writeJson(path.join(directory, 'session.json'), session);
  expiry = setTimeout(() => { void shutdown(); }, 60 * 60_000);
  process.send?.('ready');
} catch (error) {
  console.error(error);
  await shutdown();
  process.exitCode = 1;
}
