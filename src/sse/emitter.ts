import type { Response } from 'express';

interface SSEClient {
  res: Response;
  filters?: {
    agentType?: string;
    eventType?: string;
  };
}

class SSEBroadcaster {
  private clients = new Set<SSEClient>();

  addClient(res: Response, filters?: SSEClient['filters']): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    const client: SSEClient = { res, filters };
    this.clients.add(client);

    // Heartbeat every 30s to detect dead connections
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30_000);

    res.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(client);
    });
  }

  broadcast(type: string, payload: Record<string, unknown>): void {
    const message = `data: ${JSON.stringify({ type, payload })}\n\n`;
    for (const client of this.clients) {
      if (client.filters?.agentType && payload.agent_type !== client.filters.agentType) continue;
      if (client.filters?.eventType && payload.event_type !== client.filters.eventType) continue;
      client.res.write(message);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

export const broadcaster = new SSEBroadcaster();
