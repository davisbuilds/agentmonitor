import { handleLiveEvent, setLiveConnectionStatus } from './live.svelte';

let source: EventSource | null = null;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastEventId: string | null = null;

export function connectLiveSSE(): void {
  if (source) source.close();

  setLiveConnectionStatus('connecting');
  const params = new URLSearchParams();
  if (lastEventId) params.set('since', lastEventId);
  const url = params.size > 0 ? `/api/v2/live/stream?${params.toString()}` : '/api/v2/live/stream';
  source = new EventSource(url);

  source.onopen = () => {
    reconnectDelay = 1000;
    setLiveConnectionStatus('connected');
  };

  source.onmessage = (event) => {
    let message: { type: string; payload?: Record<string, unknown> };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (event.lastEventId) {
      lastEventId = event.lastEventId;
    }

    try {
      handleLiveEvent(message);
    } catch (err) {
      console.error('[Live SSE] Dispatch error:', err);
    }
  };

  source.onerror = () => {
    source?.close();
    source = null;
    setLiveConnectionStatus('disconnected');
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    connectLiveSSE();
  }, reconnectDelay);
}

export function disconnectLiveSSE(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  source?.close();
  source = null;
  lastEventId = null;
  setLiveConnectionStatus('disconnected');
}
