// Session titles: which user text names a session.
//
// Harnesses put machine-written context in user-role messages ahead of the
// user's own prompt: Codex sends AGENTS.md and an <environment_context> block,
// Claude Code sends local-command wrappers and task notifications. A title
// taken from the first user message names the injected context instead.

const TITLE_MAX_CHARS = 200;
const OPENING_TAG_RE = /^<([A-Za-z][\w-]*)(?:\s[^>]*)?>/;
const IMAGE_TAG_RE = /^<\/?image\b[^>]*>$/;

/**
 * True when the text is nothing but complete markup elements, such as
 * `<environment_context>…</environment_context>` or a run of Claude Code's
 * `<command-name>` / `<command-message>` / `<command-args>` wrappers.
 */
function isOnlyWrapperElements(text: string): boolean {
  let rest = text;
  while (rest) {
    const open = OPENING_TAG_RE.exec(rest);
    if (!open) return false;
    const close = `</${open[1]}>`;
    const end = rest.indexOf(close, open[0].length);
    if (end < 0) return false;
    rest = rest.slice(end + close.length).trimStart();
  }
  return true;
}

export function isInjectedContextText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('# AGENTS.md instructions')) return true;
  if (IMAGE_TAG_RE.test(trimmed)) return true;
  return isOnlyWrapperElements(trimmed);
}

function cleanTitleText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
}

/** The first text block that is the user's own words, cleaned for display. */
export function promptTitleFromTexts(texts: readonly string[]): string | null {
  for (const text of texts) {
    if (isInjectedContextText(text)) continue;
    const cleaned = cleanTitleText(text);
    if (cleaned) return cleaned.slice(0, TITLE_MAX_CHARS);
  }
  return null;
}

// Prompts the Codex app sends on its own: naming a thread, summarizing it for a
// returning user, and consolidating memories. They run as threads of their own
// and leave no rollout file, so their prompt is the only thing that marks them.
const CODEX_APP_JOB_PREFIXES = [
  'Generate a concise, single-line task title',
  'You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title',
  'Write a brief catch-up for a user returning to this',
  'Consolidate the supplied rollout summaries into `memory_summary.md`',
];

export function isCodexAppJobPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return CODEX_APP_JOB_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

/**
 * A Codex subagent's task name, from its `agent_path` (`/root/<task_name>`).
 * Codex encrypts the task itself, so the name its parent gave it is the most
 * descriptive text the rollout keeps.
 */
export function codexSubagentTitle(agentPath: unknown): string | null {
  if (typeof agentPath !== 'string') return null;
  const segments = agentPath.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return segments[segments.length - 1].replace(/_+/g, ' ').trim() || null;
}
