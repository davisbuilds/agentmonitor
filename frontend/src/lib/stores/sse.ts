import { setStats, incrementEvent, addEvent, handleSessionUpdate, handleEventForSession, setConnectionStatus, setQuotaMonitor } from './monitor.svelte';
import type { AgentEvent, Stats } from '../api/client';

let source: EventSource | null = null;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function connectSSE(): void {
  if (source) source.close();

  setConnectionStatus('connecting');
  source = new EventSource('/api/stream');

  source.onopen = () => {
    reconnectDelay = 1000;
    setConnectionStatus('connected');
  };

  source.onmessage = (e) => {
    let msg: { type: string; payload: unknown };
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    try {
      dispatch(msg);
    } catch (err) {
      console.error('[SSE] Dispatch error:', err);
    }
  };

  source.onerror = () => {
    source?.close();
    setConnectionStatus('disconnected');
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    connectSSE();
  }, reconnectDelay);
}

function dispatch(msg: { type: string; payload: unknown }): void {
  switch (msg.type) {
    case 'event': {
      const event = msg.payload as AgentEvent;
      addEvent(event);
      handleEventForSession(event);
      incrementEvent(event);
      break;
    }
    case 'stats': {
      const statsPayload = msg.payload as Stats & { quota_monitor?: unknown[]; usage_monitor?: unknown[] };
      setStats(statsPayload);
      if (statsPayload.quota_monitor || statsPayload.usage_monitor) {
        setQuotaMonitor((statsPayload.quota_monitor || statsPayload.usage_monitor) as ReturnType<typeof import('./monitor.svelte').getQuotaMonitor>);
      }
      break;
    }
    case 'session_update':
      handleSessionUpdate(msg.payload as Record<string, unknown>);
      break;
  }
}

export function disconnectSSE(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (source) source.close();
}
