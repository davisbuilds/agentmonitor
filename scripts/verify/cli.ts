import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scenarios, scenarioById } from './contracts.js';
import { control, readSession, startSession, stopSession } from './session.js';
import { runScenario } from './run.js';
import { probes, runProbe } from './probe.js';

const help = `AgentMonitor development verification (run pnpm build first)
  pnpm --silent verify list [--json]
  pnpm --silent verify start [--json]
  pnpm --silent verify run <live-session|usage> [--session DIR] [--json]
       [--max-api-ms N] [--max-ui-ms N]  (usage only; UI filter timing)
  pnpm --silent verify inspect <session-or-evidence-DIR> [--json]
  pnpm --silent verify advance <session-DIR> [--json]
  pnpm --silent verify stop <session-DIR> [--json]
  pnpm --silent verify probe <health|ingestion|monitor-stats|snapshot> [--db PATH] [--json]
       [--agent A] [--since ISO] [--runs N] [--url URL] [--timeout-ms N]
  Ingestion scope: [--claude-dir DIR] [--codex-home DIR] [--exclude PATTERN ...]
  pnpm --silent verify probe resync <transcript.jsonl> [--db SNAPSHOT] [--append-lines N] [--retain-transcripts] [--json]
  pnpm --silent verify probe plans --db SNAPSHOT (--index NAME | --index-sql 'CREATE INDEX ...') [--json]
  pnpm --silent verify probe hotspots --db SNAPSHOT [--json]

start keeps a disposable compiled app running for up to one hour.
run owns and stops its app unless --session is given. Evidence and fixtures
remain in the OS temp directory until you or the OS remove them.
Exit: 0 success; 1 verification/cleanup failed; 2 invalid request or blocked.
Scenarios use no real transcripts, installed database, credentials, or paid
model calls. Probes read the installed database (the globally linked amon's
data/agentmonitor.db, or --db) through a read-only connection in a child process
killed at its deadline. Resync deletes its transcript copies by default;
--retain-transcripts keeps them for debugging and lists their location.
Snapshots contain the full database and remain until you remove them. Plans runs
the compiled app on a snapshot (its startup migrations and any --index-sql write
there) and compares each recorded read's plan with and without the index.
Hotspots runs the same routes on a snapshot and ranks every read they ran by time.
Ingestion scope comes from options, then the caller's environment, then defaults;
it is recorded but is not asserted to match the running service's configuration.
`;
const abort = new AbortController();
process.once('SIGINT', () => abort.abort(new Error('Interrupted (SIGINT)')));
process.once('SIGTERM', () => abort.abort(new Error('Interrupted (SIGTERM)')));
let json = process.argv.includes('--json');
try {
  const { values, positionals } = parseArgs({ options: {
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    session: { type: 'string' }, 'max-api-ms': { type: 'string' }, 'max-ui-ms': { type: 'string' },
    'retain-transcripts': { type: 'boolean' },
    'claude-dir': { type: 'string' }, 'codex-home': { type: 'string' }, exclude: { type: 'string', multiple: true },
    db: { type: 'string' }, url: { type: 'string' }, agent: { type: 'string' }, since: { type: 'string' },
    runs: { type: 'string' }, 'append-lines': { type: 'string' }, 'timeout-ms': { type: 'string' },
    index: { type: 'string' }, 'index-sql': { type: 'string' },
  }, allowPositionals: true, strict: true });
  json = values.json ?? false;
  if (values.help || positionals.length === 0) { process.stdout.write(help); }
  else {
    const [command, target] = positionals;
    if (!['list', 'start', 'run', 'inspect', 'advance', 'stop', 'probe'].includes(command)) throw new Error(`Unknown command: ${command}`);
    const needsTarget = !['list', 'start'].includes(command);
    const expected = command === 'probe' && target === 'resync' ? 3 : needsTarget ? 2 : 1;
    if (positionals.length !== expected) throw new Error(`Invalid arguments for ${command}; use --help`);
    if (command !== 'run' && (values.session || values['max-api-ms'] || values['max-ui-ms'])) throw new Error('Run options require run');
    const probeOptions = ['retain-transcripts', 'claude-dir', 'codex-home', 'exclude', 'db', 'url', 'agent', 'since', 'runs', 'append-lines', 'timeout-ms', 'index', 'index-sql'] as const;
    if (command !== 'probe' && probeOptions.some(name => values[name] !== undefined)) throw new Error('Probe options require probe');
    if (values['retain-transcripts'] && (command !== 'probe' || target !== 'resync')) throw new Error('--retain-transcripts requires probe resync');
    if ((values['claude-dir'] !== undefined || values['codex-home'] !== undefined || values.exclude !== undefined)
      && (command !== 'probe' || target !== 'ingestion')) throw new Error('Discovery options require probe ingestion');
    if ((values.index !== undefined || values['index-sql'] !== undefined) && (command !== 'probe' || target !== 'plans')) {
      throw new Error('--index and --index-sql require probe plans');
    }
    if (command === 'probe' && target === 'plans' && (values.index === undefined) === (values['index-sql'] === undefined)) {
      throw new Error('probe plans needs exactly one of --index or --index-sql');
    }
    const count = (value: string | undefined, name: string) => {
      if (value === undefined) return undefined;
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
      return Number(value);
    };
    const threshold = (value: string | undefined) => {
      if (value === undefined) return undefined;
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) throw new Error('Timing thresholds must be positive finite milliseconds');
      return number;
    };
    let output: unknown;
    switch (command) {
      case 'list': output = { schema_version: 1, prerequisites: ['pnpm install', 'pnpm build', 'pnpm exec playwright install chromium'], scenarios, probes }; break;
      case 'probe': {
        const result = await runProbe(target, {
          retainTranscripts: values['retain-transcripts'], claudeDir: values['claude-dir'], codexHome: values['codex-home'], excludePatterns: values.exclude,
          db: values.db, url: values.url, agent: values.agent, since: values.since,
          runs: count(values.runs, '--runs'), appendLines: count(values['append-lines'], '--append-lines'),
          timeoutMs: count(values['timeout-ms'], '--timeout-ms'), transcript: positionals[2], signal: abort.signal,
          index: values.index, indexSql: values['index-sql'],
        });
        output = result;
        process.exitCode = result.status === 'observed' ? 0 : 2;
        break;
      }
      case 'start': output = await startSession(abort.signal); break;
      case 'run': {
        const scenario = scenarioById(target);
        if (scenario.id !== 'usage' && (values['max-api-ms'] || values['max-ui-ms'])) throw new Error('Timing thresholds apply to usage only');
        const result = await runScenario(scenario.id, { session: values.session, maxApiMs: threshold(values['max-api-ms']), maxUiMs: threshold(values['max-ui-ms']), signal: abort.signal });
        output = result;
        process.exitCode = result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2;
        break;
      }
      case 'inspect': {
        const file = path.join(target, fs.existsSync(path.join(target, 'failure.json')) ? 'failure.json' : 'result.json');
        if (fs.existsSync(file)) output = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
        else {
          const session = readSession(target);
          output = session.status === 'running' ? await control(session, 'status') : session;
        }
        break;
      }
      case 'advance': output = await control(readSession(target), 'advance'); break;
      case 'stop': output = await stopSession(readSession(target)); break;
    }
    if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    else if (command === 'run') {
      const result = output as Awaited<ReturnType<typeof runScenario>>;
      process.stdout.write(`${result.status}: ${result.scenario}\nEvidence: ${result.directory}/result.json\nCleanup: ${result.cleanup}\n`);
      for (const error of result.errors) process.stderr.write(error + '\n');
    } else process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  }
} catch (error) {
  if (json) process.stdout.write(JSON.stringify({ schema_version: 1, status: 'blocked', error: String(error) }) + '\n');
  else process.stderr.write(`${String(error)}\nUse pnpm verify --help\n`);
  process.exitCode = 2;
}
