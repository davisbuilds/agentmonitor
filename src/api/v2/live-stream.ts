import { Router, type Request, type Response } from 'express';

interface LiveSSEClient {
  res: Response;
  sessionId?: string;
  cleanup: () => void;
}

interface LiveSSEEvent {
  id: number;
  type: string;
  payload?: Record<string, unknown>;
  timestamp: string;
}

class LiveSSEBroadcaster {
  private clients = new Set<LiveSSEClient>();
  private history: LiveSSEEvent[] = [];
  private nextEventId = 1;
  private readonly historyLimit = 500;

  addClient(res: Response, options: { sessionId?: string; sinceId?: number } = {}): void {
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

    const replayed = this.replay(client, options.sinceId);
    const connected: LiveSSEEvent = {
      id: this.nextEventId++,
      type: 'connected',
      payload: {
        replayed,
        latest_event_id: this.history[this.history.length - 1]?.id ?? null,
      },
      timestamp: new Date().toISOString(),
    };
    this.safeWrite(client, connected);
  }

  broadcast(type: string, payload: Record<string, unknown>): void {
    const event: LiveSSEEvent = {
      id: this.nextEventId++,
      type,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.history.push(event);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }

    for (const client of Array.from(this.clients)) {
      if (client.sessionId && payload.session_id !== client.sessionId) continue;
      this.safeWrite(client, event);
    }
  }

  resetForTests(): void {
    this.history = [];
    this.nextEventId = 1;
    for (const client of Array.from(this.clients)) {
      this.removeClient(client);
    }
  }

  private replay(client: LiveSSEClient, sinceId?: number): number {
    if (sinceId == null) return 0;

    let replayed = 0;
    for (const event of this.history) {
      if (event.id <= sinceId) continue;
      if (client.sessionId && event.payload?.session_id !== client.sessionId) continue;
      this.safeWrite(client, event);
      replayed += 1;
    }
    return replayed;
  }

  private safeWrite(client: LiveSSEClient, event: LiveSSEEvent): void {
    if (!this.clients.has(client) || client.res.writableEnded || client.res.destroyed) return;
    try {
      client.res.write(`id: ${event.id}\n`);
      client.res.write(`data: ${JSON.stringify(event)}\n\n`);
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
  const sinceRaw = (req.query.since as string | undefined) ?? req.get('last-event-id') ?? undefined;
  const sinceParsed = sinceRaw ? Number.parseInt(sinceRaw, 10) : undefined;
  liveBroadcaster.addClient(res, {
    sessionId: req.query.session_id as string | undefined,
    sinceId: Number.isFinite(sinceParsed) ? sinceParsed : undefined,
  });
});
