import { installRuntimeSignalHandlers, startAgentMonitorRuntime } from '../../src/runtime.js';

// The HTTP suites post their own quota snapshots to the test server.
const runtime = startAgentMonitorRuntime({ noQuotaPolling: true });
installRuntimeSignalHandlers(runtime);
await runtime;
