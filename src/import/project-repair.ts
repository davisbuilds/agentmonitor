import fs from 'node:fs';
import path from 'node:path';

import type { Database } from 'better-sqlite3';

import { maintainSessionTraceSummary } from '../trace-quality/summary.js';
import { projectNameFromCwd } from '../util/project-identity.js';
import { discoverClaudeCodeLogs } from './claude-code.js';
import { discoverCodexLogs } from './codex.js';

export interface ProjectRepairOptions {
  claudeDir?: string;
  codexDir?: string;
  apply: boolean;
  excludePatterns?: string[];
}

export type ProjectRepairReport = {
  apply: boolean;
  transcripts_scanned: number;
  sessions_changed: number;
  rows: { events: number; sessions: number; browsing_sessions: number };
  renames: Array<{ from: string | null; to: string; sessions: number }>;
};

/** What one transcript says about the projects its stored rows should carry. */
interface TranscriptProjects {
  /** Ids its events and Monitor session rows are stored under. */
  eventSessionIds: string[];
  /** Ids its session-browser rows are stored under. */
  browserIds: string[];
  /** Each cwd's old name (its basename, as import and hooks stored it) to its canonical name. */
  renames: Map<string, string>;
  /** The name the session browser now derives, or null to leave the browser row alone. */
  browserProject: string | null;
}

const DRY_RUN_ROLLBACK = Symbol('dry-run rollback');
const CWD_FIELD = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g;
const SESSION_ID_FIELD = /"sessionId"\s*:\s*"([^"\\]+)"/g;

function cwdRenames(cwds: Iterable<string>): Map<string, string> {
  const renames = new Map<string, string>();
  for (const cwd of cwds) {
    const before = path.basename(cwd.trim());
    const after = projectNameFromCwd(cwd);
    if (before && after && before !== after) renames.set(before, after);
  }
  return renames;
}

function readClaudeTranscript(filePath: string): TranscriptProjects | null {
  const content = fs.readFileSync(filePath, 'utf8');
  const cwds = new Set<string>();
  let firstCwd: string | null = null;
  for (const match of content.matchAll(CWD_FIELD)) {
    let cwd: unknown;
    try {
      cwd = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (typeof cwd !== 'string' || !cwd.trim()) continue;
    firstCwd ??= cwd;
    cwds.add(cwd);
  }
  if (!firstCwd) return null;
  const fileId = path.basename(filePath, '.jsonl');
  const eventSessionIds = new Set([fileId, ...[...content.matchAll(SESSION_ID_FIELD)].map(match => match[1])]);
  return {
    eventSessionIds: [...eventSessionIds],
    browserIds: [fileId],
    renames: cwdRenames(cwds),
    browserProject: projectNameFromCwd(firstCwd),
  };
}

function readCodexRollout(filePath: string): TranscriptProjects | null {
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n', 20)) {
    let record: { type?: string; payload?: { id?: unknown; cwd?: unknown } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (record.type !== 'session_meta') continue;
    const cwd = record.payload?.cwd;
    if (typeof cwd !== 'string' || !cwd.trim()) return null;
    const rolloutId = path.basename(filePath, '.jsonl');
    const uuid = typeof record.payload?.id === 'string' ? record.payload.id
      : /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(rolloutId)?.[1] ?? rolloutId;
    return {
      eventSessionIds: [uuid],
      browserIds: [...new Set([rolloutId, uuid])],
      renames: cwdRenames([cwd]),
      browserProject: projectNameFromCwd(cwd),
    };
  }
  return null;
}

/**
 * Rename stored projects to the canonical identity (see
 * `src/util/project-identity.ts`), re-deriving each session from its
 * transcript. Event and Monitor session rows change only where they still carry
 * the old cwd basename, so rows named some other way are left alone. Browser
 * rows take the name the session parser now derives. A preview runs the same
 * writes and rolls them back, so its counts are what applying would change.
 */
export function repairProjectNames(db: Database, options: ProjectRepairOptions): ProjectRepairReport {
  const transcripts: TranscriptProjects[] = [];
  let scanned = 0;
  const sources: Array<[string[], (file: string) => TranscriptProjects | null]> = [
    [discoverClaudeCodeLogs(options.claudeDir, { excludePatterns: options.excludePatterns }), readClaudeTranscript],
    [discoverCodexLogs(options.codexDir, { excludePatterns: options.excludePatterns }), readCodexRollout],
  ];
  for (const [files, read] of sources) {
    for (const file of files) {
      scanned += 1;
      const projects = read(file);
      if (projects) transcripts.push(projects);
    }
  }

  const rows = { events: 0, sessions: 0, browsing_sessions: 0 };
  const renameCounts = new Map<string, { from: string | null; to: string; sessions: number }>();
  let sessionsChanged = 0;

  const renameEvents = db.prepare('UPDATE events SET project = ? WHERE session_id = ? AND project = ?');
  const renameSession = db.prepare('UPDATE sessions SET project = ? WHERE id = ? AND project = ?');
  const readBrowser = db.prepare('SELECT project FROM browsing_sessions WHERE id = ?');
  const renameBrowser = db.prepare('UPDATE browsing_sessions SET project = ? WHERE id = ?');
  const hasSummary = db.prepare('SELECT 1 FROM session_trace_summary WHERE session_id = ?');

  try {
    db.transaction(() => {
      for (const transcript of transcripts) {
        const renamed = new Map<string, { from: string | null; to: string }>();
        const touched = new Set<string>();
        for (const [from, to] of transcript.renames) {
          for (const id of transcript.eventSessionIds) {
            const events = renameEvents.run(to, id, from).changes;
            const sessions = renameSession.run(to, id, from).changes;
            rows.events += events;
            rows.sessions += sessions;
            if (events + sessions === 0) continue;
            touched.add(id);
            renamed.set(JSON.stringify([from, to]), { from, to });
          }
        }
        if (transcript.browserProject) {
          for (const id of transcript.browserIds) {
            const current = readBrowser.get(id) as { project: string | null } | undefined;
            if (!current || current.project === transcript.browserProject) continue;
            rows.browsing_sessions += renameBrowser.run(transcript.browserProject, id).changes;
            touched.add(id);
            renamed.set(JSON.stringify([current.project, transcript.browserProject]), {
              from: current.project,
              to: transcript.browserProject,
            });
          }
        }
        if (touched.size === 0) continue;
        sessionsChanged += 1;
        for (const [key, rename] of renamed) {
          const entry = renameCounts.get(key) ?? { ...rename, sessions: 0 };
          entry.sessions += 1;
          renameCounts.set(key, entry);
        }
        for (const id of new Set([...transcript.eventSessionIds, ...transcript.browserIds])) {
          if (hasSummary.get(id)) maintainSessionTraceSummary(id);
        }
      }
      if (!options.apply) throw DRY_RUN_ROLLBACK;
    })();
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }

  return {
    apply: options.apply,
    transcripts_scanned: scanned,
    sessions_changed: sessionsChanged,
    rows,
    renames: [...renameCounts.values()].sort((a, b) => b.sessions - a.sessions || a.to.localeCompare(b.to)),
  };
}
