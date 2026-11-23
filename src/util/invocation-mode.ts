
export type InvocationMode = 'interactive' | 'headless';

export function claudeInvocationMode(
  entrypoint: string | undefined,
  promptSource: string | undefined,
): InvocationMode | undefined {
  if (entrypoint === 'claude-desktop') return 'interactive';
  if (entrypoint === 'sdk-cli' || promptSource === 'sdk') return 'headless';
  if (entrypoint === 'cli') return 'interactive';
  return undefined;
}

export function codexInvocationMode(originator: string | undefined): InvocationMode | undefined {
  if (originator === 'codex_exec') return 'headless';
  if (originator === 'codex-tui' || originator === 'codex_cli_rs' || originator === 'Codex Desktop') {
    return 'interactive';
  }
  return undefined;
}
