import { installRuntimeSignalHandlers, startAgentMonitorRuntime } from '../../src/runtime.js';

// WHY: Polling real quotas could overwrite the snapshot the HTTP tests just posted.
const runtime = startAgentMonitorRuntime({ noQuotaPolling: true });
installRuntimeSignalHandlers(runtime);
await runtime;
