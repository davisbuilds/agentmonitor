import { handleLiveEvent, setLiveConnectionStatus } from './live.svelte';

let source: EventSource | null = null;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function connectLiveSSE(): void {
  if (source) source.close();

  setLiveConnectionStatus('connecting');
  source = new EventSource('/api/v2/live/stream');

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
  setLiveConnectionStatus('disconnected');
}
