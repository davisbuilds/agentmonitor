use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::broadcast;

/// SSE hub using tokio::broadcast for fan-out delivery.
/// Tracks client count for health reporting and max-client enforcement.
pub struct SseHub {
    tx: broadcast::Sender<String>,
    client_count: Arc<AtomicUsize>,
    max_clients: usize,
}

impl SseHub {
    pub fn new(max_clients: usize) -> Self {
        // Channel capacity — if a consumer lags behind this many messages, it gets dropped.
        let (tx, _) = broadcast::channel(256);
        Self {
            tx,
            client_count: Arc::new(AtomicUsize::new(0)),
            max_clients,
        }
    }

    /// Try to subscribe a new client. Returns None if max clients reached.
    pub fn subscribe(&self) -> Option<SseClient> {
        let current = self.client_count.load(Ordering::Relaxed);
        if current >= self.max_clients {
            return None;
        }
        self.client_count.fetch_add(1, Ordering::Relaxed);
        let rx = self.tx.subscribe();
        Some(SseClient {
            rx,
            count: Arc::clone(&self.client_count),
        })
    }

    /// Broadcast a typed message to all connected clients.
    pub fn broadcast(&self, event_type: &str, payload: &Value) {
        let msg = serde_json::json!({ "type": event_type, "payload": payload });
        let formatted = format!("data: {}\n\n", msg);
        // Ignore send errors — means no active receivers.
        let _ = self.tx.send(formatted);
    }

    /// Current number of connected SSE clients.
    pub fn client_count(&self) -> usize {
        self.client_count.load(Ordering::Relaxed)
    }
}

/// A client subscription. Call `into_parts()` to get the receiver and drop guard separately.
pub struct SseClient {
    rx: broadcast::Receiver<String>,
    count: Arc<AtomicUsize>,
}

impl SseClient {
    /// Split into the broadcast receiver and a drop guard that decrements the count.
    pub fn into_parts(self) -> (broadcast::Receiver<String>, SseDropGuard) {
        let guard = SseDropGuard { count: Arc::clone(&self.count) };
        // Use ManuallyDrop to avoid running Drop on self (which would double-decrement).
        let this = std::mem::ManuallyDrop::new(self);
        // Safety: we're reading rx out of a ManuallyDrop wrapper, so Drop won't run.
        let rx = unsafe { std::ptr::read(&this.rx) };
        (rx, guard)
    }
}

impl Drop for SseClient {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Guard that decrements client count when dropped.
pub struct SseDropGuard {
    count: Arc<AtomicUsize>,
}

impl Drop for SseDropGuard {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::Relaxed);
    }
}
