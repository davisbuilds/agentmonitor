import fs from 'node:fs';
import path from 'node:path';

type EnvMap = NodeJS.ProcessEnv;

function parseEnvInt(value: string | undefined, fallback: number, min: number = 0): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}

function parseEnvFloat(value: string | undefined, fallback: number, min: number = 0): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}

export type UsageLimitType = 'tokens' | 'cost';

interface AgentUsageConfig {
  limitType: UsageLimitType;
  sessionWindowHours: number;
  sessionLimit: number;
  extendedWindowHours: number;
  extendedLimit: number;
}

function isAgentMonitorRepo(dir: string): boolean {
  const packageJsonPath = path.join(dir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return false;

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { name?: string };
    return pkg.name === 'agentmonitor';
  } catch {
    return false;
  }
}

function detectProjectsDir(cwd: string): string {
  const start = path.resolve(cwd);
  let current = start;

  while (true) {
    if (isAgentMonitorRepo(current)) return path.dirname(current);
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function resolveProjectsDir(env: EnvMap, cwd: string): string {
  const override = env.AGENTMONITOR_PROJECTS_DIR?.trim();
  if (override) return path.resolve(cwd, override);
  return detectProjectsDir(cwd);
}

function parseUsageMonitorConfig(env: EnvMap): Record<string, AgentUsageConfig> {
  const defaultWindowHours = parseEnvInt(env.AGENTMONITOR_SESSION_WINDOW_HOURS, 5, 1);

  // Known agent types — each uses its own limit type
  const agents: Record<string, AgentUsageConfig> = {
    claude_code: {
      limitType: 'tokens',
      sessionWindowHours: parseEnvInt(env.AGENTMONITOR_SESSION_WINDOW_HOURS_CLAUDE_CODE, defaultWindowHours, 1),
      sessionLimit: parseEnvInt(env.AGENTMONITOR_SESSION_TOKEN_LIMIT_CLAUDE_CODE, 44000, 0),
      extendedWindowHours: parseEnvInt(env.AGENTMONITOR_EXTENDED_WINDOW_HOURS_CLAUDE_CODE, 24, 1),
      extendedLimit: parseEnvInt(env.AGENTMONITOR_EXTENDED_TOKEN_LIMIT_CLAUDE_CODE, 0, 0),
    },
    codex: {
      limitType: 'cost',
      sessionWindowHours: parseEnvInt(env.AGENTMONITOR_SESSION_WINDOW_HOURS_CODEX, defaultWindowHours, 1),
      sessionLimit: parseEnvFloat(env.AGENTMONITOR_SESSION_COST_LIMIT_CODEX, 100, 0),
      extendedWindowHours: parseEnvInt(env.AGENTMONITOR_EXTENDED_WINDOW_HOURS_CODEX, 168, 1),
      extendedLimit: parseEnvFloat(env.AGENTMONITOR_EXTENDED_COST_LIMIT_CODEX, 1500, 0),
    },
    _default: {
      limitType: 'tokens',
      sessionWindowHours: defaultWindowHours,
      sessionLimit: 0,
      extendedWindowHours: 24,
      extendedLimit: 0,
    },
  };

  return agents;
}

export function createConfig(env: EnvMap = process.env, cwd: string = process.cwd()) {
  return {
    port: parseEnvInt(env.AGENTMONITOR_PORT, 3141, 1),
    host: env.AGENTMONITOR_HOST || '127.0.0.1',
    dbPath: env.AGENTMONITOR_DB_PATH || './data/agentmonitor.db',
    maxPayloadKB: parseEnvInt(env.AGENTMONITOR_MAX_PAYLOAD_KB, 10, 0),
    sessionTimeoutMinutes: parseEnvInt(env.AGENTMONITOR_SESSION_TIMEOUT, 5, 1),
    maxFeed: parseEnvInt(env.AGENTMONITOR_MAX_FEED, 200, 1),
    statsIntervalMs: parseEnvInt(env.AGENTMONITOR_STATS_INTERVAL, 5000, 250),
    maxSseClients: parseEnvInt(env.AGENTMONITOR_MAX_SSE_CLIENTS, 50, 1),
    sseHeartbeatMs: parseEnvInt(env.AGENTMONITOR_SSE_HEARTBEAT_MS, 30000, 1000),
    autoImportIntervalMinutes: parseEnvInt(env.AGENTMONITOR_AUTO_IMPORT_MINUTES, 10, 0),
    projectsDir: resolveProjectsDir(env, cwd),
    // Usage monitor: per-agent-type limits (tokens or cost depending on agent)
    // Claude Code: token limits (AGENTMONITOR_SESSION_TOKEN_LIMIT_CLAUDE_CODE)
    // Codex: cost limits in USD (AGENTMONITOR_SESSION_COST_LIMIT_CODEX)
    usageMonitor: parseUsageMonitorConfig(env),
  };
}

export const config = createConfig();
