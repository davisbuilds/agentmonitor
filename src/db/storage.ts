import fs from 'node:fs';
import type Database from 'better-sqlite3';

// The search index's shadow tables. messages_fts_data holds the index
// segments, which is where deleted rows leave their dead entries behind.
const SEARCH_INDEX_TABLES = ['messages_fts_data', 'messages_fts_idx', 'messages_fts_docsize', 'messages_fts_config'];

export interface StorageReport {
  database_bytes: number;
  wal_bytes: number;
  page_size: number;
  /** Pages inside the file that hold nothing; only a compaction returns them. */
  free_pages: number;
  free_bytes: number;
  search_index_bytes: number;
  wal_size_limit_bytes: number;
}

function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export function searchIndexBytes(db: Database.Database): number {
  // Per-name lookups: dbstat seeks one b-tree per `name =` constraint but
  // walks every table in the file for anything looser.
  const stat = db.prepare('SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = ?');
  return SEARCH_INDEX_TABLES.reduce((sum, name) => sum + (stat.get(name) as { bytes: number }).bytes, 0);
}

export function readStorageReport(db: Database.Database): StorageReport {
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const freePages = db.pragma('freelist_count', { simple: true }) as number;
  return {
    database_bytes: fileBytes(db.name),
    wal_bytes: fileBytes(`${db.name}-wal`),
    page_size: pageSize,
    free_pages: freePages,
    free_bytes: freePages * pageSize,
    search_index_bytes: searchIndexBytes(db),
    wal_size_limit_bytes: db.pragma('journal_size_limit', { simple: true }) as number,
  };
}

/**
 * Leaf pages one merge step may write. On a store whose search index had grown
 * to 1.4 GB (93% dead), a full cleanup in 100-page steps took 226 steps and
 * 15 s, the slowest step 0.27 s, and ended at the size of a rebuilt index;
 * 500-page steps took up to 0.9 s each.
 */
export const SEARCH_MERGE_STEP_PAGES = 100;
// That cleanup took 226 steps; this bound only stops a loop that never ends.
const SEARCH_MERGE_MAX_STEPS = 10_000;

/** Run one bounded merge of the search index. Returns whether it found work. */
export function mergeSearchIndexStep(db: Database.Database, pages = SEARCH_MERGE_STEP_PAGES): boolean {
  if (!Number.isSafeInteger(pages) || pages < 1) throw new RangeError(`merge step pages must be a positive integer: ${pages}`);
  // A negative page count merges even when no level has `automerge` segments
  // waiting, which is what carries dead entries down into the oldest segment.
  // FTS5 reports no result; it changes fewer than two rows once nothing is left
  // to merge. The value is inlined because FTS5 rejects a bound one.
  const before = db.prepare('SELECT total_changes() AS n').get() as { n: number };
  db.exec(`INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', -${pages})`);
  const after = db.prepare('SELECT total_changes() AS n').get() as { n: number };
  return after.n - before.n >= 2;
}

export interface SearchIndexMergeOptions {
  pages?: number;
  /** Awaited between steps so the caller's other work can run. */
  pause?: () => Promise<void>;
  /** Checked before each step; a true result ends the merge early. */
  shouldStop?: () => boolean;
  /** Upper bound on steps, so a merge that never reports done still ends. */
  maxSteps?: number;
}

export interface SearchIndexMergeResult {
  steps: number;
  completed: boolean;
}

export async function mergeSearchIndex(
  db: Database.Database,
  options: SearchIndexMergeOptions = {},
): Promise<SearchIndexMergeResult> {
  const maxSteps = options.maxSteps ?? SEARCH_MERGE_MAX_STEPS;
  let steps = 0;
  for (;;) {
    if (steps >= maxSteps || options.shouldStop?.()) return { steps, completed: false };
    steps++;
    if (!mergeSearchIndexStep(db, options.pages)) return { steps, completed: true };
    await options.pause?.();
  }
}

export interface SearchIndexMaintenanceOptions {
  db: () => Database.Database;
  initialDelayMs: number;
  intervalMs: number;
  /** Time between merge steps, so requests and file events are served meanwhile. */
  pauseMs?: number;
  pages?: number;
  log?: (message: string) => void;
}

export interface SearchIndexMaintenance {
  /** Cancel future runs and end the one in progress after its current step. */
  stop(): Promise<void>;
}

/**
 * Keep the search index compact from inside the server. A run on a clean index
 * is a single step that finds nothing; after the cleanup above, the server's
 * other work waited at most one 0.27 s step at a time.
 */
export function startSearchIndexMaintenance(options: SearchIndexMaintenanceOptions): SearchIndexMaintenance {
  const log = options.log ?? (message => console.log(message));
  const pauseMs = options.pauseMs ?? 50;
  let stopped = false;
  let running: Promise<void> | undefined;

  function run(): void {
    if (running) return;
    running = (async () => {
      try {
        const result = await mergeSearchIndex(options.db(), {
          pages: options.pages,
          pause: () => new Promise(resolve => setTimeout(resolve, pauseMs)),
          shouldStop: () => stopped,
        });
        if (result.steps > 1) log(`[storage] merged the search index in ${result.steps} steps`);
      } catch (error) {
        log(`[storage] search index merge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })().finally(() => {
      running = undefined;
    });
  }

  const delay = setTimeout(run, options.initialDelayMs);
  const interval = setInterval(run, options.intervalMs);
  delay.unref();
  interval.unref();

  return {
    async stop() {
      stopped = true;
      clearTimeout(delay);
      clearInterval(interval);
      await running;
    },
  };
}
