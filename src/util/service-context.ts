/** The launchd label `amon service install` registers the server under. */
export const SERVICE_LABEL = 'dev.agentmonitor.serve';

/**
 * Whether this process is the server launchd runs for `amon service`. launchd
 * names the job in XPC_SERVICE_NAME. Such a process has no one to answer a
 * macOS privacy prompt, and launchd restarts it when it exits with an error.
 */
export function runningAsLaunchdService(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.XPC_SERVICE_NAME === SERVICE_LABEL;
}
