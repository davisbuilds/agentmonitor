import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { initSchema } from './db/schema.js';
import { updateIdleSessions } from './db/queries.js';
import { apiRouter } from './api/router.js';
import { startStatsBroadcast } from './api/stream.js';
import { broadcaster } from './sse/emitter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

// Initialize database
initSchema();

const app = express();

// Middleware
app.use(express.json({ limit: '1mb' }));

// API routes
app.use('/api', apiRouter);

// Static files
app.use(express.static(publicDir));

// Start server
const server = app.listen(config.port, config.host, () => {
  console.log(`AgentStats listening on http://${config.host}:${config.port}`);
  console.log(`Dashboard: http://localhost:${config.port}`);
});

// Start periodic stats broadcast to SSE clients
startStatsBroadcast();

// Session timeout checker - mark idle sessions every 60s
const sessionChecker = setInterval(() => {
  const idled = updateIdleSessions(config.sessionTimeoutMinutes);
  if (idled > 0 && broadcaster.clientCount > 0) {
    broadcaster.broadcast('session_update', { type: 'idle_check', idled });
  }
}, 60_000);

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down AgentStats...');
  clearInterval(sessionChecker);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
