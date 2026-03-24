import { Router, type Request, type Response } from 'express';

interface LiveSSEClient {
  res: Response;
  sessionId?: string;
  cleanup: () => void;
}

class LiveSSEBroadcaster {
  private clients = new Set<LiveSSEClient>();

  addClient(res: Response, options: { sessionId?: string } = {}): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const client: LiveSSEClient = {
      res,
      sessionId: options.sessionId,
      cleanup: () => this.removeClient(client),
    };

    this.clients.add(client);
    res.on('close', client.cleanup);
    res.on('error', client.cleanup);
    this.safeWrite(client, {
      type: 'connected',
      timestamp: new Date().toISOString(),
    });
  }

  broadcast(type: string, payload: Record<string, unknown>): void {
    for (const client of Array.from(this.clients)) {
      if (client.sessionId && payload.session_id !== client.sessionId) continue;
      this.safeWrite(client, { type, payload });
    }
  }

  private safeWrite(client: LiveSSEClient, payload: Record<string, unknown>): void {
    if (!this.clients.has(client) || client.res.writableEnded || client.res.destroyed) return;
    try {
      client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      this.removeClient(client);
    }
  }

  private removeClient(client: LiveSSEClient): void {
    if (!this.clients.delete(client)) return;
    client.res.off('close', client.cleanup);
    client.res.off('error', client.cleanup);
    if (!client.res.writableEnded && !client.res.destroyed) {
      try {
        client.res.end();
      } catch {
        // Ignore teardown errors.
      }
    }
  }
}

export const liveBroadcaster = new LiveSSEBroadcaster();
export const liveStreamRouter = Router();

liveStreamRouter.get('/', (req: Request, res: Response) => {
  liveBroadcaster.addClient(res, {
    sessionId: req.query.session_id as string | undefined,
  });
});

